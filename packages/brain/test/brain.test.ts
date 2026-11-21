import { describe, expect, it } from 'vitest';
import { Policy, type Quote, type Supplier } from '@reup/contracts';
import { coverText, daysOfCover, forecast, marketNote, orderQty, orderReason, packsFor, policyFor, ratePerDay, reasonText, reorderPoint, unitsText, unitWord } from '../src/index';

const now = '2026-11-21T09:14:00-05:00';
const supplier = (id: string, name: string, kind: 'account' | 'market'): Supplier => ({ id, name, kind, baseUrl: 'https://example.com', searchUrl: 'https://example.com/s?q={q}', country: 'CA' });
const quote = (supplierId: string, unitPrice: number | null, ok = true): Quote => ({ id: `q-${supplierId}`, productId: 'p', supplierId, listingName: null, packSize: 1, price: unitPrice, currency: 'CAD', unitPrice, inStock: true, deliveryDays: 3, url: null, runId: null, ok, fetchedAt: now });

describe('ratePerDay', () => {
  it('is the daily use when use is constant', () => expect(ratePerDay([2, 2, 2, 2, 2])).toBeCloseTo(2));
  it('weighs a recent spike more than an old one', () => expect(ratePerDay([0, 0, 0, 0, 5])).toBeGreaterThan(ratePerDay([5, 0, 0, 0, 0])));
  it('is 0 for an empty history', () => expect(ratePerDay([])).toBe(0));
});

describe('reorderPoint', () => {
  it('matches the worked examples', () => {
    expect(reorderPoint(0.56, 2, 1)).toBe(4);
    expect(reorderPoint(2.1, 1, 1)).toBe(8);
    expect(reorderPoint(2.1, 1, 1, 1.65, 6)).toBe(5);
  });
  it('is at least 1', () => expect(reorderPoint(0, 2, 1)).toBe(1));
});

describe('orderQty', () => {
  it('covers 14 days', () => expect(orderQty(0.56)).toBe(8));
  it('caps at the free space on the board', () => expect(orderQty(2.1, 12, 8)).toBe(4));
  it('is at least 1', () => expect(orderQty(0, 6, 6)).toBe(1));
});

describe('cover', () => {
  it('divides the count by the rate, null when unused', () => {
    expect(daysOfCover(4, 0.56)).toBeCloseTo(7.14, 2);
    expect(daysOfCover(4, 0)).toBeNull();
  });
  it('says days under two weeks and weeks from there', () => {
    expect(coverText(7.14)).toBe('7 days of cover');
    expect(coverText(0.2)).toBe('1 day of cover');
    expect(coverText(28.4)).toBe('4 weeks of cover');
    expect(coverText(null)).toBe('Not in use yet');
  });
});

describe('words', () => {
  it('reason, plural and singular', () => {
    expect(reasonText(0.56, 2, 4)).toBe('Uses about 0.6 a day. Delivery takes 2 days. Reorder at 4.');
    expect(reasonText(2.1, 1, 8)).toBe('Uses about 2.1 a day. Delivery takes 1 day. Reorder at 8.');
  });
  it('unit words', () => {
    expect(unitWord('box of 100')).toBe('box');
    expect(unitWord('each')).toBe('unit');
    expect(unitsText(8, 'box of 100')).toBe('8 boxes');
    expect(unitsText(3, 'bag of 4')).toBe('3 bags');
    expect(unitsText(2, 'each')).toBe('2 units');
    expect(unitsText(1, 'pack of 10')).toBe('1 pack');
  });
  it('order reason', () => {
    expect(orderReason(8, 'box of 100', 4, 12, 7.1, 2)).toBe('8 boxes fills the board and arrives before it runs out.');
    expect(orderReason(3, 'bag of 4', 1, null, 1, 3)).toBe('3 bags covers 14 days and arrives in 3 days.');
  });
});

describe('marketNote', () => {
  const suppliers = [supplier('offcut', 'Offcut Supply', 'account'), supplier('a', 'Retailer A', 'market'), supplier('b', 'Retailer B', 'market')];
  it('more', () => expect(marketNote(7.49, [quote('a', 8.69), quote('b', 9.99)], suppliers, 'box of 100')).toBe('Retailer A is $1.20 more per box.'));
  it('less', () => expect(marketNote(7.49, [quote('a', 6.99)], suppliers, 'box of 100')).toBe('Retailer A is $0.50 less per box.'));
  it('equal', () => expect(marketNote(7.49, [quote('a', 7.49)], suppliers, 'each')).toBe('Retailer A is the same price per unit.'));
  it('none when no market quote is ok', () => {
    expect(marketNote(7.49, [quote('a', 8.69, false), quote('offcut', 1)], suppliers, 'box of 100')).toBeNull();
    expect(marketNote(null, [quote('a', 8.69)], suppliers, 'box of 100')).toBeNull();
  });
});

describe('packsFor', () => {
  const packs = [{ label: 'Box of 100', size: 1, price: 7.49 }, { label: 'Case of 10 boxes', size: 10, price: 64.9 }];
  it('buys singles for a small order', () => expect(packsFor(8, packs)).toMatchObject({ packs: 8, units: 8, total: 59.92 }));
  it('prefers a case when it is cheaper', () => expect(packsFor(9, packs)).toMatchObject({ packs: 1, units: 10, total: 64.9 }));
  it('is null with no packs', () => expect(packsFor(3, [])).toBeNull());
});

describe('forecast', () => {
  it('falls by the rate and never goes under zero', () => {
    const days = forecast(4, 0.56, 7, 12);
    expect(days).toHaveLength(7);
    expect(days[0]?.expected).toBeCloseTo(3.44);
    expect(days.every((d) => d.low >= 0 && d.low <= d.expected && d.expected <= d.high && d.high <= 12)).toBe(true);
  });
  it('rises on the day an order arrives', () => {
    const days = forecast(4, 0.56, 7, 12, { offset: 3, units: 8 });
    expect(days[2]?.expected).toBeGreaterThan(days[1]?.expected ?? 0);
  });
});

describe('policyFor', () => {
  it('returns a whole, valid Policy', () => {
    const policy = policyFor({ productId: 'p-screws', dailyUse: Array.from({ length: 30 }, (_, i) => i % 2), seasonFactor: 1, leadDays: 2, capacity: 12, count: 4, sampleHistory: true, now });
    expect(Policy.parse(policy)).toEqual(policy);
    expect(policy.reorderPoint).toBe(4);
    expect(policy.orderQty).toBe(8);
  });
  it('a busy season raises the reorder point', () => {
    const base = { productId: 'p', dailyUse: [1, 0, 1, 0, 1, 0, 1], leadDays: 2, capacity: 12, count: 6, sampleHistory: false, now };
    expect(policyFor({ ...base, seasonFactor: 1.4 }).reorderPoint).toBeGreaterThan(policyFor({ ...base, seasonFactor: 1 }).reorderPoint);
  });
});
