import { AnalyticsResult, ApiError, Catalog, Count, Product, ProductAddBody, ROUTES, ServerMessage, Snapshot } from '@reup/contracts';
import { reorderPoint } from '@reup/brain';
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
    // It is on the dashboard like any other item: 30 days behind it, 60 ahead, with the store's price.
    const analytics = AnalyticsResult.parse(await (await r.call('GET', '/api/analytics')).json());
    const part = analytics.parts.find((p) => p.productId === product.id);
    expect(part).toMatchObject({ name: tape.name, count: 6, capacity: 6 });
    expect(part?.unitPrice).toBeGreaterThan(0);
    expect(part?.projection.length).toBe(60);
    expect(r.of('product').at(-1)?.product.id).toBe(product.id);
    for (const m of r.sent) ServerMessage.parse(m.msg);
    // The same name twice is refused, and so is a caller with no key or the camera's token.
    expect((await r.call('POST', '/api/products', tape, OPS)).status).toBe(409);
    expect((await r.call('POST', '/api/products', { ...tape, name: 'Other tape' })).status).toBe(401);
    expect((await r.call('POST', '/api/products', { ...tape, name: 'Other tape' }, DEVICE)).status).toBe(401);
    expect(ApiError.parse(await (await r.call('POST', '/api/products', { ...tape, name: '' }, APPROVE)).json()).code).toBe('bad_request');
  });

  it('an item that comes with its use a day gets the reorder point that figure gives, and survives a demo reset', async () => {
    const r = await rig({}, { fetch: catalogFetch });
    await r.call('GET', '/api/catalog');
    const row = { name: 'Zinc wood screws #8 x 1-1/4 in', unit: 'box of 100', sku: null, zoneId: null, count: 24, usePerDay: 1.5 };
    const res = await r.call('POST', '/api/products', ProductAddBody.parse(row), APPROVE);
    expect(res.status).toBe(200);
    const product = Product.parse(await res.json());
    const policy = () => Snapshot.parse(r.room.snapshot()).policies.find((p) => p.productId === product.id);
    // 1.5 a day over 2 days of delivery and the review day, with its margin: the line the brain draws for that rate.
    const want = reorderPoint(1.5, 2);
    expect(want).toBeGreaterThan(3);
    expect(policy()).toMatchObject({ reorderPoint: want, leadDays: 2, sampleHistory: true });
    expect(policy()?.ratePerDay).toBeGreaterThan(1);
    expect(policy()?.ratePerDay).toBeLessThan(2);
    // Whole units on every day, and none of it counted as today's.
    const days = Object.values(r.room.x.usage[product.id] ?? {});
    expect(days).toHaveLength(30);
    expect(days.every((d) => Number.isInteger(d.used) && d.sample)).toBe(true);
    // Slow and fast parts land on their own lines too, and a part nobody uses is never reordered.
    for (const [name, perDay] of [['Slow part', 0.1], ['Fast part', 40], ['Idle part', 0]] as const) {
      const made = Product.parse(await (await r.call('POST', '/api/products', { name, unit: 'each', sku: null, zoneId: null, count: 2000, usePerDay: perDay }, APPROVE)).json());
      const p = Snapshot.parse(r.room.snapshot()).policies.find((x) => x.productId === made.id);
      if (perDay === 40) expect(Math.abs((p?.reorderPoint ?? 0) - reorderPoint(perDay, 2))).toBeLessThanOrEqual(reorderPoint(perDay, 2) * 0.15);
      else expect(p?.reorderPoint).toBe(reorderPoint(perDay, 2));
    }
    expect((await r.call('POST', '/api/products', { ...row, name: 'Too much', usePerDay: 1000 }, APPROVE)).status).toBe(400);
    // A demo reset writes sample history for every part again. This one keeps the line its own figure gives.
    expect((await r.call('POST', '/api/demo/reset', undefined, OPS)).status).toBe(200);
    expect(policy()).toMatchObject({ reorderPoint: want, sampleHistory: true });
    AnalyticsResult.parse(await (await r.call('GET', '/api/analytics')).json());
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

  it('removes an item: off every list, its box off the board, an order still being shopped withdrawn', async () => {
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
    // Its box goes with it: the board shows no box for a part that is not there.
    expect(snap.zones.some((z) => z.id === 'z-screws')).toBe(false);
    expect(Snapshot.parse(r.of('snapshot').at(-1)?.snapshot).zones.some((z) => z.id === 'z-screws')).toBe(false);
    expect(r.room.order(order?.id ?? '')?.state).toBe('cancelled');
    expect(r.room.x.usage['p-screws']).toBeUndefined();
    // The item is just gone: no line says it was removed, and no older line still names it or its ledge.
    expect(r.room.s.activity.some((a) => /wood screws/i.test(a.text))).toBe(false);
    expect(Snapshot.parse(r.of('snapshot').at(-1)?.snapshot).activity.some((a) => /removed/i.test(a.text))).toBe(false);
    expect(Snapshot.parse(r.of('snapshot').at(-1)?.snapshot).products).toHaveLength(3);
    // The camera may report the old box once more before it hears. Nothing comes back.
    await r.call('POST', '/ingest/counts', { counts: [{ productId: 'p-screws', zoneId: 'z-screws', count: 5, level: null, pockets: null, source: 'eye', ts: r.room.iso() }] }, DEVICE);
    expect(r.room.s.products).toHaveLength(3);
    expect(r.room.s.counts.some((c) => c.zoneId === 'z-screws')).toBe(false);
    expect((await r.call('POST', '/api/products/p-screws/remove', undefined, APPROVE)).status).toBe(404);
    // There is no box left there to put a new item on.
    expect((await r.call('POST', '/api/products', { ...tape, zoneId: 'z-screws' }, APPROVE)).status).toBe(404);
  });

  it('removing the part on the teach spot frees the spot and keeps its box', async () => {
    const r = await rig();
    const added = await r.call('POST', '/api/products', { ...tape, zoneId: 'z-teach' }, APPROVE);
    const made = Product.parse(await added.json());
    expect(r.room.zone('z-teach')?.productId).toBe(made.id);
    expect((await r.call('POST', `/api/products/${made.id}/remove`, undefined, APPROVE)).status).toBe(200);
    expect(r.room.zone('z-teach')).toMatchObject({ id: 'z-teach', productId: null });
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
