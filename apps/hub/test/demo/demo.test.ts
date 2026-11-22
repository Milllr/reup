import { Snapshot } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import { APPROVE, count, DEVICE, OPS, rig, toAwaiting } from '../helpers';

describe('seed, season, reset, replay', () => {
  it('seeds the demo so wood screws reorder at 4 and every part reads like the mockups', async () => {
    const r = await rig();
    const by = (id: string) => r.room.policy(id);
    expect(by('p-screws')).toMatchObject({ reorderPoint: 4, orderQty: 6 });
    expect(by('p-brackets')?.reorderPoint).toBe(2);
    expect(by('p-glue')?.reorderPoint).toBe(1);
    expect(by('p-discs')?.reorderPoint).toBe(2);
    expect(Math.round(by('p-screws')?.daysOfCover ?? 0)).toBe(11);
    expect(Math.round((by('p-brackets')?.daysOfCover ?? 0) / 7)).toBe(4);
    expect(Math.round((by('p-glue')?.daysOfCover ?? 0) / 7)).toBe(6);
    expect(Math.round((by('p-discs')?.daysOfCover ?? 0) / 7)).toBe(5);
  });

  it('season recomputes every policy and tells the screens', async () => {
    const r = await rig();
    const res = await r.call('POST', '/api/demo/season', { factor: 1.4, label: 'Busy' }, OPS);
    expect(res.status).toBe(200);
    expect(r.of('season')).toEqual([{ type: 'season', season: { factor: 1.4, label: 'Busy' } }]);
    expect(r.of('policy')).toHaveLength(4);
    expect(r.room.policy('p-screws')).toMatchObject({ seasonFactor: 1.4, reorderPoint: 5 });
    await r.call('POST', '/api/demo/season', { factor: 0.6, label: 'Slow' }, OPS);
    expect(r.room.policy('p-screws')?.reorderPoint).toBe(3);
    expect(r.room.s.orders).toHaveLength(0);
    // The switch is on the Forecast screen: the key that says yes sets it, and no key at all does not.
    expect((await r.call('POST', '/api/demo/season', { factor: 1, label: 'Normal' }, APPROVE)).status).toBe(200);
    expect(r.room.s.season).toEqual({ factor: 1, label: 'Normal' });
    expect((await r.call('POST', '/api/demo/season', { factor: 1.4, label: 'Busy' })).status).toBe(401);
    // On a hub that takes changes from any screen, the board's own switch works with no key.
    const open = await rig({ APPROVE_OPEN: true });
    expect((await open.call('POST', '/api/demo/season', { factor: 1.4, label: 'Busy' })).status).toBe(200);
    expect(open.room.s.season.factor).toBe(1.4);
  });

  it('reset cancels and clears orders, keeps zones, products and counts, and restores the demo numbers', async () => {
    const r = await rig();
    await toAwaiting(r);
    await r.call('POST', '/api/demo/season', { factor: 1.4, label: 'Busy' }, OPS);
    await r.call('POST', '/api/demo/screen', { screen: 'why', focusProductId: 'p-screws' }, OPS);
    const res = await r.call('POST', '/api/demo/reset', undefined, OPS);
    const snap = Snapshot.parse(await res.json());
    expect(snap).toMatchObject({ screen: 'shelf', orders: [], runs: [], activity: [], teach: null, season: { factor: 1, label: 'Normal' } });
    expect(snap.zones).toHaveLength(5);
    expect(snap.products).toHaveLength(4);
    expect(snap.counts.find((c) => c.productId === 'p-screws')?.count).toBe(4);
    expect(snap.policies.find((p) => p.productId === 'p-screws')?.reorderPoint).toBe(4);
    expect(r.room.x.jobs).toEqual([]);
    expect(r.of('snapshot')).toHaveLength(1);
    expect(r.room.x.usage['p-screws']?.[r.room.today()]).toBeUndefined();
    // After the parts are back, the next take runs the whole demo again.
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 6)] }, DEVICE);
    expect(r.room.s.orders).toHaveLength(0);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    expect(r.room.s.orders).toHaveLength(1);
    expect(r.room.s.orders[0]?.poNumber).toBe('RU-1043');
  });

  it('reset frees the teach spot: the part the last judge taught goes, a part taught elsewhere stays', async () => {
    const r = await rig();
    r.room.s.products.push({ id: 'p-tape', name: 'Masking tape', unit: 'roll', sku: null, zoneId: 'z-teach', capacity: null, searchPhrase: 'masking tape', imageUrl: null, createdAt: r.room.iso() });
    r.room.s.counts.push({ productId: 'p-tape', zoneId: 'z-teach', count: 1, level: null, pockets: null, source: 'manual', ts: r.room.iso() });
    const spot = r.room.zone('z-teach');
    if (spot) spot.productId = 'p-tape';
    r.room.recomputePolicy('p-tape');
    const snap = Snapshot.parse(await (await r.call('POST', '/api/demo/reset', undefined, OPS)).json());
    expect(snap.products.map((p) => p.id)).toEqual(['p-screws', 'p-brackets', 'p-glue', 'p-discs']);
    expect(snap.zones.find((z) => z.id === 'z-teach')?.productId).toBeNull();
    expect(snap.counts.some((c) => c.productId === 'p-tape')).toBe(false);
    expect(snap.policies.some((p) => p.productId === 'p-tape')).toBe(false);
  });

  it('testing the day before does not move the demo numbers after a reset', async () => {
    const r = await rig();
    for (const n of [5, 3, 1, 0]) await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-brackets', n)] }, DEVICE);
    r.clock.now += 24 * 3600 * 1000;
    r.room.recomputePolicy('p-brackets');
    expect(r.room.policy('p-brackets')?.reorderPoint).toBeGreaterThan(2);
    await r.call('POST', '/api/demo/reset', undefined, OPS);
    expect(r.room.policy('p-brackets')?.reorderPoint).toBe(2);
  });

  it('replay switches ride along in the jobs', async () => {
    const r = await rig();
    await r.call('POST', '/api/demo/replay', { kind: 'cart', on: true }, OPS);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    expect(r.jobs().find((j) => j.kind === 'cart')).toMatchObject({ replay: true });
    expect(r.jobs().find((j) => j.kind === 'market')).toMatchObject({ replay: false });
  });

  it('saving zones needs the ops token and updates capacity', async () => {
    const r = await rig();
    const zones = r.room.s.zones.map((z) => (z.id === 'z-brackets' ? { ...z, rows: 2, cols: 4 } : z));
    expect((await r.call('PUT', '/api/zones', { zones }, DEVICE)).status).toBe(401);
    expect((await r.call('PUT', '/api/zones', { zones }, OPS)).status).toBe(200);
    expect(r.room.product('p-brackets')?.capacity).toBe(8);
    expect(r.of('zones')).toHaveLength(1);
  });
});
