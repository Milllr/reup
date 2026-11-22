import { ApiError, Catalog, Count, Product, ProductAddBody, ROUTES, ServerMessage, Snapshot } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import catalogMock from '../../../../contracts/mocks/catalog.json';
import { APPROVE, count, DEVICE, OPS, rig } from '../helpers';

const catalogFetch = (async () => new Response(JSON.stringify(catalogMock))) as unknown as typeof fetch;
const tape = { name: "Blue painter's tape 1 in", unit: 'roll', sku: 'OC-3473', searchPhrase: 'blue painters tape 1 inch', zoneId: null, count: 6 };

describe('items in the dashboard', () => {
  it('lists the routes, and serves the store catalog to pick from', async () => {
    const paths = ROUTES.map(([method, path]) => `${method} ${path}`);
    for (const route of ['GET /api/catalog', 'POST /api/products', 'PUT /api/products/:id', 'POST /api/products/:id/count', 'POST /api/products/:id/remove']) expect(paths).toContain(route);
    const r = await rig({}, { fetch: catalogFetch });
    const res = await r.call('GET', '/api/catalog');
    expect(res.status).toBe(200);
    expect(Catalog.parse(await res.json()).items.length).toBe(catalogMock.items.length);
  });

  it('adds an item counted by hand: on the lists at once, with a count, a reorder point and the store delivery time', async () => {
    const r = await rig({}, { fetch: catalogFetch });
    const res = await r.call('POST', '/api/products', ProductAddBody.parse(tape), APPROVE);
    expect(res.status).toBe(200);
    const product = Product.parse(await res.json());
    expect(product).toMatchObject({ id: 'p-blue-painter-s-tape-1-in', name: tape.name, unit: 'roll', sku: 'OC-3473', zoneId: null, capacity: 6, searchPhrase: 'blue painters tape 1 inch' });
    // No zone: the count is filed under the item's own id, and it is a person's count.
    expect(r.room.count(product.id)).toMatchObject({ zoneId: product.id, count: 6, source: 'manual' });
    const snap = Snapshot.parse(r.room.snapshot());
    expect(snap.products).toHaveLength(5);
    const policy = snap.policies.find((p) => p.productId === product.id);
    expect(policy?.ratePerDay).toBeGreaterThan(0);
    expect(policy?.reorderPoint).toBeGreaterThan(0);
    expect(policy?.reorderPoint).toBeLessThan(6);
    expect(r.room.x.leadDays[product.id]).toBe(catalogMock.items.find((i) => i.sku === 'OC-3473')?.leadDays);
    expect(r.room.s.activity.at(-1)?.text).toBe("Blue painter's tape 1 in added. Counted by hand.");
    expect(r.of('product').at(-1)?.product.id).toBe(product.id);
    for (const m of r.sent) ServerMessage.parse(m.msg);
    // The same name twice is refused, and so is a caller with no key or the camera's token.
    expect((await r.call('POST', '/api/products', tape, OPS)).status).toBe(409);
    expect((await r.call('POST', '/api/products', { ...tape, name: 'Other tape' })).status).toBe(401);
    expect((await r.call('POST', '/api/products', { ...tape, name: 'Other tape' }, DEVICE)).status).toBe(401);
    expect(ApiError.parse(await (await r.call('POST', '/api/products', { ...tape, name: '' }, APPROVE)).json()).code).toBe('bad_request');
  });

  it('adds an item on a free ledge, where the camera count takes over, and refuses a ledge that is taken', async () => {
    const r = await rig();
    expect(r.room.zone('z-teach')?.productId).toBeNull();
    const taken = await r.call('POST', '/api/products', { ...tape, zoneId: 'z-screws' }, APPROVE);
    expect(taken.status).toBe(409);
    expect(ApiError.parse(await taken.json()).message).toContain('already holds Wood screws');
    expect((await r.call('POST', '/api/products', { ...tape, zoneId: 'z-nowhere' }, APPROVE)).status).toBe(404);
    const product = Product.parse(await (await r.call('POST', '/api/products', { ...tape, zoneId: 'z-teach', count: 2 }, APPROVE)).json());
    expect(product.zoneId).toBe('z-teach');
    expect(r.room.zone('z-teach')?.productId).toBe(product.id);
    expect(r.of('zones').length).toBeGreaterThan(0);
    expect(r.room.count(product.id)).toMatchObject({ zoneId: 'z-teach', count: 2, source: 'manual' });
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-teach', 3)] }, DEVICE);
    expect(r.room.count(product.id)).toMatchObject({ count: 3, source: 'eye' });
    expect(r.room.s.activity.some((a) => a.text === "Blue painter's tape 1 in added. The camera counts it.")).toBe(true);
  });

  it('a count typed by hand is the count of record: use is recorded, and reaching the reorder point starts an order', async () => {
    const r = await rig({}, { fetch: catalogFetch });
    const product = Product.parse(await (await r.call('POST', '/api/products', tape, APPROVE)).json());
    const line = r.room.policy(product.id)?.reorderPoint ?? 0;
    const res = await r.call('POST', `/api/products/${product.id}/count`, { count: line }, APPROVE);
    expect(res.status).toBe(200);
    expect(Count.parse(await res.json())).toMatchObject({ productId: product.id, count: line, source: 'manual' });
    expect(r.room.x.usage[product.id]?.[r.room.today()]?.used).toBe(6 - line);
    expect(r.of('pick').at(-1)?.pick).toMatchObject({ productId: product.id, delta: line - 6, countAfter: line, source: 'manual' });
    const order = r.room.s.orders.find((o) => o.productId === product.id);
    expect(order?.state).toBe('pricing');
    expect(r.jobs().some((j) => j.kind === 'cart' && j.sku === 'OC-3473')).toBe(true);
    // A camera counted part can be corrected by hand too. The correction stands until the camera reports.
    expect((await r.call('POST', '/api/products/p-glue/count', { count: 4 }, OPS)).status).toBe(200);
    expect(r.room.count('p-glue')).toMatchObject({ zoneId: 'z-glue', count: 4, source: 'manual' });
    expect((await r.call('POST', '/api/products/p-none/count', { count: 1 }, APPROVE)).status).toBe(404);
    expect((await r.call('POST', '/api/products/p-glue/count', { count: -1 }, APPROVE)).status).toBe(400);
  });

  it('edits only the fields given, and a new store item brings its own delivery time', async () => {
    const r = await rig({}, { fetch: catalogFetch });
    const res = await r.call('PUT', '/api/products/p-glue', { name: 'Wood glue, 473 mL' }, APPROVE);
    expect(res.status).toBe(200);
    expect(Product.parse(await res.json())).toMatchObject({ id: 'p-glue', name: 'Wood glue, 473 mL', zoneId: 'z-glue' });
    const before = r.room.product('p-glue');
    const other = catalogMock.items.find((i) => i.sku !== before?.sku && i.leadDays !== 2) ?? catalogMock.items[0];
    await r.call('PUT', '/api/products/p-glue', { sku: other?.sku, searchPhrase: 'wood glue' }, APPROVE);
    expect(r.room.product('p-glue')).toMatchObject({ name: 'Wood glue, 473 mL', sku: other?.sku, searchPhrase: 'wood glue', unit: before?.unit });
    expect(r.room.x.leadDays['p-glue']).toBe(other?.leadDays);
    expect(Snapshot.parse(r.of('snapshot').at(-1)?.snapshot).products.find((p) => p.id === 'p-glue')?.name).toBe('Wood glue, 473 mL');
    // A name another item has is refused, and nothing changes.
    expect((await r.call('PUT', '/api/products/p-glue', { name: r.room.product('p-screws')?.name }, APPROVE)).status).toBe(409);
    expect((await r.call('PUT', '/api/products/p-none', { name: 'x' }, APPROVE)).status).toBe(404);
    expect((await r.call('PUT', '/api/products/p-glue', { name: 'y' }, 'wrong')).status).toBe(401);
  });

  it('removes an item: off every list, its ledge free, an order still being shopped withdrawn', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    const order = r.room.s.orders.find((o) => o.productId === 'p-screws');
    expect(order?.state).toBe('pricing');
    const res = await r.call('POST', '/api/products/p-screws/remove', undefined, APPROVE);
    expect(res.status).toBe(200);
    const snap = Snapshot.parse(r.room.snapshot());
    expect(snap.products.map((p) => p.id)).not.toContain('p-screws');
    expect(snap.counts.some((c) => c.productId === 'p-screws')).toBe(false);
    expect(snap.policies.some((p) => p.productId === 'p-screws')).toBe(false);
    expect(snap.zones.find((z) => z.id === 'z-screws')?.productId).toBeNull();
    expect(r.room.order(order?.id ?? '')?.state).toBe('cancelled');
    expect(r.room.x.usage['p-screws']).toBeUndefined();
    expect(r.room.s.activity.at(-1)?.text).toBe('Wood screws #8 x 1-1/4 in removed.');
    expect(Snapshot.parse(r.of('snapshot').at(-1)?.snapshot).products).toHaveLength(3);
    // The camera can keep reporting the freed ledge. Nothing comes back.
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 5)] }, DEVICE);
    expect(r.room.s.products).toHaveLength(3);
    expect(r.room.s.counts.some((c) => c.zoneId === 'z-screws')).toBe(false);
    expect((await r.call('POST', '/api/products/p-screws/remove', undefined, APPROVE)).status).toBe(404);
    // The freed ledge can take a new item.
    expect((await r.call('POST', '/api/products', { ...tape, zoneId: 'z-screws' }, APPROVE)).status).toBe(200);
  });

  it('will not remove an item while its order is being placed', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    const order = r.room.s.orders.find((o) => o.productId === 'p-screws');
    if (!order) throw new Error('no order');
    order.state = 'placing';
    const res = await r.call('POST', '/api/products/p-screws/remove', undefined, APPROVE);
    expect(res.status).toBe(409);
    expect(ApiError.parse(await res.json()).message).toContain('is being placed');
    expect(r.room.product('p-screws')).toBeDefined();
  });

  it('survives a restart, and a demo reset keeps what a person added', async () => {
    const r = await rig({}, { fetch: catalogFetch });
    const product = Product.parse(await (await r.call('POST', '/api/products', tape, APPROVE)).json());
    const again = await rig({}, { fetch: catalogFetch }, r.store, r.clock);
    expect(again.room.product(product.id)?.name).toBe(tape.name);
    expect(again.room.count(product.id)?.count).toBe(6);
    expect((await again.call('POST', '/api/demo/reset', undefined, OPS)).status).toBe(200);
    expect(again.room.product(product.id)).toBeDefined();
    expect(again.room.count(product.id)?.count).toBe(6);
    expect(again.room.policy(product.id)?.reorderPoint).toBeGreaterThan(0);
  });
});
