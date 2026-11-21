// The job loop: each job from the hub becomes one or more agent runs, and one result posted back.
import { Catalog, type CatalogItem, type Job, type Supplier } from '@reup/contracts';
import { cartSpec, planCart, toCartBody, type CartJob, type SignIn } from './cart';
import type { Config } from './config';
import type { HubLink } from './hub';
import { marketSpec, toQuote } from './market';
import { placeSpec, toPlacedBody, trackParams, type Basket, type PlaceJob, type TrackJob } from './place';
import { runAgent, type Deps } from './runner';

export const PRICE_CHECK_ONLY = 'This supplier is for price checks only. reup never orders from it.';

export class Buyer {
  private baskets = new Map<string, Basket>();
  private catalogs = new Map<string, { at: number; items: CatalogItem[] }>();

  constructor(private config: Config, private link: Pick<HubLink, 'post' | 'supplier' | 'snapshot'>, private deps: Deps, private fetcher: typeof fetch = fetch, private log: (line: string) => void = console.log, private listed: Supplier[] = []) {}

  /** The hub's copy of a supplier, so the screens and the buyer agree. The buyer's own suppliers.json answers when the hub cannot. */
  private async supplier(id: string): Promise<Supplier | null> {
    return (await this.link.supplier(id)) ?? this.listed.find((s) => s.id === id) ?? null;
  }

  private signIn(): SignIn {
    return { profile: this.config.TINYFISH_PROFILE_ID !== '', email: this.config.OFFCUT_EMAIL, password: this.config.TINYFISH_PROFILE_ID !== '' ? '' : this.config.OFFCUT_PASSWORD };
  }

  /** The store's public catalog, kept for 5 minutes. An unreachable store just means the agent chooses the pack itself. */
  async catalog(supplier: Supplier): Promise<CatalogItem[]> {
    const cached = this.catalogs.get(supplier.id);
    if (cached && this.deps.now().getTime() - cached.at < 5 * 60 * 1000) return cached.items;
    try {
      const res = await this.fetcher(`${supplier.baseUrl.replace(/\/$/, '')}/catalog.json`);
      const items = Catalog.parse(await res.json()).items;
      this.catalogs.set(supplier.id, { at: this.deps.now().getTime(), items });
      return items;
    } catch {
      return cached?.items ?? [];
    }
  }

  async handle(job: Job): Promise<void> {
    this.log(`Job ${job.id}: ${job.kind}`);
    try {
      if (job.kind === 'market') await this.market(job);
      else if (job.kind === 'cart') await this.cart(job);
      else if (job.kind === 'place') await this.place(job);
      else await this.track(job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Job ${job.id} failed: ${message}`);
      if (job.kind === 'cart') await this.link.post('/ingest/cart', toCartBody(job, { item: null, packIndex: null, packLabel: null, packSize: 1, packs: job.units }, false, null, 'The buyer hit an error.'));
      if (job.kind === 'place') await this.link.post('/ingest/placed', toPlacedBody(job, false, null, 'The buyer hit an error.', this.deps.now(), this.config.TIME_ZONE));
      if (job.kind === 'market') await this.link.post('/ingest/quotes', { jobId: job.id, quotes: [] });
    }
  }

  /** One run per retailer, all at once. One site failing never stops the others. */
  private async market(job: Extract<Job, { kind: 'market' }>): Promise<void> {
    let posted = 0;
    await Promise.allSettled(job.supplierIds.map(async (id) => {
      const supplier = await this.supplier(id);
      if (!supplier || supplier.kind !== 'market') return this.log(`Market job ${job.id}: no market supplier ${id}.`);
      const out = await runAgent(this.deps, marketSpec(supplier, job));
      const quote = toQuote(`q-${this.deps.id()}`, job, supplier, out.run.id, out.ok, out.result, this.deps.iso(this.deps.now()));
      if (await this.link.post('/ingest/quotes', { jobId: job.id, quotes: [quote] })) posted += 1;
      this.log(`  ${supplier.name}: ${quote.ok ? `$${quote.unitPrice} a unit` : (out.error ?? 'no price')}${out.replayed ? ' (replay)' : ''}`);
    }));
    if (posted === 0) await this.link.post('/ingest/quotes', { jobId: job.id, quotes: [] });
  }

  private async cart(job: CartJob): Promise<void> {
    const supplier = await this.supplier(job.supplierId);
    const none = { item: null, packIndex: null, packLabel: null, packSize: 1, packs: job.units };
    if (!supplier || supplier.kind !== 'account') {
      this.log(`Refused cart job ${job.id}: ${PRICE_CHECK_ONLY}`);
      await this.link.post('/ingest/cart', toCartBody(job, none, false, null, PRICE_CHECK_ONLY));
      return;
    }
    const plan = planCart(job, await this.catalog(supplier));
    this.baskets.set(job.orderId, { sku: job.sku, phrase: job.searchPhrase, units: job.units, plan });
    const out = await runAgent(this.deps, cartSpec(supplier, job, plan, this.signIn(), this.config.TINYFISH_PROFILE_ID));
    await this.link.post('/ingest/cart', toCartBody(job, plan, out.ok, out.result, out.error));
    this.log(`  ${supplier.name}: ${out.ok ? `cart ready, total $${String(out.result?.total)}` : out.error}${out.replayed ? ' (replay)' : ''}`);
  }

  /** The basket the cart job built, or the same thing worked out again from the hub if the buyer restarted in between. */
  private async basketFor(job: PlaceJob, supplier: Supplier): Promise<Basket | null> {
    const kept = this.baskets.get(job.orderId);
    if (kept) return kept;
    const snapshot = await this.link.snapshot();
    const order = snapshot?.orders.find((o) => o.id === job.orderId);
    const product = snapshot?.products.find((p) => p.id === order?.productId);
    if (!order || !product) return null;
    const asCart: CartJob = { id: job.id, kind: 'cart', orderId: order.id, productId: product.id, supplierId: supplier.id, sku: product.sku, searchPhrase: product.searchPhrase, units: order.units };
    return { sku: product.sku, phrase: product.searchPhrase, units: order.units, plan: planCart(asCart, await this.catalog(supplier)) };
  }

  private async place(job: PlaceJob): Promise<void> {
    const supplier = await this.supplier(job.supplierId);
    if (!supplier || supplier.kind !== 'account') {
      this.log(`Refused place job ${job.id}: ${PRICE_CHECK_ONLY}`);
      await this.link.post('/ingest/placed', toPlacedBody(job, false, null, PRICE_CHECK_ONLY, this.deps.now(), this.config.TIME_ZONE));
      return;
    }
    const basket = await this.basketFor(job, supplier);
    const out = await runAgent(this.deps, placeSpec(supplier, job, basket, this.signIn(), this.config.TINYFISH_PROFILE_ID));
    await this.link.post('/ingest/placed', toPlacedBody(job, out.ok, out.result, out.error, this.deps.now(), this.config.TIME_ZONE));
    this.baskets.delete(job.orderId);
    this.log(`  ${supplier.name}: ${out.ok ? `placed, confirmation ${String(out.result?.confirmation)}` : out.error}${out.replayed ? ' (replay)' : ''}`);
  }

  private async track(job: TrackJob): Promise<void> {
    const supplier = await this.supplier(job.supplierId);
    if (!supplier || supplier.kind !== 'account') return;
    const out = await runAgent(this.deps, { kind: 'track', supplier, productId: null, orderId: job.orderId, params: trackParams(supplier, job, this.signIn(), this.config.TINYFISH_PROFILE_ID), replay: false, fallback: false, check: (r) => (typeof r?.status === 'string' ? null : 'The order page showed no status.') });
    this.log(`  ${supplier.name}: order ${job.confirmation} is ${out.ok ? String(out.result?.status) : 'unknown'}`);
  }
}
