// Analytics: every part on the board with the 30 days behind it, the 60 days ahead, the trail of today and the orders placed.
import { project } from '@reup/brain';
import type { AnalyticsPart, AnalyticsResult, CatalogItem } from '@reup/contracts';
import type { RoomCore } from '../core/room';
import { addDays, dayIn } from '../core/time';
import { pastDays } from '../history';

/** Far enough to show an order and its delivery for a ledge that turns over about once a month. */
export const DAYS_AHEAD = 60;
const A_DAY = 24 * 60 * 60 * 1000;

/** What one unit costs at the account supplier: its last good quote, else the smallest pack in the store catalog. */
function unitPrice(room: RoomCore, productId: string, sku: string | null, catalog: readonly CatalogItem[]): number | null {
  const account = room.s.suppliers.find((s) => s.kind === 'account');
  const quote = room.s.quotes.find((q) => q.productId === productId && q.supplierId === account?.id && q.ok && q.unitPrice != null);
  if (quote?.unitPrice != null) return quote.unitPrice;
  const pack = catalog.find((item) => item.sku === sku)?.packs.reduce((small, next) => (next.size < small.size ? next : small));
  return pack ? Math.round((pack.price / pack.size) * 100) / 100 : null;
}

function part(room: RoomCore, productId: string, catalog: readonly CatalogItem[]): AnalyticsPart | null {
  const product = room.product(productId);
  if (!product) return null;
  const today = room.today();
  const policy = room.policy(productId) ?? room.recomputePolicy(productId, false);
  const count = room.count(productId)?.count ?? 0;
  const d = (policy?.ratePerDay ?? 0) * (policy?.seasonFactor ?? 1);
  const leadDays = policy?.leadDays ?? room.x.leadDays[productId] ?? 2;
  const reorderPoint = policy?.reorderPoint ?? 0;

  const order = room.openOrderFor(productId);
  let arrival: { offset: number; units: number } | null = null;
  if (order) {
    const etaDay = order.eta ? dayIn(new Date(order.eta), room.config.TIME_ZONE) : addDays(today, leadDays + 1);
    const offset = Math.round((Date.parse(`${etaDay}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / A_DAY);
    arrival = { offset: Math.max(1, offset), units: order.units };
  }
  const ahead = project({ count, d, days: DAYS_AHEAD, capacity: product.capacity, reorderPoint, leadDays, fill: room.x.board[productId] != null && product.capacity != null, arrival });
  const firstOrder = order ? undefined : ahead.find((day) => day.ordered > 0);
  const now = room.x.usage[productId]?.[today];

  return {
    productId,
    name: product.name,
    unit: product.unit,
    count,
    capacity: product.capacity,
    ratePerDay: Math.round(d * 100) / 100,
    reorderPoint,
    leadDays,
    daysOfCover: d > 0 ? Math.round((count / d) * 10) / 10 : null,
    reorderOn: firstOrder ? addDays(today, firstOrder.offset) : null,
    runsOutOn: d > 0 ? addDays(today, Math.ceil(count / d)) : null,
    unitPrice: unitPrice(room, productId, product.sku, catalog),
    days: pastDays(room, productId),
    today: { used: Math.max(0, Math.round(now?.used ?? 0)), restocked: Math.max(0, Math.round(now?.restocked ?? 0)) },
    projection: ahead.map(({ offset, ...day }) => ({ day: addDays(today, offset), ...day })),
  };
}

/** catalog is the store's list when the caller has it. Without it a price comes from quotes alone. */
export function analyticsResult(room: RoomCore, catalog: readonly CatalogItem[] = room.x.catalog?.items ?? []): AnalyticsResult {
  const since = room.nowMs() - A_DAY;
  const onBoard = room.s.products.filter((p) => p.zoneId != null);
  return {
    now: room.iso(),
    today: room.today(),
    parts: onBoard.flatMap((p) => part(room, p.id, catalog) ?? []),
    trail: room.x.trail.filter((t) => Date.parse(t.ts) >= since),
    placed: [...room.x.placed].reverse(),
  };
}
