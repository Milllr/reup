import { IngestPlacedBody, type CatalogItem } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import catalog from '../../../../contracts/mocks/catalog.json';
import snapshot from '../../../../contracts/mocks/snapshot.json';
import { planCart } from '../../src/cart';
import { Buyer, PRICE_CHECK_ONLY } from '../../src/jobs';
import { parseDeliveryDate, placeCheck, placeGoal, toPlacedBody, type Basket } from '../../src/place';
import { cartJob, completed, config, deps, fakeAgent, offcut, placeJob, retailerA } from '../helpers';

const items = catalog.items as CatalogItem[];
const basket: Basket = { sku: 'OC-1008-114', phrase: cartJob.searchPhrase, units: 8, plan: planCart(cartJob, items) };
const profile = { profile: true, email: 'shop@reup.test', password: '' };
const now = new Date('2026-11-21T14:14:00Z');
const tz = 'America/Toronto';

function buyer(agent: ReturnType<typeof fakeAgent>, snap: unknown = null) {
  const posts: { path: string; body: unknown }[] = [];
  const logs: string[] = [];
  const link = { post: async (path: string, body: unknown) => (posts.push({ path, body }), true), supplier: async (id: string) => (id === 's-offcut' ? offcut : retailerA), snapshot: async () => snap as never };
  return { buyer: new Buyer(config({ TINYFISH_PROFILE_ID: 'prof-1' }), link, deps(agent).d, (async () => new Response(JSON.stringify(catalog))) as unknown as typeof fetch, (l) => logs.push(l)), posts, logs };
}

describe('placing the order', () => {
  it('refuses any supplier that is not an account supplier, and logs it', async () => {
    const agent = fakeAgent(() => completed({ confirmation: 'OC-1', delivery_date: null, reason: null }));
    const { buyer: b, posts, logs } = buyer(agent);
    await b.handle({ ...placeJob, supplierId: 's-market-a' });
    expect(agent.calls).toHaveLength(0);
    expect(IngestPlacedBody.parse(posts[0]?.body)).toMatchObject({ ok: false, confirmation: null, error: PRICE_CHECK_ONLY });
    expect(logs.join('\n')).toContain('Refused place job j-3');
  });

  it('puts the PO number and Bill to account in the goal, and never a card', () => {
    const goal = placeGoal(placeJob, basket, profile);
    expect(goal).toContain('type RU-1042 into the field labelled "PO number"');
    expect(goal).toContain('Payment must read "Bill to account"');
    expect(goal).toContain('Never enter a card number');
    expect(goal).toContain('It must hold exactly 8 of SKU OC-1008-114 in the pack size "Box of 100" and nothing else');
    expect(goal).toContain('press "Place order" only once');
    expect(placeGoal(placeJob, null, profile)).toContain('If it is empty, stop');
  });

  it('treats a missing or made up confirmation as a failure, never a guess', () => {
    expect(placeCheck({ confirmation: 'OC-58213', delivery_date: null, reason: null })).toBeNull();
    expect(placeCheck({ confirmation: null, delivery_date: null, reason: null })).toBe('The store showed no confirmation number.');
    expect(placeCheck({ confirmation: 'pending', delivery_date: null, reason: null })).toBe('The store showed no confirmation number.');
    expect(placeCheck({ confirmation: null, delivery_date: null, reason: 'The cart was empty.' })).toBe('The cart was empty.');
    expect(IngestPlacedBody.parse(toPlacedBody(placeJob, false, null, null, now, tz))).toMatchObject({ ok: false, confirmation: null, eta: null });
  });

  it('parses the delivery date to an ISO time at noon local', () => {
    expect(parseDeliveryDate('Tuesday, Nov 24', now, tz)).toBe('2026-11-24T12:00:00-05:00');
    expect(parseDeliveryDate('2026-07-02', now, tz)).toBe('2026-07-02T12:00:00-04:00');
    expect(parseDeliveryDate('Monday, Jan 4', new Date('2026-12-30T14:00:00Z'), tz)).toBe('2027-01-04T12:00:00-05:00');
    expect(parseDeliveryDate('soon', now, tz)).toBeNull();
    expect(parseDeliveryDate(null, now, tz)).toBeNull();
    expect(toPlacedBody(placeJob, true, { confirmation: ' oc-58213 ', delivery_date: 'Tuesday, Nov 24' }, null, now, tz)).toEqual({ jobId: 'j-3', orderId: 'o-1', ok: true, confirmation: 'OC-58213', eta: '2026-11-24T12:00:00-05:00', error: null });
  });

  it('places with the basket the cart job built, or rebuilds it from the hub after a restart', async () => {
    const result = { confirmation: 'OC-58213', delivery_date: 'Tuesday, Nov 24', reason: null };
    const agent = fakeAgent((p) => completed(p.task.kind === 'cart' ? { cart_ok: true, reason: null, pack_label: 'Box of 100', pack_size: 1, packs: 8, unit_price: 7.49, total: 67.71, delivery_days: 2, delivery_date: null } : result));
    const { buyer: b, posts } = buyer(agent);
    await b.handle(cartJob);
    await b.handle(placeJob);
    expect(agent.calls[1]?.task).toEqual({ kind: 'place', poNumber: 'RU-1042', sku: 'OC-1008-114', units: 8, packIndex: 0 });
    expect(posts.at(-1)).toEqual({ path: '/ingest/placed', body: { jobId: 'j-3', orderId: 'o-1', ok: true, confirmation: 'OC-58213', eta: '2026-11-24T12:00:00-05:00', error: null } });

    const restarted = fakeAgent(() => completed(result));
    const fresh = buyer(restarted, snapshot);
    await fresh.buyer.handle(placeJob);
    expect(restarted.calls[0]?.task).toEqual({ kind: 'place', poNumber: 'RU-1042', sku: 'OC-1008-114', units: 8, packIndex: 0 });
    expect(restarted.calls[0]?.goal).toContain('exactly 8 of SKU OC-1008-114');
  });
});
