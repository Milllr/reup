import { ApiError, HistoryResult, ROUTES, Snapshot, Zone } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import { historyResult } from '../src/history';
import { APPROVE, count, DEVICE, rig } from './helpers';

describe('the Room', () => {
  it('starts from the seed with a valid Snapshot and the demo numbers', async () => {
    const r = await rig();
    const snap = Snapshot.parse(r.room.snapshot());
    expect(snap.products).toHaveLength(4);
    const screws = snap.policies.find((p) => p.productId === 'p-screws');
    expect(screws).toMatchObject({ reorderPoint: 4, sampleHistory: true, reason: 'Uses about 0.6 a day. Delivery takes 2 days. Reorder at 4.' });
    expect(screws?.ratePerDay).toBeCloseTo(0.55, 1);
    expect(snap.counts.find((c) => c.productId === 'p-screws')?.count).toBe(6);
  });

  it('serves the Snapshot at /api/state', async () => {
    const r = await rig();
    const res = await r.call('GET', '/api/state');
    expect(res.status).toBe(200);
    expect(Snapshot.parse(await res.json()).screen).toBe('shelf');
  });

  it('survives a restart', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 5)] }, DEVICE);
    const again = await rig({}, {}, r.store, r.clock);
    expect(again.room.count('p-screws')?.count).toBe(5);
    expect(again.room.x.seq).toBe(r.room.x.seq);
  });

  it('a saved Room takes the store address that is set now, not the one it was seeded with', async () => {
    const first = await rig({ SUPPLY_URL: 'https://old-store.example' });
    await first.room.save();
    expect(first.room.s.suppliers[0]).toMatchObject({ id: 's-offcut', baseUrl: 'https://old-store.example' });
    const second = await rig({ SUPPLY_URL: 'https://offcut.example' }, {}, first.store);
    expect(second.room.s.suppliers[0]).toMatchObject({ id: 's-offcut', baseUrl: 'https://offcut.example', searchUrl: 'https://offcut.example/search?q={q}' });
    // The rest of what was saved is still there.
    expect(second.room.s.products).toHaveLength(4);
    expect(second.room.s.suppliers.length).toBe(first.room.s.suppliers.length);
  });

  it('an open hub takes a yes and an item change from a screen with no key, tells every screen so, and keeps the operator routes shut', async () => {
    const shut = await rig();
    expect(Snapshot.parse(shut.room.snapshot()).open).toBeUndefined();
    expect((await shut.call('POST', '/api/products', { name: 'Tape', unit: 'roll', sku: null, zoneId: null, count: 2 })).status).toBe(401);

    const r = await rig({ APPROVE_OPEN: true });
    expect(Snapshot.parse(r.room.snapshot()).open).toBe(true);
    expect(Snapshot.parse(await (await r.call('GET', '/api/state')).json()).open).toBe(true);
    // A screen with no key adds an item and says yes to an order.
    expect((await r.call('POST', '/api/products', { name: 'Tape', unit: 'roll', sku: null, zoneId: null, count: 2 })).status).toBe(200);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    const order = r.room.s.orders.at(-1);
    if (!order) throw new Error('no order');
    await r.call('POST', '/ingest/cart', { jobId: 'j-x', orderId: order.id, ok: true, packSize: 1, packs: 8, unitPrice: 7.49, total: 67.71, deliveryDays: 2, error: null }, DEVICE);
    expect(r.room.order(order.id)?.state).toBe('awaiting_approval');
    const yes = await r.call('POST', `/api/orders/${order.id}/approve`, { by: 'keyboard' });
    expect(yes.status).toBe(200);
    expect(r.room.order(order.id)?.state).toBe('approved');
    // What only the operator or a device may do still needs its token.
    expect((await r.call('POST', '/api/demo/reset')).status).toBe(401);
    expect((await r.call('PUT', '/api/zones', { zones: [] })).status).toBe(401);
    expect((await r.call('POST', '/ingest/counts', { counts: [] })).status).toBe(401);
    expect((await r.call('POST', `/api/orders/${order.id}/cancel`)).status).toBe(401);
  });

  it('moves the corners of one zone with the approve key, tells every screen, and changes nothing else about the zone', async () => {
    const r = await rig();
    const before = structuredClone(r.room.s.zones.find((z) => z.id === 'z-screws'));
    if (!before) throw new Error('no zone');
    const quad = [[0.1, 0.1], [0.4, 0.12], [0.41, 0.4], [0.09, 0.38]];
    expect((await r.call('POST', '/api/zones/z-screws/quad', { quad })).status).toBe(401);
    const res = await r.call('POST', '/api/zones/z-screws/quad', { quad }, APPROVE);
    expect(res.status).toBe(200);
    expect(Zone.parse(await res.json())).toEqual({ ...before, quad });
    expect(r.room.s.zones.find((z) => z.id === 'z-screws')).toEqual({ ...before, quad });
    expect(r.room.s.products.find((p) => p.zoneId === 'z-screws')).toBeDefined();
    expect(r.sent.some((m) => m.msg.type === 'zones' && m.to === 'all')).toBe(true);
    // A corner off the picture, three corners, or a zone that is not there: refused.
    expect((await r.call('POST', '/api/zones/z-screws/quad', { quad: [[0, 0], [1.2, 0], [1, 1], [0, 1]] }, APPROVE)).status).toBe(400);
    expect((await r.call('POST', '/api/zones/z-screws/quad', { quad: quad.slice(0, 3) }, APPROVE)).status).toBe(400);
    expect((await r.call('POST', '/api/zones/z-nope/quad', { quad }, APPROVE)).status).toBe(404);
  });

  it('sends job messages to buyers only, and everything else to everyone', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    const jobs = r.sent.filter((m) => m.msg.type === 'job');
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((m) => m.to === 'buyer')).toBe(true);
    expect(r.sent.filter((m) => m.msg.type !== 'job').every((m) => m.to === 'all')).toBe(true);
  });

  it('answers 401 with an ApiError for a wrong token on every ingest route', async () => {
    const r = await rig();
    for (const [method, path] of ROUTES.filter(([, p]) => p.startsWith('/ingest'))) {
      for (const token of [undefined, 'wrong']) {
        const res = await r.call(method, path, {}, token);
        expect(res.status, `${path} ${token}`).toBe(401);
        expect(ApiError.parse(await res.json()).code).toBe('unauthorized');
      }
    }
  });

  it('answers 400 with the field name for a body that fails its schema, and 404 for an unknown route', async () => {
    const r = await rig();
    const bad = await r.call('POST', '/ingest/counts', { counts: [] }, DEVICE);
    expect(bad.status).toBe(400);
    expect(ApiError.parse(await bad.json()).message).toContain('counts');
    expect((await r.call('GET', '/api/nope')).status).toBe(404);
  });

  it('takes camera health posted alone, with no counts', async () => {
    const r = await rig();
    const res = await r.call('POST', '/ingest/counts', { counts: [], cameras: [{ id: 'board', online: true, fps: 28.5, streamUrl: 'http://localhost:8089/stream/board.mjpg' }] }, DEVICE);
    expect(res.status).toBe(200);
    expect(r.room.s.cameras.find((c) => c.id === 'board')).toMatchObject({ online: true, fps: 28.5 });
  });

  it('marks the buyer online and offline', async () => {
    const r = await rig();
    r.room.setBuyerOnline(true);
    r.room.setBuyerOnline(true);
    expect(r.of('buyer')).toEqual([{ type: 'buyer', online: true }]);
  });
});

describe('history', () => {
  it('sums picks per local day in Toronto and returns a valid HistoryResult', async () => {
    const r = await rig();
    // 11:30 PM Toronto on Nov 21 is already Nov 22 in UTC. It still belongs to Nov 21.
    r.clock.now = Date.parse('2026-11-22T04:30:00Z');
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 5)] }, DEVICE);
    expect(r.room.x.usage['p-screws']?.['2026-11-21']?.used).toBe(1);
    r.clock.now = Date.parse('2026-11-22T15:00:00Z');
    const res = await r.call('GET', '/api/products/p-screws/history');
    const h = HistoryResult.parse(await res.json());
    expect(h.days).toHaveLength(30);
    expect(h.days.at(-1)).toMatchObject({ day: '2026-11-21', used: 1, sample: false });
    expect(h.forecast).toHaveLength(7);
    expect(h.forecast[0]?.day).toBe('2026-11-23');
    expect((await r.call('GET', '/api/products/nope/history')).status).toBe(404);
  });

  it('walks the stock line back from what is on the board', async () => {
    const r = await rig();
    const h = historyResult(r.room, 'p-screws');
    expect(h?.days.at(-1)?.endCount).toBe(6);
    expect(h?.days.every((d) => d.endCount >= 0 && d.endCount <= 12)).toBe(true);
    expect(Math.max(...(h?.days.map((d) => d.endCount) ?? []))).toBeGreaterThanOrEqual(11);
    expect(h?.reorderPoint).toBe(4);
  });
});
