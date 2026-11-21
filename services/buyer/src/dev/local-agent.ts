// A development stand in for TinyFish. It does the same jobs against the store's own pages over plain HTTP,
// form by form, so the whole loop can run on one laptop with no credits and no network.
// It is never the demo: runs it makes are marked engine "local" and the Shop screen says so.
// Retailers are not contacted at all: a price check returns a made up price from the store's catalog, plus a markup.
import type { Agent, AgentEvent, AgentParams, Outcome } from '../agent';

const text = (html: string, id: string) => new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1]?.trim() ?? null;
const dollars = (s: string | null) => (s ? Number(s.replace(/[^0-9.]/g, '')) : null);

export class LocalAgent implements Agent {
  readonly engine = 'local' as const;
  private jar = new Map<string, string>();
  private n = 0;

  constructor(private storeUrl: string, private email: string, private password: string, private stepMs = 900, private fetcher: typeof fetch = fetch) {}

  private async http(path: string, form?: Record<string, string>): Promise<{ html: string; path: string; status: number }> {
    let url = `${this.storeUrl}${path}`;
    let init: RequestInit = form ? { method: 'POST', body: new URLSearchParams(form).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } } : { method: 'GET' };
    for (let hops = 0; hops < 6; hops++) {
      const res = await this.fetcher(url, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
      for (const line of res.headers.getSetCookie()) {
        const [k, v] = (line.split(';')[0] ?? '').split('=');
        if (k) this.jar.set(k, v ?? '');
      }
      const next = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && next) {
        url = new URL(next, url).toString();
        init = { method: 'GET' };
        continue;
      }
      return { html: await res.text(), path: new URL(url).pathname, status: res.status };
    }
    throw new Error('Too many redirects.');
  }

  async run(params: AgentParams, onEvent: (e: AgentEvent) => void): Promise<Outcome> {
    const runId = `local-${++this.n}`;
    const step = async (purpose: string) => {
      onEvent({ type: 'progress', purpose });
      await new Promise((r) => setTimeout(r, this.stepMs));
    };
    const done = (result: Record<string, unknown>): Outcome => ({ runId, status: 'COMPLETED', result, error: null });
    onEvent({ type: 'started', runId });
    const task = params.task;
    try {
      if (task.kind === 'market') {
        await step('Opening the search results');
        if (task.supplierId.endsWith('-b')) {
          await step('The site is asking to verify a human');
          return done({ listing_name: null, pack_size: null, price: null, currency: null, in_stock: null, delivery_days: null, product_url: null, note: 'captcha' });
        }
        await step('Reading the first 5 listings');
        const catalog = (await (await this.fetcher(`${this.storeUrl}/catalog.json`)).json()) as { items: { name: string; packs: { price: number }[] }[] };
        const words = task.phrase.toLowerCase().split(/\s+/);
        const best = catalog.items.map((i) => ({ i, score: words.filter((w) => i.name.toLowerCase().includes(w)).length })).sort((a, b) => b.score - a.score)[0]?.i;
        await step('Returning the lowest price');
        const price = Math.round((best?.packs[0]?.price ?? 9.99) * 1.16 * 100) / 100;
        return done({ listing_name: best?.name ?? task.phrase, pack_size: 1, price, currency: 'CAD', in_stock: true, delivery_days: 3, product_url: null });
      }
      if (task.kind === 'cart') {
        await step('Emptying the cart');
        await this.http('/cart/empty', {});
        await step(`Searching for ${task.sku ?? task.phrase}`);
        const found = await this.http(`/search?q=${encodeURIComponent(task.sku ?? task.phrase)}`);
        const sku = task.sku ?? /href="\/p\/([^"]+)"/.exec(found.html)?.[1];
        if (!sku) return done({ cart_ok: false, reason: 'No item matched the search.', pack_label: null, pack_size: null, packs: null, unit_price: null, total: null, delivery_days: null, delivery_date: null });
        await step('Opening the product page');
        const product = await this.http(`/p/${encodeURIComponent(sku)}`);
        if (!product.html.includes('Add to cart')) return done({ cart_ok: false, reason: 'The item is out of stock.', pack_label: null, pack_size: null, packs: null, unit_price: null, total: null, delivery_days: null, delivery_date: null });
        const pack = task.packIndex ?? 0;
        const packs = task.units;
        await step(`Setting quantity to ${packs}`);
        await this.http('/cart', { sku, pack: String(pack), qty: String(packs) });
        await step('Opening checkout');
        let review = await this.http('/checkout');
        if (review.path === '/signin') {
          await step('Signing in to the shop account');
          review = await this.http('/signin', { email: this.email, password: this.password, next: '/checkout' });
        }
        if (!review.html.includes('Review your order')) return done({ cart_ok: false, reason: 'The store asked for a sign in.', pack_label: null, pack_size: null, packs: null, unit_price: null, total: null, delivery_days: null, delivery_date: null });
        await step('Reading the totals');
        const price = dollars(/<td class="num">(\$[0-9.]+)<\/td><td class="num">\d+<\/td>/.exec(review.html)?.[1] ?? null);
        return done({ cart_ok: true, reason: null, pack_label: null, pack_size: null, packs, unit_price: price, total: dollars(text(review.html, 'total')), delivery_days: null, delivery_date: text(review.html, 'delivery') });
      }
      if (task.kind === 'place') {
        await step('Opening checkout');
        let review = await this.http('/checkout');
        if (review.path === '/signin') review = await this.http('/signin', { email: this.email, password: this.password, next: '/checkout' });
        if (!review.html.includes('Review your order') && task.sku) {
          await step('The cart was empty. Filling it again');
          await this.http('/cart', { sku: task.sku, pack: String(task.packIndex ?? 0), qty: String(task.units) });
          review = await this.http('/checkout');
        }
        if (!review.html.includes('Review your order')) return done({ confirmation: null, delivery_date: null, reason: 'The cart was empty.' });
        await step(`Entering PO number ${task.poNumber}`);
        await step('Pressing Place order');
        const placed = await this.http('/checkout', { po: task.poNumber });
        await step('Reading the confirmation number');
        return done({ confirmation: text(placed.html, 'confirmation'), delivery_date: text(placed.html, 'delivery'), reason: text(placed.html, 'checkout-error') });
      }
      const order = await this.http(`/orders/${encodeURIComponent(task.confirmation)}`);
      return done({ status: text(order.html, 'status'), delivery_date: text(order.html, 'delivery') });
    } catch (err) {
      return { runId, status: 'FAILED', result: null, error: `The store could not be reached: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
