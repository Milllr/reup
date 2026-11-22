// The fact sheet for Ask reup: what the hub knows about use, stock and orders, as short numbered lines.
// The model answers from these lines and names the ones it used, so the screen can show what an answer rests on.
import type { CountCheck, Order } from '@reup/contracts';
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
  /** This week: the 7 days before today plus today. */
  usedWeek: number;
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
  /** Count checks holding an order until a person looks. */
  checks: CountCheck[];
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
    const usedToday = room.x.usage[p.id]?.[today]?.used ?? 0;
    const used7 = last7.reduce((a, b) => a + b, 0);
    return {
      id: p.id,
      name: p.name,
      unit: p.unit,
      count: room.count(p.id)?.count ?? 0,
      capacity: p.capacity,
      usedToday,
      used7,
      usedWeek: used7 + usedToday,
      used30: use.used.reduce((a, b) => a + b, 0),
      ratePerDay: policy ? round1(policy.ratePerDay * policy.seasonFactor) : null,
      reorderPoint: policy?.reorderPoint ?? null,
      daysOfCover: policy?.daysOfCover == null ? null : round1(policy.daysOfCover),
      sample: use.sample,
    };
  });
}

/** "A", "A and B", "A, B and C". */
export const and = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Parts used this week, grouped by how many, most first. Parts that tie share a group. */
export function weekGroups(products: readonly ProductFacts[]): { used: number; names: string[] }[] {
  const by = new Map<number, string[]>();
  for (const p of products) if (p.usedWeek > 0) by.set(p.usedWeek, [...(by.get(p.usedWeek) ?? []), p.name]);
  return [...by.entries()].sort((a, b) => b[0] - a[0]).map(([used, names]) => ({ used, names }));
}

/** "Wood screws 3" or "Flat washers and Hex bolts 1 each". */
export const groupText = (g: { used: number; names: string[] }) => (g.names.length > 1 ? `${and(g.names)} ${g.used} each` : `${g.names[0]} ${g.used}`);

/** One line that ranks this week's use, so the model reads the order and the ties rather than adding them up itself. */
export function rankingLine(products: readonly ProductFacts[]): string {
  const groups = weekGroups(products);
  if (groups.length === 0) return 'Nothing was used this week.';
  const shown = groups.slice(0, 4).map(groupText).join(', then ');
  const rest = groups.length > 4 ? ', and less for the rest' : '';
  const idle = products.filter((p) => p.usedWeek === 0).length;
  return `Most used this week, in units of each part: ${shown}${rest}.${idle > 0 ? ` ${idle} ${idle === 1 ? 'part was' : 'parts were'} not used this week.` : ''}`;
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
      `${p.usedWeek} used this week (${p.usedToday} of them today)`,
      `${p.used7} used in the 7 days before today`,
      `${p.used30} used in the 30 days before today`,
    ];
    if (p.ratePerDay != null) parts.push(`about ${p.ratePerDay} a day`);
    if (p.reorderPoint != null) parts.push(`reorder point ${p.reorderPoint}`);
    parts.push(p.daysOfCover != null ? `${p.daysOfCover} days of cover` : 'no use yet, so no days of cover');
    if (p.sample) parts.push('history is partly sample data');
    texts.push(`${parts.join(', ')}.`);
  }
  texts.push(rankingLine(products));
  const names = new Map(room.s.products.map((p) => [p.id, p.name]));
  // A held count check is why a part at its reorder point has no order yet.
  for (const c of room.s.checks ?? []) {
    texts.push(`Count check on ${names.get(c.productId) ?? c.productId}, waiting for a person since ${c.ts.slice(11, 16)}: the count went from ${c.before} to ${c.after} at once. ${c.text}`);
  }
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
  return { lines: texts.map((text, i) => ({ id: `F${i + 1}`, text })), products, orders, checks: room.s.checks ?? [] };
}
