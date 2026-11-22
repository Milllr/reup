// What the screens say, worked out from the Snapshot. One place, so the TV, the phone and the tests agree.
import { coverText, unitsText } from '@reup/brain';
import type { Order, Point, Product, Run, Snapshot } from '@reup/contracts';

export type Tone = 'olive' | 'wine' | 'paper';

export interface Moment {
  plate: Tone;
  word: string;
  /** The word takes the text colour: loading, empty, offline. */
  quiet?: boolean;
}

export const TIME_ZONE = 'America/Toronto';

const PLACED: ReadonlySet<Order['state']> = new Set(['placed', 'shipped']);
const OPEN: ReadonlySet<Order['state']> = new Set(['pricing', 'carting', 'awaiting_approval', 'approved', 'placing', 'placed', 'shipped']);

export const weekday = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, weekday: 'long' }).format(new Date(iso));

/** "Sat 9:14 AM" */
export function clock(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', hour: 'numeric', minute: '2-digit' }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('hour')}:${get('minute')} ${get('dayPeriod')}`;
}

/** "9:14" for "Showing the last counts from 9:14." */
export function shortTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }).formatToParts(new Date(iso));
  return `${parts.find((p) => p.type === 'hour')?.value}:${parts.find((p) => p.type === 'minute')?.value}`;
}

export const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * What the order's total includes. Tax alone is never more than a fifth of the goods, so a total further above them
 * than that carries shipping too, which the store adds to small orders.
 */
export function totalLabel(order: Pick<Order, 'total' | 'unitPrice' | 'units'>): string {
  if (order.total == null || order.unitPrice == null) return 'Total with tax';
  const goods = order.unitPrice * order.units;
  return goods > 0 && order.total - goods > goods * 0.2 ? 'Total with tax and shipping' : 'Total with tax';
}

export interface PartRow {
  product: Product;
  zoneName: string;
  count: number;
  capacity: number | null;
  /** At or under the reorder point with no order placed yet. */
  low: boolean;
  /** At or under the reorder point, and its order is placed. */
  onTheWay: boolean;
  meta: string;
  openOrder: Order | undefined;
}

export function partRows(s: Snapshot): PartRow[] {
  return s.products.filter((p) => p.zoneId != null || s.counts.some((c) => c.productId === p.id)).map((product) => {
    const count = s.counts.find((c) => c.productId === product.id)?.count ?? 0;
    const policy = s.policies.find((p) => p.productId === product.id);
    const openOrder = [...s.orders].reverse().find((o) => o.productId === product.id && OPEN.has(o.state));
    // A part with no use yet is counted, never low.
    const inUse = policy != null && policy.ratePerDay > 0;
    const atLine = policy != null && inUse && count <= policy.reorderPoint;
    const placed = openOrder != null && PLACED.has(openOrder.state);
    const cover = coverText(policy?.daysOfCover ?? null);
    let meta = policy && inUse ? `Reorder at ${policy.reorderPoint} · ${cover}` : policy ? 'Counting · not in use yet' : 'Counting';
    if (placed && openOrder) {
      // Once some of the delivery is on the board, say how much of it is in.
      const got = openOrder.unitsReceived ?? 0;
      meta = got > 0 ? `${got} of ${openOrder.units} in` : `${unitsText(openOrder.units, product.unit)} on the way${openOrder.eta ? ` · arrives ${weekday(openOrder.eta)}` : ''}`;
    }
    else if (openOrder) meta = `Ordering ${unitsText(openOrder.units, product.unit)}`;
    else if (atLine) meta = `${count === 0 ? 'Out' : 'At the reorder point'} · ${cover}`;
    return { product, zoneName: s.zones.find((z) => z.id === product.zoneId)?.name ?? product.name, count, capacity: product.capacity, low: atLine && !placed, onTheWay: placed, meta, openOrder };
  });
}

export function shelfMoment(s: Snapshot): Moment {
  const rows = partRows(s);
  if (rows.length === 0) return { plate: 'olive', word: 'Empty', quiet: true };
  if (rows.some((r) => r.low)) return { plate: 'wine', word: 'Reorder' };
  if (rows.some((r) => r.onTheWay)) return { plate: 'olive', word: 'On the way' };
  return { plate: 'olive', word: 'Stocked' };
}

export function orderMoment(order: Order, product: Product | undefined): Moment {
  switch (order.state) {
    case 'pricing':
    case 'carting':
    case 'awaiting_approval':
      return { plate: 'paper', word: unitsText(order.units, product?.unit ?? 'each') };
    case 'approved':
    case 'placing':
      return { plate: 'wine', word: 'Placing' };
    case 'placed':
    case 'shipped':
    case 'received':
      return { plate: 'olive', word: 'Ordered' };
    case 'failed':
      return { plate: 'wine', word: 'Stopped' };
    case 'cancelled':
      return { plate: 'paper', word: 'Cancelled' };
  }
}

/** The order the Shop and Order screens are about: the newest one for the focused product, else the newest. */
export function focusOrder(s: Snapshot): Order | undefined {
  const newestFirst = [...s.orders].reverse();
  return newestFirst.find((o) => o.productId === s.focusProductId) ?? newestFirst[0];
}

/** The runs to show for an order: its price checks and its cart or place run, oldest first. */
export function runsFor(s: Snapshot, order: Order, kinds: readonly Run['kind'][]): Run[] {
  return s.runs.filter((r) => kinds.includes(r.kind) && (r.orderId === order.id || (r.orderId == null && r.productId === order.productId)));
}

/** A zone's quad as a box in percent of its camera frame. */
export function zoneBox(quad: readonly Point[]): { left: string; top: string; width: string; height: string } {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pct = (n: number) => `${Math.round(n * 10000) / 100}%`;
  return { left: pct(x0), top: pct(y0), width: pct(x1 - x0), height: pct(y1 - y0) };
}

/** How long a run took, for the run log: "32 s", "1 min 5 s". */
export function duration(run: Run, nowIso: string): string {
  const ms = Math.max(0, Date.parse(run.finishedAt ?? nowIso) - Date.parse(run.startedAt));
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export const supplierName = (s: Snapshot, id: string) => s.suppliers.find((x) => x.id === id)?.name ?? 'Supplier';
