import { IngestCartBody, type CatalogItem } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import catalog from '../../../../contracts/mocks/catalog.json';
import { cartCheck, cartGoal, cartParams, planCart, toCartBody } from '../../src/cart';
import { Buyer, PRICE_CHECK_ONLY } from '../../src/jobs';
import { cartJob, completed, config, deps, fakeAgent, offcut, retailerA } from '../helpers';

const items = catalog.items as CatalogItem[];
const profile = { profile: true, email: 'shop@reup.test', password: '' };
const review = { cart_ok: true, reason: null, pack_label: 'Box of 100', pack_size: 1, packs: 8, unit_price: 7.49, total: 67.71, delivery_days: null, delivery_date: 'Tuesday, Nov 24' };

describe('filling the cart', () => {
  it('plans the pack with the lowest total from the public catalog', () => {
    expect(planCart(cartJob, items)).toMatchObject({ packIndex: 0, packLabel: 'Box of 100', packSize: 1, packs: 8 });
    expect(planCart({ ...cartJob, units: 10 }, items)).toMatchObject({ packIndex: 1, packLabel: 'Case of 10 boxes', packSize: 10, packs: 1 });
    expect(planCart({ ...cartJob, sku: null }, items)).toMatchObject({ item: null, packLabel: null, packs: 8 });
  });

  it('writes the goal as numbered steps for a SKU, and for a phrase when there is no SKU', () => {
    const plan = planCart(cartJob, items);
    const goal = cartGoal(cartJob, plan, profile);
    expect(goal).toContain('3. Search the store for the SKU OC-1008-114 and open that product.');
    expect(goal).toContain('5. Choose the pack size "Box of 100" and set the quantity to 8.');
    expect(goal).toContain('Out of stock');
    const byPhrase = cartGoal({ ...cartJob, sku: null }, planCart({ ...cartJob, sku: null }, items), profile);
    expect(byPhrase).toContain('3. Search the store for "#8 x 1-1/4 wood screws box of 100" and open the product that matches best.');
    expect(byPhrase).toContain('lowest total for 8 units');
  });

  it('forbids placing the order, and always empties the cart first', () => {
    const goal = cartGoal(cartJob, planCart(cartJob, items), profile);
    expect(goal).toContain('Do not place the order.');
    expect(goal).toContain('Do not press "Place order"');
    expect(goal).toContain('2. Open the cart. If it has anything in it, press "Empty cart".');
  });

  it('uses the saved profile with no proxy on the lite browser, and only sends a password when there is no profile', () => {
    const plan = planCart(cartJob, items);
    expect(cartParams(offcut, cartJob, plan, profile, 'prof-1')).toMatchObject({ url: 'https://offcut.test/cart', browserProfile: 'lite', proxyCountry: null, profileId: 'prof-1' });
    expect(cartGoal(cartJob, plan, profile)).not.toContain('password');
    expect(cartGoal(cartJob, plan, { profile: false, email: 'shop@reup.test', password: 'pw-1' })).toContain('use the email shop@reup.test and the password pw-1');
    expect(cartGoal(cartJob, plan, { profile: false, email: 'shop@reup.test', password: '' })).toContain('The store asked for a sign in.');
  });

  it('maps the review page to an IngestCartBody, with the unit price per unit on the board', () => {
    const plan = planCart(cartJob, items);
    expect(IngestCartBody.parse(toCartBody(cartJob, plan, true, review, null))).toEqual({ jobId: 'j-2', orderId: 'o-1', ok: true, packSize: 1, packs: 8, unitPrice: 7.49, total: 67.71, deliveryDays: 2, error: null });
    const caseJob = { ...cartJob, units: 10 };
    expect(toCartBody(caseJob, planCart(caseJob, items), true, { ...review, pack_size: 10, packs: 1, unit_price: 67.9, total: 76.73 }, null)).toMatchObject({ packSize: 10, packs: 1, unitPrice: 6.79 });
    expect(IngestCartBody.parse(toCartBody(cartJob, plan, false, null, 'The item is out of stock.'))).toMatchObject({ ok: false, total: null, error: 'The item is out of stock.' });
  });

  it('reports out of stock, a missing total and a sign in wall as failures', () => {
    expect(cartCheck(review)).toBeNull();
    expect(cartCheck({ ...review, cart_ok: false, reason: 'The item is out of stock.' })).toBe('The item is out of stock.');
    expect(cartCheck({ ...review, total: null })).toBe('The review page showed no total.');
    expect(cartCheck({ ...review, cart_ok: false, reason: '' })).toBe('The cart could not be filled.');
  });

  it('runs the job and posts the cart, or the failure, to the hub', async () => {
    const posts: { path: string; body: unknown }[] = [];
    const link = { post: async (path: string, body: unknown) => (posts.push({ path, body }), true), supplier: async (id: string) => (id === 's-offcut' ? offcut : retailerA), snapshot: async () => null };
    const catalogFetch = (async () => new Response(JSON.stringify(catalog))) as unknown as typeof fetch;
    const agent = fakeAgent(() => completed(review));
    await new Buyer(config({ TINYFISH_PROFILE_ID: 'prof-1' }), link, deps(agent).d, catalogFetch, () => {}).handle(cartJob);
    expect(agent.calls[0]).toMatchObject({ profileId: 'prof-1', task: { kind: 'cart', sku: 'OC-1008-114', units: 8, packIndex: 0 } });
    expect(posts).toEqual([{ path: '/ingest/cart', body: { jobId: 'j-2', orderId: 'o-1', ok: true, packSize: 1, packs: 8, unitPrice: 7.49, total: 67.71, deliveryDays: 2, error: null } }]);

    posts.length = 0;
    const out = fakeAgent(() => completed({ ...review, cart_ok: false, reason: 'The item is out of stock.', total: null }));
    await new Buyer(config(), link, deps(out).d, catalogFetch, () => {}).handle(cartJob);
    expect(posts[0]?.body).toMatchObject({ ok: false, error: 'The item is out of stock.' });

    posts.length = 0;
    const never = fakeAgent(() => completed(review));
    await new Buyer(config(), link, deps(never).d, catalogFetch, () => {}).handle({ ...cartJob, supplierId: 's-market-a' });
    expect(never.calls).toHaveLength(0);
    expect(posts[0]?.body).toMatchObject({ ok: false, error: PRICE_CHECK_ONLY });
  });

  it('runs cart jobs one at a time, and skips one whose order was cancelled while it waited', async () => {
    const posts: { path: string; body: unknown }[] = [];
    const states: Record<string, string> = { 'o-1': 'pricing', 'o-2': 'pricing' };
    const snap = () => ({ orders: Object.entries(states).map(([id, state]) => ({ id, state })), products: [] });
    const link = { post: async (path: string, body: unknown) => (posts.push({ path, body }), true), supplier: async () => offcut, snapshot: async () => snap() as never };
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const agent = fakeAgent(async (p) => {
      running += 1;
      most = Math.max(most, running);
      order.push(`start ${p.task.kind === 'cart' ? p.task.units : ''}`);
      await new Promise((r) => setTimeout(r, 15));
      // The parts are put back while the first run is still going: the hub cancels the second order.
      states['o-2'] = 'cancelled';
      running -= 1;
      return completed(review);
    });
    const buyer = new Buyer(config({ TINYFISH_PROFILE_ID: 'prof-1' }), link, deps(agent).d, (async () => new Response(JSON.stringify(catalog))) as unknown as typeof fetch, () => {});
    await Promise.all([buyer.handle(cartJob), buyer.handle({ ...cartJob, id: 'j-9', orderId: 'o-2', units: 3 }), buyer.handle({ ...cartJob, id: 'j-10', orderId: 'o-1', units: 5 })]);
    expect(most).toBe(1);
    expect(order).toEqual(['start 8', 'start 5']);
    expect(posts.map((p) => (p.body as { jobId: string }).jobId)).toEqual(['j-2', 'j-10']);
  });
});
