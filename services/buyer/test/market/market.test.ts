import { IngestQuotesBody, type Job } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import { Buyer } from '../../src/jobs';
import { marketCheck, marketGoal, marketParams, toQuote } from '../../src/market';
import { completed, config, deps, fakeAgent, marketJob, offcut, retailerA, retailerB } from '../helpers';

const good = { listing_name: 'Wood Screws #8 (100 Pack)', pack_size: 1, price: 8.69, currency: 'CAD', in_stock: true, delivery_days: 3, product_url: 'https://a.test/p/1' };
const suppliers = { 's-market-a': retailerA, 's-market-b': retailerB, 's-offcut': offcut } as const;

function buyer(agent: ReturnType<typeof fakeAgent>) {
  const posts: { path: string; body: unknown }[] = [];
  const link = { post: async (path: string, body: unknown) => (posts.push({ path, body }), true), supplier: async (id: string) => suppliers[id as keyof typeof suppliers] ?? null, snapshot: async () => null };
  return { buyer: new Buyer(config(), link, deps(agent).d, (async () => new Response('{}')) as unknown as typeof fetch, () => {}), posts };
}

describe('the market check', () => {
  it('tells the agent the stop rules', () => {
    const goal = marketGoal('#8 x 1-1/4 wood screws box of 100');
    for (const rule of ['close it', 'first 5 listings', 'sponsored', 'bundles', 'lowest price before tax and shipping', 'never add anything to a cart', 'Never sign in', 'captcha', 'stop']) expect(goal).toContain(rule);
  });

  it('starts on the search results, in stealth, through a proxy in the supplier country, for at most 180 seconds', () => {
    const p = marketParams(retailerB, marketJob);
    expect(p).toMatchObject({ url: 'https://b.test/s?k=%238%20x%201-1%2F4%20wood%20screws%20box%20of%20100', browserProfile: 'stealth', proxyCountry: 'CA', maxDurationSeconds: 180, profileId: null });
    expect(Object.keys((p.outputSchema as { properties: object }).properties)).toEqual(['listing_name', 'pack_size', 'price', 'currency', 'in_stock', 'delivery_days', 'product_url']);
  });

  it('accepts a real price and refuses a null price or a challenge page', () => {
    expect(marketCheck(good)).toBeNull();
    expect(marketCheck({ ...good, price: null })).toBe('No price on the page.');
    expect(marketCheck({ ...good, price: null, listing_name: 'Please complete the CAPTCHA to continue' })).toBe('The site showed a challenge page.');
    expect(marketCheck(null)).toBe('The site gave no answer.');
  });

  it('maps a result to a Quote, with the unit price as the price divided by the pack size', () => {
    const q = toQuote('q-1', marketJob, retailerA, 'r-1', true, { ...good, price: 64.9, pack_size: 10 }, '2026-11-21T09:14:40-05:00');
    expect(q).toMatchObject({ productId: 'p-screws', supplierId: 's-market-a', packSize: 10, price: 64.9, unitPrice: 6.49, ok: true, runId: 'r-1', currency: 'CAD' });
    expect(toQuote('q-2', marketJob, retailerB, 'r-2', false, null, '2026-11-21T09:14:40-05:00')).toMatchObject({ ok: false, price: null, unitPrice: null });
  });

  it('checks live prices one at a time, across jobs, so a browser stays free for the cart', async () => {
    const order: string[] = [];
    let open = 0;
    let most = 0;
    const agent = fakeAgent(async (p) => {
      open += 1;
      most = Math.max(most, open);
      order.push(`start ${new URL(p.url).host}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end ${new URL(p.url).host}`);
      open -= 1;
      return completed(good);
    });
    const { buyer: b } = buyer(agent);
    await Promise.all([b.handle(marketJob), b.handle({ ...marketJob, id: 'j-9', productId: 'p-glue' })]);
    expect(agent.calls).toHaveLength(4);
    expect(most).toBe(1);
    expect(order.slice(0, 4)).toEqual(['start a.test', 'end a.test', 'start b.test', 'end b.test']);
  });

  it('skips a live price check when nothing is being bought for that part any more', async () => {
    const agent = fakeAgent(() => completed(good));
    const posts: { path: string; body: unknown }[] = [];
    const logs: string[] = [];
    const orders = [{ productId: 'p-screws', state: 'cancelled' }];
    const link = { post: async (path: string, body: unknown) => (posts.push({ path, body }), true), supplier: async (id: string) => suppliers[id as keyof typeof suppliers] ?? null, snapshot: async () => ({ orders }) as never };
    const b = new Buyer(config(), link, deps(agent).d, (async () => new Response('{}')) as unknown as typeof fetch, (l) => logs.push(l));
    await b.handle(marketJob);
    expect(agent.calls).toHaveLength(0);
    expect(logs.join('\n')).toContain('skipped Retailer A. Nothing is being bought for that part any more.');
    // The job is still closed on the hub, with no quotes.
    expect(IngestQuotesBody.parse(posts.at(-1)?.body)).toMatchObject({ jobId: 'j-1', quotes: [] });
    orders[0] = { productId: 'p-screws', state: 'awaiting_approval' };
    await b.handle({ ...marketJob, id: 'j-8' });
    expect(agent.calls).toHaveLength(2);
  });

  it('one retailer failing or throwing does not stop the others', async () => {
    const agent = fakeAgent(async (p) => {
      if (p.url.startsWith('https://b.test')) throw new Error('boom');
      return completed(good);
    });
    const { buyer: b, posts } = buyer(agent);
    await b.handle(marketJob);
    expect(agent.calls).toHaveLength(2);
    expect(posts).toHaveLength(1);
    const body = IngestQuotesBody.parse(posts[0]?.body);
    expect(body).toMatchObject({ jobId: 'j-1', quotes: [{ supplierId: 's-market-a', ok: true, unitPrice: 8.69 }] });
  });

  it('reads a retailer from suppliers.json when the hub cannot say who it is', async () => {
    const posts: { path: string; body: unknown }[] = [];
    const link = { post: async (path: string, body: unknown) => (posts.push({ path, body }), true), supplier: async () => null, snapshot: async () => null };
    const agent = fakeAgent(() => completed(good));
    await new Buyer(config(), link, deps(agent).d, (async () => new Response('{}')) as unknown as typeof fetch, () => {}, [retailerA]).handle({ ...marketJob, supplierIds: ['s-market-a'] });
    expect(agent.calls[0]?.url.startsWith('https://a.test/search?q=')).toBe(true);
    expect(IngestQuotesBody.parse(posts[0]?.body).quotes[0]).toMatchObject({ supplierId: 's-market-a', ok: true });
  });

  it('posts a failed quote for a blocked site so the screen can say so, and closes the job when nothing came back', async () => {
    const blocked = buyer(fakeAgent(() => completed({ ...good, price: null })));
    await blocked.buyer.handle({ ...marketJob, supplierIds: ['s-market-b'] });
    expect(IngestQuotesBody.parse(blocked.posts[0]?.body).quotes[0]).toMatchObject({ supplierId: 's-market-b', ok: false });

    const none = buyer(fakeAgent(() => completed(good)));
    await none.buyer.handle({ ...marketJob, supplierIds: ['s-offcut', 's-unknown'] } as Job);
    expect(none.posts).toEqual([{ path: '/ingest/quotes', body: { jobId: 'j-1', quotes: [] } }]);
  });
});
