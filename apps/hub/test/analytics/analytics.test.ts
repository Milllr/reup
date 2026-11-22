import { AnalyticsResult, BoardBody } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import board from '../../../../contracts/mocks/board.json';
import catalogMock from '../../../../contracts/mocks/catalog.json';
import { TRAIL_MAX } from '../../src/core/room';
import { APPROVE, count, DEVICE, OPS, rig, toAwaiting, type Rig } from '../helpers';

const BOARD = BoardBody.parse(board);
const catalogFetch = (async () => new Response(JSON.stringify(catalogMock))) as unknown as typeof fetch;

const read = async (r: Rig) => AnalyticsResult.parse(await (await r.call('GET', '/api/analytics')).json());

async function see(r: Rig, counts: Record<string, number>): Promise<void> {
  r.advance(1000);
  await r.call('POST', '/ingest/counts', { counts: Object.entries(counts).map(([zone, n]) => count(r, zone, n)) }, DEVICE);
}

/** The station as built, stocked, with the store's catalog and a buyer connected. */
async function built(): Promise<Rig> {
  const r = await rig({}, { fetch: catalogFetch });
  r.room.setBuyerOnline(true);
  expect((await r.call('PUT', '/api/board', BOARD, OPS)).status).toBe(200);
  await see(r, { 'z-washers': 3, 'z-bolts': 3, 'z-wax': 4, 'z-9v': 3 });
  return r;
}

describe('analytics', () => {
  it('answers without a token with every part on the board: 30 days behind, 60 days ahead', async () => {
    const r = await rig();
    const res = await r.call('GET', '/api/analytics');
    expect(res.status).toBe(200);
    const a = AnalyticsResult.parse(await res.json());
    expect(a.today).toBe('2026-11-21');
    expect(a.parts.map((p) => p.productId).sort()).toEqual(r.room.s.products.filter((p) => p.zoneId != null).map((p) => p.id).sort());
    for (const part of a.parts) {
      expect(part.days).toHaveLength(30);
      expect(part.days[0]?.day).toBe('2026-10-22');
      expect(part.days.at(-1)?.day).toBe('2026-11-20');
      expect(part.days.every((d) => d.sample)).toBe(true);
      expect(part.projection).toHaveLength(60);
      expect(part.projection[0]?.day).toBe('2026-11-22');
      expect(part.projection.at(-1)?.day).toBe('2027-01-20');
      expect(part.projection.every((d) => d.low <= d.expected && d.expected <= d.high && (part.capacity == null || d.high <= part.capacity))).toBe(true);
      expect(part.today).toEqual({ used: 0, restocked: 0 });
    }
    expect(a.trail).toEqual([]);
    expect(a.placed).toEqual([]);
  });

  it('says when a ledge part is next ordered, when it would run out, and what a unit costs', async () => {
    const r = await built();
    const a = await read(r);
    const bolts = a.parts.find((p) => p.productId === 'p-bolts');
    expect(bolts).toMatchObject({ name: 'Hex bolts 3/4 x 3 in', count: 3, capacity: 3, reorderPoint: 1, leadDays: 2 });
    expect(bolts?.ratePerDay).toBeGreaterThan(0);
    // A ledge of 3 that is reordered at 1 turns over about once a month: the order falls inside the 60 days, and empty comes after it.
    const order = bolts?.projection.find((d) => d.ordered > 0);
    expect(bolts?.reorderOn).toBe(order?.day);
    expect(order?.ordered).toBe(2); // fills the ledge of 3 from 1
    const lands = bolts?.projection.find((d) => d.arrives > 0);
    expect(lands?.arrives).toBe(2);
    expect(Date.parse(`${lands?.day}T12:00:00Z`) - Date.parse(`${order?.day}T12:00:00Z`)).toBe(2 * 86_400_000);
    expect((bolts?.runsOutOn ?? '') > (bolts?.reorderOn ?? '')).toBe(true);
    expect(bolts?.daysOfCover).toBeGreaterThan(30);
    // The sample month behind it shows the ledge dipping and coming back, never empty.
    expect(bolts?.days.every((d) => d.endCount >= 1 && d.endCount <= 3)).toBe(true);
    expect(bolts?.days.some((d) => d.restocked > 0) && bolts?.days.at(-1)?.endCount === 3).toBe(true);
    // No quote yet: the price is the store catalog's.
    const listed = catalogMock.items.find((item) => item.sku === 'OC-1475');
    expect(bolts?.unitPrice).toBe(Math.round(((listed?.packs[0]?.price ?? 0) / (listed?.packs[0]?.size ?? 1)) * 100) / 100);
  });

  it('keeps the trail of the day and today\'s use, and an open order shows as an arrival, not as a day to reorder', async () => {
    const r = await built();
    await see(r, { 'z-bolts': 1 });
    const a = await read(r);
    const bolts = a.parts.find((p) => p.productId === 'p-bolts');
    expect(a.trail.filter((t) => t.productId === 'p-bolts').at(-1)).toMatchObject({ delta: -2, countAfter: 1 });
    expect(bolts?.today).toEqual({ used: 2, restocked: 0 });
    expect(r.room.openOrderFor('p-bolts')).toBeTruthy();
    expect(bolts?.reorderOn).toBeNull();
    expect(bolts?.projection.find((d) => d.arrives > 0)?.arrives).toBe(2);
    // Put back: the use of today is taken back, and the trail keeps both moves.
    await see(r, { 'z-bolts': 3 });
    const b = await read(r);
    expect(b.parts.find((p) => p.productId === 'p-bolts')?.today).toEqual({ used: 0, restocked: 0 });
    expect(b.trail.filter((t) => t.productId === 'p-bolts').map((t) => t.delta).slice(-2)).toEqual([-2, 2]);
  });

  it('the trail holds the last 24 hours and at most 400 changes', async () => {
    const r = await built();
    for (let i = 0; i < TRAIL_MAX / 2 + 20; i++) {
      await see(r, { 'z-wax': 3 });
      await see(r, { 'z-wax': 4 });
    }
    expect(r.room.x.trail).toHaveLength(TRAIL_MAX);
    expect((await read(r)).trail).toHaveLength(TRAIL_MAX);
    r.advance(25 * 60 * 60 * 1000);
    expect((await read(r)).trail).toEqual([]);
  });

  it('remembers every order placed, with its part\'s name, through a demo reset', async () => {
    const r = await rig();
    const id = await toAwaiting(r);
    await r.call('POST', `/api/orders/${id}/approve`, { by: 'keyboard' }, APPROVE);
    await r.call('POST', '/ingest/placed', { jobId: 'j', orderId: id, ok: true, confirmation: 'OC-58213', eta: null, error: null }, DEVICE);
    const before = await read(r);
    expect(before.placed).toEqual([{ poNumber: 'RU-1042', productId: 'p-screws', name: 'Wood screws #8 x 1-1/4 in', units: 8, total: 67.71, confirmation: 'OC-58213', ts: r.room.iso() }]);
    // The price of a unit now comes from the cart's quote.
    expect(before.parts.find((p) => p.productId === 'p-screws')?.unitPrice).toBe(7.49);
    expect((await r.call('POST', '/api/demo/reset', {}, OPS)).status).toBe(200);
    const after = await read(r);
    expect(after.placed).toEqual(before.placed);
    expect(after.trail.length).toBe(before.trail.length);
    expect(after.trail.length).toBeGreaterThan(0);
    expect(r.room.s.orders).toEqual([]);
  });
});
