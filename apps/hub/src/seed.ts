// The demo's starting state: suppliers, the four parts on the board, and 30 days of sample use.
// The sample is chosen so wood screws (capacity 12) use about 0.56 a day and reorder at 4.
// The demo starts with 6 on the board, so taking two boxes crosses the line.
import { Supplier, type Snapshot } from '@reup/contracts';
import buyerSuppliers from '../../../services/buyer/suppliers.json';
import type { Config } from './config';
import type { RoomCore } from './core/room';
import { daysBefore } from './core/time';

/** Daily use for the 30 days before today, oldest first, and the days a delivery arrived (index to units). */
export const SAMPLE: Record<string, { use: number[]; restock: Record<number, number>; leadDays: number }> = {
  'p-screws': { use: [1, 1, 0, 1, 0, 0, 1, 0, 0, 2, 2, 1, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 2, 1, 0, 1, 0, 0, 1], restock: { 8: 8, 21: 8 }, leadDays: 2 },
  'p-brackets': { use: at([3, 9, 15, 21, 27]), restock: { 16: 4 }, leadDays: 2 },
  'p-glue': { use: at([10, 25]), restock: {}, leadDays: 2 },
  'p-discs': { use: at([6, 13, 20, 27]), restock: { 28: 4 }, leadDays: 2 },
};

function at(days: number[]): number[] {
  return Array.from({ length: 30 }, (_, i) => (days.includes(i) ? 1 : 0));
}

/** Live retailers for price checks: the enabled entries of the buyer's list, so there is one file to edit.
 * MARKET_SUPPLIERS (a JSON array of Supplier) overrides it without a deploy. */
export const MARKET: Supplier[] = buyerSuppliers.filter((s) => s.enabled).map((s) => Supplier.parse(s));

export function suppliersFor(config: Config): Supplier[] {
  const offcut: Supplier = { id: 's-offcut', name: 'Offcut Supply', kind: 'account', baseUrl: config.SUPPLY_URL, searchUrl: `${config.SUPPLY_URL}/search?q={q}`, country: 'CA' };
  return [offcut, ...(config.MARKET_SUPPLIERS.length > 0 ? config.MARKET_SUPPLIERS : MARKET)];
}

const pockets = (full: number, total: number) => Array.from({ length: total }, (_, i) => i < full);

export function seedSnapshot(config: Config, now: string): Snapshot {
  return {
    now,
    screen: 'shelf',
    focusProductId: null,
    zones: [
      { id: 'z-screws', name: 'Wood screws', kind: 'pockets', camera: 'board', quad: [[0.04, 0.1], [0.56, 0.1], [0.56, 0.42], [0.04, 0.42]], rows: 2, cols: 6, productId: 'p-screws' },
      { id: 'z-brackets', name: 'Corner brackets', kind: 'pockets', camera: 'board', quad: [[0.62, 0.1], [0.9, 0.1], [0.9, 0.42], [0.62, 0.42]], rows: 2, cols: 3, productId: 'p-brackets' },
      { id: 'z-glue', name: 'Wood glue', kind: 'open', camera: 'board', quad: [[0.04, 0.55], [0.45, 0.55], [0.45, 0.92], [0.04, 0.92]], rows: null, cols: null, productId: 'p-glue' },
      { id: 'z-discs', name: 'Sanding discs', kind: 'open', camera: 'board', quad: [[0.51, 0.55], [0.9, 0.55], [0.9, 0.92], [0.51, 0.92]], rows: null, cols: null, productId: 'p-discs' },
      // The teach spot: a new part is put here, named, and then counted here.
      { id: 'z-teach', name: 'Teach spot', kind: 'open', camera: 'aux', quad: [[0.2, 0.15], [0.8, 0.15], [0.8, 0.85], [0.2, 0.85]], rows: null, cols: null, productId: null },
    ],
    products: [
      { id: 'p-screws', name: 'Wood screws #8 x 1-1/4 in', unit: 'box of 100', sku: 'OC-1008-114', zoneId: 'z-screws', capacity: 12, searchPhrase: '#8 x 1-1/4 wood screws box of 100', imageUrl: null, createdAt: now },
      { id: 'p-brackets', name: 'Corner brackets 2 in', unit: 'bag of 4', sku: 'OC-2202', zoneId: 'z-brackets', capacity: 6, searchPhrase: '2 inch corner bracket 4 pack', imageUrl: null, createdAt: now },
      { id: 'p-glue', name: 'Wood glue 473 mL', unit: 'each', sku: 'OC-3473', zoneId: 'z-glue', capacity: 4, searchPhrase: 'wood glue 473 ml', imageUrl: null, createdAt: now },
      { id: 'p-discs', name: 'Sanding discs 120 grit', unit: 'pack of 10', sku: 'OC-4120', zoneId: 'z-discs', capacity: 6, searchPhrase: '5 inch sanding discs 120 grit 10 pack', imageUrl: null, createdAt: now },
    ],
    counts: [
      { productId: 'p-screws', zoneId: 'z-screws', count: 6, level: null, pockets: pockets(6, 12), source: 'seed', ts: now },
      { productId: 'p-brackets', zoneId: 'z-brackets', count: 5, level: null, pockets: pockets(5, 6), source: 'seed', ts: now },
      { productId: 'p-glue', zoneId: 'z-glue', count: 3, level: null, pockets: null, source: 'seed', ts: now },
      { productId: 'p-discs', zoneId: 'z-discs', count: 6, level: null, pockets: null, source: 'seed', ts: now },
    ],
    policies: [],
    suppliers: suppliersFor(config),
    quotes: [],
    orders: [],
    runs: [],
    node: { online: false, level: 0, lastSeen: null, queued: 0, visionRestarts: 0, offlineSince: null },
    cameras: [],
    buyerOnline: false,
    teach: null,
    activity: [],
    season: { factor: 1, label: 'Normal' },
  };
}

/** Writes the sample over the 30 days before today for every seeded product. Real use on those days is replaced. */
export function applySampleHistory(room: RoomCore): void {
  const days = daysBefore(room.today(), 30);
  for (const [productId, sample] of Object.entries(SAMPLE)) {
    if (!room.product(productId)) continue;
    const byDay: RoomCore['x']['usage'][string] = {};
    const today = room.x.usage[productId]?.[room.today()];
    days.forEach((day, i) => {
      byDay[day] = { used: sample.use[i] ?? 0, restocked: sample.restock[i] ?? 0, sample: true };
    });
    if (today) byDay[room.today()] = today;
    room.x.usage[productId] = byDay;
    room.x.leadDays[productId] = sample.leadDays;
  }
}
