import { ApiError, HistoryResult, ROUTES, Snapshot } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import { historyResult } from '../src/history';
import { count, DEVICE, rig } from './helpers';

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
