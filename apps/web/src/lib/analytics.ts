// What the Analytics page says, worked out from one AnalyticsResult. No drawing here, so every number can be tested.
import { unitsText } from '@reup/brain';
import type { AnalyticsPart, AnalyticsResult } from '@reup/contracts';
import { TIME_ZONE } from './view';

const A_DAY = 86_400_000;
const noon = (day: string) => Date.parse(`${day}T12:00:00Z`);

/** Whole days from one local day to another. */
export const daysBetween = (from: string, to: string) => Math.round((noon(to) - noon(from)) / A_DAY);

/** "Tue Nov 24" for a local day. */
export function dayLabel(day: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(noon(day))).replace(',', '');
}

/** "Nov 24" */
export const shortDay = (day: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(noon(day)));

/** "in 12 days", "tomorrow", "today" */
export function inDays(n: number): string {
  if (n <= 0) return 'today';
  return n === 1 ? 'tomorrow' : `in ${n} days`;
}

const sum = (list: readonly number[]) => list.reduce((a, b) => a + b, 0);
export const money = (n: number) => `$${n.toFixed(2)}`;

export interface Totals {
  parts: number;
  units: number;
  /** What the board holds when every ledge is full. Null when any part has no known capacity. */
  holds: number | null;
  usedToday: number;
  /** The last 7 days, today included, and the 7 before them. */
  used7: number;
  usedBefore7: number;
  used30: number;
  /** Parts at or under their reorder point, and whether an order for each is already on its way. */
  low: { part: AnalyticsPart; coming: boolean }[];
  /** The part that reaches empty first if nothing more came in. */
  firstOut: { part: AnalyticsPart; day: string; days: number } | null;
  /** What reup expects to order in the days ahead, by its own rule. */
  ahead: { orders: number; units: number; cost: number | null; days: number };
  /** Orders placed so far, and what they came to. */
  placed: { orders: number; total: number };
  /** True when any of the 30 days behind today is sample history. */
  sample: boolean;
}

export function totals(a: AnalyticsResult): Totals {
  const last = (part: AnalyticsPart, n: number, skip = 0) => sum(part.days.slice(part.days.length - n - skip, part.days.length - skip).map((d) => d.used));
  const out = a.parts
    .flatMap((part) => (part.runsOutOn ? [{ part, day: part.runsOutOn, days: daysBetween(a.today, part.runsOutOn) }] : []))
    .sort((x, y) => x.days - y.days)[0];
  const orders = a.parts.flatMap((part) => part.projection.filter((d) => d.ordered > 0).map((d) => ({ units: d.ordered, cost: part.unitPrice == null ? null : d.ordered * part.unitPrice })));
  return {
    parts: a.parts.length,
    units: sum(a.parts.map((p) => p.count)),
    holds: a.parts.every((p) => p.capacity != null) ? sum(a.parts.map((p) => p.capacity ?? 0)) : null,
    usedToday: sum(a.parts.map((p) => p.today.used)),
    used7: sum(a.parts.map((p) => p.today.used + last(p, 6))),
    usedBefore7: sum(a.parts.map((p) => last(p, 7, 6))),
    used30: sum(a.parts.map((p) => p.today.used + last(p, 29))),
    low: a.parts.flatMap((part) => { const st = standing(part, a.today); return st === 'fine' ? [] : [{ part, coming: st === 'coming' }]; }),
    firstOut: out ?? null,
    ahead: {
      orders: orders.length,
      units: sum(orders.map((o) => o.units)),
      cost: orders.some((o) => o.cost == null) ? null : Math.round(sum(orders.map((o) => o.cost ?? 0)) * 100) / 100,
      days: a.parts[0]?.projection.length ?? 0,
    },
    placed: { orders: a.placed.length, total: Math.round(sum(a.placed.map((p) => p.total ?? 0)) * 100) / 100 },
    sample: a.parts.some((p) => p.days.some((d) => d.sample)),
  };
}

/** "2 more than the week before", "the same as the week before" */
export function weekChange(now: number, before: number): string {
  if (now === before) return 'The same as the week before';
  return `${Math.abs(now - before)} ${now > before ? 'more' : 'fewer'} than the week before`;
}

/** The delivery that is already on its way to a part, if one is. reorderOn is null exactly when an order is open or none is needed. */
export function coming(part: AnalyticsPart, today: string): { day: string; units: number } | null {
  if (part.reorderOn != null) return null;
  const next = part.projection.find((d) => d.arrives > 0);
  const firstOrder = part.projection.find((d) => d.ordered > 0);
  // A delivery with no order before it in the days ahead was ordered already.
  return next && (!firstOrder || firstOrder.day > next.day) && daysBetween(today, next.day) >= 0 ? { day: next.day, units: next.arrives } : null;
}

/** At or under its reorder point. low: and nothing is on its way yet. */
export function standing(part: AnalyticsPart, today: string): 'fine' | 'coming' | 'low' {
  if (!(part.ratePerDay > 0) || part.count > part.reorderPoint) return 'fine';
  return coming(part, today) ? 'coming' : 'low';
}

/** One line for a part: where it stands and what happens next. */
export function partLine(part: AnalyticsPart, today: string): string {
  if (!(part.ratePerDay > 0)) return 'Counted. Not in use yet, so nothing is ordered.';
  const due = coming(part, today);
  if (due) return `${unitsText(due.units, part.unit)} on the way, here ${dayLabel(due.day)}.`;
  if (part.reorderOn) return `Next order ${inDays(daysBetween(today, part.reorderOn))}, ${dayLabel(part.reorderOn)}. Without it the ledge is empty ${dayLabel(part.runsOutOn ?? part.reorderOn)}.`;
  return `No order needed in the next ${part.projection.length} days.`;
}

/** The same for a table cell. */
export function nextOrder(part: AnalyticsPart, today: string): string {
  if (!(part.ratePerDay > 0)) return 'Not in use';
  const due = coming(part, today);
  if (due) return `On its way, here ${dayLabel(due.day)}`;
  return part.reorderOn ? `${dayLabel(part.reorderOn)}, ${inDays(daysBetween(today, part.reorderOn))}` : 'Not needed yet';
}

// ---------- the stock chart: 30 days behind, today, the days ahead ----------

export const BOX = { w: 900, h: 380, x0: 16, x1: 884, y0: 326, top: 66 } as const;

export interface Column {
  day: string;
  /** behind: a day that is over. today: now. ahead: expected. */
  when: 'behind' | 'today' | 'ahead';
  /** What the board held at the end of the day, holds now, or is expected to hold. */
  stock: number;
  low: number;
  high: number;
  used: number;
  ordered: number;
  arrives: number;
  sample: boolean;
}

export function columns(part: AnalyticsPart, today: string): Column[] {
  return [
    ...part.days.map((d): Column => ({ day: d.day, when: 'behind', stock: d.endCount, low: d.endCount, high: d.endCount, used: d.used, ordered: 0, arrives: d.restocked, sample: d.sample })),
    { day: today, when: 'today', stock: part.count, low: part.count, high: part.count, used: part.today.used, ordered: 0, arrives: part.today.restocked, sample: false },
    ...part.projection.map((d): Column => ({ day: d.day, when: 'ahead', stock: d.expected, low: d.low, high: d.high, used: 0, ordered: d.ordered, arrives: d.arrives, sample: false })),
  ];
}

export function scale(part: AnalyticsPart, cols: readonly Column[]) {
  const max = Math.max(1, part.capacity ?? 0, part.reorderPoint, ...cols.map((c) => c.high));
  const step = (BOX.x1 - BOX.x0) / Math.max(1, cols.length - 1);
  const unit = (BOX.y0 - BOX.top) / max;
  const r = (n: number) => Math.round(n * 10) / 10;
  return { max, step, x: (i: number) => r(BOX.x0 + i * step), y: (v: number) => r(BOX.y0 - v * unit), at: (px: number) => Math.max(0, Math.min(cols.length - 1, Math.round((px - BOX.x0) / step))) };
}

/** A stepped line through whole counts: the board holds a count through a day and changes at the next. */
export function stepped(points: readonly [number, number][]): string {
  const out: string[] = [];
  points.forEach(([x, y], i) => {
    const before = points[i - 1];
    if (before && before[1] !== y) out.push(`${x},${before[1]}`);
    if (!before || before[1] !== y || i === points.length - 1) out.push(`${x},${y}`);
  });
  return out.join(' ');
}

/** What the tooltip says for one column, most important line first. */
export function describe(col: Column, part: AnalyticsPart): string[] {
  const lines = [col.when === 'today' ? `Today, ${shortDay(col.day)}` : dayLabel(col.day)];
  if (col.when === 'ahead') lines.push(col.low === col.high ? `${col.stock} expected` : `${col.stock} expected, ${col.low} to ${col.high}`);
  else lines.push(`${col.stock} on the board${col.sample ? ', sample' : ''}`);
  if (col.used > 0) lines.push(`${unitsText(col.used, part.unit)} used`);
  if (col.arrives > 0) lines.push(`${unitsText(col.arrives, part.unit)} ${col.when === 'ahead' ? 'arrive' : 'came in'}`);
  if (col.ordered > 0) lines.push(`reup orders ${unitsText(col.ordered, part.unit)}`);
  return lines;
}

// ---------- today, from the trail ----------

const hourIn = (iso: string) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)));
const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(iso));

/** "9 AM", "12 PM" */
export const hourLabel = (hour: number) => `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;

/** Units taken off the board in each hour of today, from the first hour anything moved to the hour it is now. */
export function byHour(a: AnalyticsResult): { hour: number; taken: number; back: number }[] {
  const today = a.trail.filter((t) => dayOf(t.ts) === a.today);
  if (today.length === 0) return [];
  const nowHour = hourIn(a.now);
  const first = Math.min(nowHour, ...today.map((t) => hourIn(t.ts)));
  const out = Array.from({ length: nowHour - first + 1 }, (_, i) => ({ hour: first + i, taken: 0, back: 0 }));
  for (const t of today) {
    const slot = out[hourIn(t.ts) - first];
    if (!slot) continue;
    if (t.delta < 0) slot.taken += -t.delta;
    else slot.back += t.delta;
  }
  return out;
}

/** "6:02 PM" */
export const timeOf = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** The newest changes first, each as plain words. */
export function feed(a: AnalyticsResult, limit = 10): { ts: string; time: string; name: string; what: string; left: string }[] {
  const names = new Map(a.parts.map((p) => [p.productId, p]));
  return [...a.trail].reverse().flatMap((t) => {
    const part = names.get(t.productId);
    if (!part) return [];
    const n = Math.abs(t.delta);
    return [{ ts: t.ts, time: timeOf(t.ts), name: part.name, what: t.delta < 0 ? `${n} taken` : `${n} back`, left: `${t.countAfter} on the board` }];
  }).slice(0, limit);
}

/** Parts by what they used in the last 30 days, most first. */
export function movers(a: AnalyticsResult): { part: AnalyticsPart; used: number; share: number }[] {
  const rows = a.parts.map((part) => ({ part, used: part.today.used + sum(part.days.slice(1).map((d) => d.used)) }));
  const most = Math.max(1, ...rows.map((r) => r.used));
  return rows.sort((x, y) => y.used - x.used || x.part.name.localeCompare(y.part.name)).map((r) => ({ ...r, share: r.used / most }));
}

/** Units used across every part on each of the last 30 days, today last. */
export function useByDay(a: AnalyticsResult): { day: string; used: number; today: boolean; sample: boolean }[] {
  const days = a.parts[0]?.days.slice(1).map((d) => d.day) ?? [];
  return [
    ...days.map((day) => ({ day, used: sum(a.parts.map((p) => p.days.find((d) => d.day === day)?.used ?? 0)), today: false, sample: a.parts.some((p) => p.days.find((d) => d.day === day)?.sample === true) })),
    { day: a.today, used: sum(a.parts.map((p) => p.today.used)), today: true, sample: false },
  ];
}
