// History: the D1 log of what happened, and the 30 day view the Why screen draws.
import { forecast } from '@reup/brain';
import type { Count, HistoryResult, Order, PickEvent, Quote, Run } from '@reup/contracts';
import type { RoomCore } from '../core/room';
import { addDays, dayIn } from '../core/time';

/** Writes never block a request and never fail one. */
export interface History {
  count(c: Count): void;
  pick(p: PickEvent): void;
  order(o: Order): void;
  run(r: Run): void;
  quote(q: Quote): void;
}

export const noHistory: History = { count() {}, pick() {}, order() {}, run() {}, quote() {} };

/** The slice of D1 this file uses, so tests can pass a SQLite stand in. */
export interface Db {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

export class D1History implements History {
  constructor(private db: Db, private waitUntil: (p: Promise<unknown>) => void = () => {}) {}

  private write(sql: string, ...values: unknown[]): void {
    const p = Promise.resolve()
      .then(() => this.db.prepare(sql).bind(...values).run())
      .catch((err) => console.error('history write failed', sql.slice(0, 40), err));
    this.waitUntil(p);
  }

  count(c: Count): void {
    this.write('INSERT INTO counts (product_id, zone_id, count, level, pockets, source, ts) VALUES (?, ?, ?, ?, ?, ?, ?)', c.productId, c.zoneId, c.count, c.level, c.pockets ? JSON.stringify(c.pockets) : null, c.source, c.ts);
  }

  pick(p: PickEvent): void {
    this.write(
      'INSERT INTO picks (id, product_id, zone_id, delta, count_after, source, hand_seen, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET hand_seen = excluded.hand_seen',
      p.id, p.productId, p.zoneId, p.delta, p.countAfter, p.source, p.handSeen ? 1 : 0, p.ts,
    );
  }

  order(o: Order): void {
    this.write('INSERT INTO order_events (order_id, state, po_number, json, ts) VALUES (?, ?, ?, ?, ?)', o.id, o.state, o.poNumber, JSON.stringify(o), o.updatedAt);
  }

  run(r: Run): void {
    this.write(
      'INSERT INTO runs (id, kind, supplier_id, order_id, status, replay, json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, json = excluded.json, finished_at = excluded.finished_at',
      r.id, r.kind, r.supplierId, r.orderId, r.status, r.replay ? 1 : 0, JSON.stringify(r), r.startedAt, r.finishedAt,
    );
  }

  quote(q: Quote): void {
    this.write(
      'INSERT INTO quotes (id, product_id, supplier_id, unit_price, ok, json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET unit_price = excluded.unit_price, ok = excluded.ok, json = excluded.json, fetched_at = excluded.fetched_at',
      q.id, q.productId, q.supplierId, q.unitPrice, q.ok ? 1 : 0, JSON.stringify(q), q.fetchedAt,
    );
  }
}

/** The last 30 completed local days of a part, oldest first: what was used, what came in, and what the board held at the end of each. */
export function pastDays(room: RoomCore, productId: string): { day: string; used: number; restocked: number; endCount: number; sample: boolean }[] {
  const product = room.product(productId);
  if (!product) return [];
  const today = room.today();
  const byDay = room.x.usage[productId] ?? {};
  const use = room.dailyUse(productId);
  const count = room.count(productId)?.count ?? 0;
  const cap = (n: number) => Math.max(0, product.capacity == null ? n : Math.min(product.capacity, n));

  // Walk back from what is on the board now: the end of a day is the end of the next day, plus what was used, less what arrived.
  const ends: number[] = new Array<number>(use.days.length).fill(0);
  let next = cap(count + (byDay[today]?.used ?? 0) - (byDay[today]?.restocked ?? 0));
  for (let i = use.days.length - 1; i >= 0; i--) {
    ends[i] = next;
    const day = byDay[use.days[i] ?? ''];
    next = cap(next + (day?.used ?? 0) - (day?.restocked ?? 0));
  }
  return use.days.map((day, i) => ({ day, used: Math.max(0, Math.round(use.used[i] ?? 0)), restocked: Math.max(0, Math.round(byDay[day]?.restocked ?? 0)), endCount: Math.round(ends[i] ?? 0), sample: byDay[day]?.sample === true }));
}

/** 30 completed local days of use, and the next 7 days from the brain. */
export function historyResult(room: RoomCore, productId: string): HistoryResult | null {
  const product = room.product(productId);
  if (!product) return null;
  const today = room.today();
  const count = room.count(productId)?.count ?? 0;
  const policy = room.policy(productId);
  const d = (policy?.ratePerDay ?? 0) * (policy?.seasonFactor ?? 1);
  const order = room.openOrderFor(productId);
  let arrival: { offset: number; units: number } | null = null;
  if (order) {
    const etaDay = order.eta ? dayIn(new Date(order.eta), room.config.TIME_ZONE) : addDays(today, (policy?.leadDays ?? 2) + 1);
    const offset = Math.round((Date.parse(`${etaDay}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
    if (offset >= 1) arrival = { offset, units: order.units };
  }

  return {
    productId,
    days: pastDays(room, productId).map(({ day, used, endCount, sample }) => ({ day, used, endCount, sample })),
    forecast: forecast(count, d, 7, product.capacity, arrival).map((f) => ({ day: addDays(today, f.offset), expected: f.expected, low: f.low, high: f.high })),
    reorderPoint: policy?.reorderPoint ?? 0,
  };
}
