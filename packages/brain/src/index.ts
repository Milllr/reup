// The reorder brain. Pure functions, no I/O. Everything the hub and the screens say about
// rates, reorder points, order sizes and cover comes from here, so the numbers always agree.
import type { CatalogPack, Policy, Quote, Supplier } from '@reup/contracts';

/** Safety factor. 1.65 is about a 95 percent chance of not running out. */
export const Z = 1.65;
/** How often the board is looked at, in days. The cameras look all the time; 1 keeps a margin. */
export const REVIEW_DAYS = 1;
/** An order covers this many days of use. */
export const HORIZON_DAYS = 14;
export const ALPHA = 0.3;

/**
 * Units used per day: the exponentially weighted mean of daily use, newest day weighted most.
 * dailyUse is oldest first and holds completed days only, so a pick today does not move the rate today.
 */
export function ratePerDay(dailyUse: readonly number[], alpha = ALPHA): number {
  let weighted = 0;
  let weights = 0;
  let w = alpha;
  for (let i = dailyUse.length - 1; i >= 0; i--) {
    weighted += w * (dailyUse[i] ?? 0);
    weights += w;
    w *= 1 - alpha;
  }
  return weights === 0 ? 0 : weighted / weights;
}

/** d is use per day after the season factor. */
export function reorderPoint(d: number, leadDays: number, reviewDays = REVIEW_DAYS, z = Z, capacity: number | null = null): number {
  // A part nobody uses is never reordered. This is what keeps a part that was only just taught off the reorder list.
  if (!(d > 0)) return 0;
  const demand = d * (leadDays + reviewDays);
  let point = Math.ceil(demand + z * Math.sqrt(demand));
  point = Math.max(1, point);
  if (capacity != null) point = Math.min(point, Math.max(1, capacity - 1));
  return point;
}

export function orderQty(d: number, capacity: number | null = null, count: number | null = null): number {
  let qty = Math.max(1, Math.ceil(Math.max(0, d) * HORIZON_DAYS));
  if (capacity != null && count != null) qty = Math.min(qty, capacity - count);
  return Math.max(1, qty);
}

export function daysOfCover(count: number, d: number): number | null {
  return d > 0 ? count / d : null;
}

const one = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const dayWord = (n: number) => (n === 1 ? 'day' : 'days');

export function reasonText(d: number, leadDays: number, point: number): string {
  return `Uses about ${one(d)} a day. Delivery takes ${leadDays} ${dayWord(leadDays)}. Reorder at ${point}.`;
}

export function coverText(days: number | null): string {
  if (days == null) return 'Not in use yet';
  if (days < 14) {
    const n = Math.max(1, Math.round(days));
    return `${n} ${dayWord(n)} of cover`;
  }
  return `${Math.round(days / 7)} weeks of cover`;
}

/** "box of 100" is a box. "each" is a unit. */
export function unitWord(unit: string): string {
  const first = unit.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return first === '' || first === 'each' ? 'unit' : first;
}

export function plural(word: string, n: number): string {
  if (n === 1) return word;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/** "8 boxes", "1 bag", "2 units". The word on the Order screen. */
export function unitsText(n: number, unit: string): string {
  return `${n} ${plural(unitWord(unit), n)}`;
}

export const money = (n: number) => `$${n.toFixed(2)}`;

/** Compares the cheapest good market quote with the account price, per unit. Null when no market quote is ok. */
export function marketNote(accountUnitPrice: number | null, quotes: readonly Quote[], suppliers: readonly Supplier[], unit: string): string | null {
  if (accountUnitPrice == null) return null;
  const market = new Map(suppliers.filter((s) => s.kind === 'market').map((s) => [s.id, s]));
  let best: { name: string; unitPrice: number } | null = null;
  for (const q of quotes) {
    const supplier = market.get(q.supplierId);
    if (!supplier || !q.ok || q.unitPrice == null) continue;
    if (!best || q.unitPrice < best.unitPrice) best = { name: supplier.name, unitPrice: q.unitPrice };
  }
  if (!best) return null;
  const diff = Math.round((best.unitPrice - accountUnitPrice) * 100) / 100;
  const word = unitWord(unit);
  if (diff === 0) return `${best.name} is the same price per ${word}.`;
  return `${best.name} is ${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} per ${word}.`;
}

export interface PackChoice {
  pack: CatalogPack;
  /** How many of that pack to buy. */
  packs: number;
  /** Units that arrive. */
  units: number;
  total: number;
}

/** The pack option with the lowest total for at least that many units. On a tie, the one with fewer spare units. */
export function packsFor(units: number, packs: readonly CatalogPack[]): PackChoice | null {
  let best: PackChoice | null = null;
  for (const pack of packs) {
    const n = Math.max(1, Math.ceil(units / pack.size));
    const choice: PackChoice = { pack, packs: n, units: n * pack.size, total: Math.round(n * pack.price * 100) / 100 };
    if (!best || choice.total < best.total || (choice.total === best.total && choice.units < best.units)) best = choice;
  }
  return best;
}

/** The one line of reason on the order card. */
export function orderReason(units: number, unit: string, count: number, capacity: number | null, cover: number | null, leadDays: number): string {
  const fills = capacity != null && count + units >= capacity;
  const first = fills ? 'fills the board' : `covers ${HORIZON_DAYS} days`;
  const second = cover == null || cover >= leadDays ? 'arrives before it runs out' : `arrives in ${leadDays} ${dayWord(leadDays)}`;
  return `${unitsText(units, unit)} ${first} and ${second}.`;
}

export interface ForecastDay {
  /** Days from today, 1 is tomorrow. */
  offset: number;
  expected: number;
  low: number;
  high: number;
}

/** Expected stock for the next days, with a band that widens. An arriving order lifts it on its day. */
export function forecast(count: number, d: number, days = 7, capacity: number | null = null, arrival: { offset: number; units: number } | null = null): ForecastDay[] {
  const out: ForecastDay[] = [];
  const cap = (n: number) => (capacity == null ? n : Math.min(capacity, n));
  const r = (n: number) => Math.round(n * 100) / 100;
  let extra = 0;
  for (let k = 1; k <= days; k++) {
    if (arrival && arrival.offset === k) extra = arrival.units;
    const spread = Z * Math.sqrt(Math.max(0, d) * k);
    const mid = count - d * k + extra;
    out.push({ offset: k, expected: r(cap(Math.max(0, mid))), low: r(cap(Math.max(0, mid - spread))), high: r(cap(Math.max(0, mid + spread))) });
  }
  return out;
}

export interface PolicyInput {
  productId: string;
  /** Completed days, oldest first. */
  dailyUse: readonly number[];
  seasonFactor: number;
  leadDays: number;
  reviewDays?: number;
  z?: number;
  capacity: number | null;
  count: number;
  sampleHistory: boolean;
  /** ISO time with an offset. */
  now: string;
}

export function policyFor(input: PolicyInput): Policy {
  const reviewDays = input.reviewDays ?? REVIEW_DAYS;
  const z = input.z ?? Z;
  const rate = ratePerDay(input.dailyUse);
  const d = rate * input.seasonFactor;
  const point = reorderPoint(d, input.leadDays, reviewDays, z, input.capacity);
  return {
    productId: input.productId,
    ratePerDay: Math.round(rate * 1000) / 1000,
    seasonFactor: input.seasonFactor,
    leadDays: input.leadDays,
    reviewDays,
    z,
    reorderPoint: point,
    orderQty: orderQty(d, input.capacity, input.count),
    daysOfCover: daysOfCover(input.count, d),
    reason: reasonText(d, input.leadDays, point),
    sampleHistory: input.sampleHistory,
    updatedAt: input.now,
  };
}
