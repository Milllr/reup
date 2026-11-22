// The fact sheet for Ask reup: what the hub knows about use, stock and orders, as short numbered lines.
// The model answers from these lines and names the ones it used, so the screen can show what an answer rests on.
import type { Order } from '@reup/contracts';
import type { RoomCore } from '../core/room';
import { weekdayIn } from '../core/time';

export interface ProductFacts {
  id: string;
  name: string;
  unit: string;
  count: number;
  capacity: number | null;
  usedToday: number;
  used7: number;
  used30: number;
  ratePerDay: number | null;
  reorderPoint: number | null;
  daysOfCover: number | null;
  sample: boolean;
}

export interface FactSheet {
  /** F1, F2 and so on, to the line. */
  lines: { id: string; text: string }[];
  products: ProductFacts[];
  orders: Order[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const money = (n: number) => `$${n.toFixed(2)}`;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
export const STATE_WORDS: Record<Order['state'], string> = {
  pricing: 'checking prices',
  carting: 'filling the cart',
  awaiting_approval: 'waiting for a yes',
  approved: 'approved, being placed',
  placing: 'being placed',
  placed: 'placed',
  shipped: 'on its way',
  received: 'received',
  cancelled: 'cancelled',
  failed: 'failed',
};

export function productFacts(room: RoomCore): ProductFacts[] {
  const today = room.today();
  return room.s.products.map((p) => {
    const use = room.dailyUse(p.id);
    const policy = room.s.policies.find((x) => x.productId === p.id);
    const last7 = use.used.slice(-7);
    return {
      id: p.id,
      name: p.name,
      unit: p.unit,
      count: room.count(p.id)?.count ?? 0,
      capacity: p.capacity,
      usedToday: room.x.usage[p.id]?.[today]?.used ?? 0,
      used7: last7.reduce((a, b) => a + b, 0),
      used30: use.used.reduce((a, b) => a + b, 0),
      ratePerDay: policy ? round1(policy.ratePerDay * policy.seasonFactor) : null,
      reorderPoint: policy?.reorderPoint ?? null,
      daysOfCover: policy?.daysOfCover == null ? null : round1(policy.daysOfCover),
      sample: use.sample,
    };
  });
}

export function factSheet(room: RoomCore): FactSheet {
  const products = productFacts(room);
  const orders = [...room.s.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12);
  const texts: string[] = [];
  const now = room.iso();
  texts.push(`Today is ${weekdayIn(now, room.config.TIME_ZONE)} ${now.slice(0, 10)}. "This week" means the last 7 days plus today.`);
  texts.push(`Season setting: ${room.s.season.label}, use multiplied by ${room.s.season.factor}.`);
  for (const p of products) {
    const parts = [
      `${p.name} (unit: ${p.unit})`,
      `${p.count} on the board${p.capacity != null ? ` of ${p.capacity} it holds` : ''}`,
      `${p.usedToday} used today`,
      `${p.used7} used in the 7 days before today`,
      `${p.used30} used in the 30 days before today`,
    ];
    if (p.ratePerDay != null) parts.push(`about ${p.ratePerDay} a day`);
    if (p.reorderPoint != null) parts.push(`reorder point ${p.reorderPoint}`);
    parts.push(p.daysOfCover != null ? `${p.daysOfCover} days of cover` : 'no use yet, so no days of cover');
    if (p.sample) parts.push('history is partly sample data');
    texts.push(`${parts.join(', ')}.`);
  }
  const names = new Map(room.s.products.map((p) => [p.id, p.name]));
  const suppliers = new Map(room.s.suppliers.map((s) => [s.id, s.name]));
  if (orders.length === 0) texts.push('There are no orders yet.');
  for (const o of orders) {
    const parts = [
      `Order ${o.poNumber}: ${o.units} of ${names.get(o.productId) ?? o.productId} from ${suppliers.get(o.supplierId) ?? o.supplierId}`,
      STATE_WORDS[o.state],
      o.total != null ? `total ${money(o.total)} ${o.currency}` : 'no total yet',
      `started ${day(o.createdAt)}`,
    ];
    if (o.eta) parts.push(`arrives ${day(o.eta)}`);
    if (o.confirmation) parts.push(`confirmation ${o.confirmation}`);
    texts.push(`${parts.join(', ')}.`);
  }
  const spent = room.s.orders.filter((o) => ['placed', 'shipped', 'received'].includes(o.state) && o.total != null);
  if (spent.length > 0) texts.push(`Placed orders: ${spent.length}, together ${money(spent.reduce((a, o) => a + (o.total ?? 0), 0))} CAD.`);
  return { lines: texts.map((text, i) => ({ id: `F${i + 1}`, text })), products, orders };
}
