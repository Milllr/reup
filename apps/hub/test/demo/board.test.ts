import { ratePerDay, reorderPoint } from '@reup/brain';
import { BoardBody, Snapshot } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import board from '../../../../contracts/mocks/board.json';
import { historyResult } from '../../src/history';
import { sampleForStock, sampleUse } from '../../src/seed';
import { count, DEVICE, OPS, rig, type Rig } from '../helpers';

const BOARD = BoardBody.parse(board);

async function built(stock: Record<string, number> = { 'z-washers': 3, 'z-bolts': 3, 'z-wax': 4, 'z-9v': 3 }): Promise<Rig> {
  const r = await rig();
  expect((await r.call('PUT', '/api/board', BOARD, OPS)).status).toBe(200);
  await see(r, stock);
  return r;
}

async function see(r: Rig, counts: Record<string, number>): Promise<void> {
  r.advance(1000);
  await r.call('POST', '/ingest/counts', { counts: Object.entries(counts).map(([zone, n]) => count(r, zone, n)) }, DEVICE);
}

describe('sample use sized to a ledge', () => {
  it('finds whole unit use for every reorder point from 1 to 20', () => {
    for (let target = 1; target <= 20; target++) {
      const use = sampleUse(target);
      expect(use).toHaveLength(30);
      expect(use.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
      expect(reorderPoint(ratePerDay(use), 2)).toBe(target);
    }
  });

  it('puts the line two under a full ledge, and its deliveries add up', () => {
    for (const stock of [2, 3, 4, 6, 10, 15]) {
      const sample = sampleForStock(stock);
      expect(reorderPoint(ratePerDay(sample?.use ?? []), 2)).toBe(Math.max(1, stock - 2));
      // Walking back from a full ledge never needs more than the ledge holds, or less than nothing.
      let end = stock;
      for (let i = 29; i >= 0; i--) {
        end = end + (sample?.use[i] ?? 0) - (sample?.restock[i] ?? 0);
        expect(end).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(stock);
      }
    }
    expect(sampleForStock(1)).toBeNull();
    expect(sampleForStock(0)).toBeNull();
  });
});

describe('PUT /api/board', () => {
  it('needs the ops token and a body the contract accepts', async () => {
    const r = await rig();
    expect((await r.call('PUT', '/api/board', BOARD, DEVICE)).status).toBe(401);
    expect((await r.call('PUT', '/api/board', { zones: [] }, OPS)).status).toBe(400);
    expect(r.room.s.products.map((p) => p.id)).toContain('p-screws');
  });

  it('replaces every zone and part, clears the demo and tells the screens once', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    expect(r.room.s.orders).toHaveLength(1);
    const res = await r.call('PUT', '/api/board', BOARD, OPS);
    const snap = Snapshot.parse(await res.json());
    expect(snap.zones.map((z) => z.id)).toEqual(['z-washers', 'z-bolts', 'z-wax', 'z-9v', 'z-teach']);
    expect(snap.products.map((p) => [p.id, p.zoneId, p.capacity])).toEqual([['p-washers', 'z-washers', null], ['p-bolts', 'z-bolts', null], ['p-wax', 'z-wax', null], ['p-9v', 'z-9v', null]]);
    expect(snap).toMatchObject({ screen: 'shelf', orders: [], runs: [], counts: [], quotes: [] });
    expect(snap.policies.map((p) => p.reorderPoint)).toEqual([0, 0, 0, 0]);
    expect(r.room.x.jobs).toEqual([]);
    expect(Object.keys(r.room.x.usage).sort()).toEqual(['p-9v', 'p-bolts', 'p-washers', 'p-wax']);
    expect(r.of('snapshot')).toHaveLength(1);
    expect(snap.activity.at(-1)?.text).toBe('Board set: Flat washers 3/4 in, Hex bolts 3/4 x 3 in, MWAX synthetic lubricant, 9V batteries.');
  });

  it('a part given a capacity keeps it, and a pocket zone still counts its pockets', async () => {
    const r = await rig();
    const body = structuredClone(BOARD);
    body.products[0] = { ...body.products[0]!, capacity: 8 };
    body.zones[1] = { ...body.zones[1]!, kind: 'pockets', rows: 2, cols: 3 };
    await r.call('PUT', '/api/board', body, OPS);
    await see(r, { 'z-washers': 10, 'z-bolts': 6 });
    expect(r.room.product('p-washers')?.capacity).toBe(8);
    expect(r.room.product('p-bolts')?.capacity).toBe(6);
    expect(r.room.policy('p-washers')?.reorderPoint).toBe(6);
    expect(r.room.policy('p-bolts')?.reorderPoint).toBe(4);
  });
});

describe('a ledge holds what is stocked', () => {
  it('the first count teaches the capacity, with no pick and no order', async () => {
    const r = await built();
    expect(r.room.s.products.map((p) => p.capacity)).toEqual([3, 3, 4, 3]);
    expect(r.room.s.policies.map((p) => [p.productId, p.reorderPoint, p.sampleHistory])).toEqual([['p-washers', 1, true], ['p-bolts', 1, true], ['p-wax', 2, true], ['p-9v', 1, true]]);
    expect(r.of('pick')).toHaveLength(0);
    expect(r.room.s.orders).toHaveLength(0);
    expect(r.of('product').map((m) => [m.product.id, m.product.capacity])).toEqual([['p-washers', 3], ['p-bolts', 3], ['p-wax', 4], ['p-9v', 3]]);
  });

  it('taking one of any part orders nothing, taking two orders what was taken', async () => {
    for (const [zone, product, stock] of [['z-washers', 'p-washers', 3], ['z-bolts', 'p-bolts', 3], ['z-wax', 'p-wax', 4], ['z-9v', 'p-9v', 3]] as const) {
      const r = await built();
      await see(r, { [zone]: stock - 1 });
      expect(r.room.s.orders).toHaveLength(0);
      await see(r, { [zone]: stock - 2 });
      expect(r.room.s.orders).toHaveLength(1);
      expect(r.room.s.orders[0]).toMatchObject({ productId: product, units: 2, state: 'pricing' });
      expect(r.room.s.orders[0]?.reason).toContain('fills the board');
      expect(r.room.product(product)?.capacity).toBe(stock);
    }
  });

  it('stocking up raises the capacity and the reorder point with it, live', async () => {
    const r = await built();
    await see(r, { 'z-9v': 8 });
    expect(r.room.product('p-9v')?.capacity).toBe(8);
    expect(r.room.policy('p-9v')?.reorderPoint).toBe(6);
    expect(r.room.s.activity.at(-1)?.text).toBe('5 units of 9v batteries added. 8 on the board.');
    expect(r.room.s.orders).toHaveLength(0);
    await see(r, { 'z-9v': 7 });
    expect(r.room.s.orders).toHaveLength(0);
    await see(r, { 'z-9v': 6 });
    expect(r.room.s.orders[0]).toMatchObject({ productId: 'p-9v', units: 2 });
    // Fewer on the ledge is use, never a smaller ledge.
    expect(r.room.product('p-9v')?.capacity).toBe(8);
  });

  it('one unit on a ledge is counted and never reordered', async () => {
    const r = await built({ 'z-washers': 1, 'z-bolts': 2 });
    expect(r.room.policy('p-washers')).toMatchObject({ reorderPoint: 0, ratePerDay: 0 });
    expect(r.room.policy('p-bolts')?.reorderPoint).toBe(1);
    await see(r, { 'z-washers': 0 });
    expect(r.room.s.orders).toHaveLength(0);
    await see(r, { 'z-bolts': 1 });
    expect(r.room.s.orders[0]).toMatchObject({ productId: 'p-bolts', units: 1 });
  });

  it('reset takes what is on each ledge as full, and parts put back after it count again', async () => {
    const r = await built({ 'z-washers': 3, 'z-bolts': 3, 'z-wax': 6, 'z-9v': 8 });
    await see(r, { 'z-9v': 6 });
    expect(r.room.s.orders).toHaveLength(1);
    // Reset is pressed before the two batteries are back.
    await r.call('POST', '/api/demo/reset', undefined, OPS);
    expect(r.room.s.orders).toHaveLength(0);
    expect(r.room.product('p-9v')?.capacity).toBe(6);
    expect(r.room.policy('p-9v')?.reorderPoint).toBe(4);
    await see(r, { 'z-9v': 8 });
    expect(r.room.product('p-9v')?.capacity).toBe(8);
    expect(r.room.policy('p-9v')?.reorderPoint).toBe(6);
    expect(r.room.s.orders).toHaveLength(0);
    // The stock was cut down on purpose, then reset: the smaller amount is the full ledge now.
    await see(r, { 'z-wax': 4 });
    await r.call('POST', '/api/demo/reset', undefined, OPS);
    expect(r.room.product('p-wax')?.capacity).toBe(4);
    expect(r.room.policy('p-wax')?.reorderPoint).toBe(2);
    await see(r, { 'z-wax': 2 });
    expect(r.room.s.orders.map((o) => [o.productId, o.units])).toEqual([['p-wax', 2]]);
  });

  it('a ledge that is empty at reset holds nothing known, so the first restock is not a reorder', async () => {
    const r = await built({ 'z-9v': 6 });
    await see(r, { 'z-9v': 0 });
    await r.call('POST', '/api/demo/reset', undefined, OPS);
    expect(r.room.product('p-9v')?.capacity).toBeNull();
    expect(r.room.policy('p-9v')?.reorderPoint).toBe(0);
    await see(r, { 'z-9v': 3 });
    expect(r.room.s.orders).toHaveLength(0);
    expect(r.room.product('p-9v')?.capacity).toBe(3);
    expect(r.room.policy('p-9v')?.reorderPoint).toBe(1);
  });

  it('the season switch still moves the line', async () => {
    const r = await built({ 'z-9v': 6 });
    expect(r.room.policy('p-9v')?.reorderPoint).toBe(4);
    await r.call('POST', '/api/demo/season', { factor: 1.4, label: 'Busy' }, OPS);
    expect(r.room.policy('p-9v')?.reorderPoint).toBe(5);
    await r.call('POST', '/api/demo/season', { factor: 0.6, label: 'Slow' }, OPS);
    expect(r.room.policy('p-9v')?.reorderPoint).toBe(3);
  });

  it('the chart has 30 sample days that stay between empty and full', async () => {
    const r = await built({ 'z-9v': 6 });
    const history = historyResult(r.room, 'p-9v');
    expect(history?.days).toHaveLength(30);
    expect(history?.days.every((d) => d.sample && d.endCount >= 0 && d.endCount <= 6)).toBe(true);
    expect(history?.days.at(-1)?.endCount).toBe(6);
    expect(history?.reorderPoint).toBe(4);
    expect(history?.days.some((d) => d.endCount <= 4)).toBe(true);
  });

  it('setting the board again keeps what the cameras count on ledges that stay', async () => {
    const r = await built({ 'z-washers': 5, 'z-9v': 7 });
    const body = structuredClone(BOARD);
    body.zones = body.zones.filter((z) => z.id !== 'z-bolts');
    body.products = body.products.filter((p) => p.id !== 'p-bolts');
    body.zones[0] = { ...body.zones[0]!, quad: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.3], [0.1, 0.3]] };
    const snap = Snapshot.parse(await (await r.call('PUT', '/api/board', body, OPS)).json());
    expect(snap.counts.map((c) => [c.productId, c.count]).sort()).toEqual([['p-9v', 7], ['p-washers', 5]]);
    expect(snap.products.map((p) => [p.id, p.capacity])).toEqual([['p-washers', 5], ['p-wax', null], ['p-9v', 7]]);
    expect(snap.policies.find((p) => p.productId === 'p-9v')?.reorderPoint).toBe(5);
    expect(r.room.x.usage['p-bolts']).toBeUndefined();
  });
});
