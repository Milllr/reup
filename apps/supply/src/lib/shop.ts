// Everything the store knows and does, over SQL. The routes only read forms and draw pages.
import { Catalog as CatalogSchema, type Catalog, type CatalogItem, type CatalogPack } from '@reup/contracts';
import catalogSeed from '../../../../contracts/mocks/catalog.json';
import type { Config } from './config';
import { deliveryDay, totals, type Totals } from './money';
import { SCHEMA, type Sql } from './sql';

export const SEED: Catalog = CatalogSchema.parse(catalogSeed);

export interface Item {
  sku: string;
  name: string;
  category: string;
  unit: string;
  packs: CatalogPack[];
  inStock: boolean;
  leadDays: number;
}

interface ItemRow { sku: string; name: string; category: string; unit: string; packs: string; in_stock: number; lead_days: number }
const toItem = (r: ItemRow): Item => ({ sku: r.sku, name: r.name, category: r.category, unit: r.unit, packs: JSON.parse(r.packs) as CatalogPack[], inStock: r.in_stock === 1, leadDays: r.lead_days });

export interface CartLine {
  sku: string;
  name: string;
  unit: string;
  packIndex: number;
  packLabel: string;
  packSize: number;
  price: number;
  qty: number;
  leadDays: number;
  inStock: boolean;
}

export interface Session {
  id: string;
  signedIn: boolean;
  isAdmin: boolean;
}

export type OrderStatus = 'Confirmed' | 'Shipped' | 'Delivered';

export interface StoreOrder extends Totals {
  confirmation: string;
  poNumber: string;
  lines: CartLine[];
  status: OrderStatus;
  /** YYYY-MM-DD */
  eta: string;
  createdAt: string;
}

interface OrderRow { confirmation: string; po_number: string; lines: string; subtotal: number; tax: number; shipping: number; total: number; status: OrderStatus; eta: string; created_at: string }
const toOrder = (r: OrderRow): StoreOrder => ({ confirmation: r.confirmation, poNumber: r.po_number, lines: JSON.parse(r.lines) as CartLine[], subtotal: r.subtotal, tax: r.tax, shipping: r.shipping, total: r.total, status: r.status, eta: r.eta, createdAt: r.created_at });

export class ShopError extends Error {}

const norm = (s: string) => s.toLowerCase().replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Best match first. An exact SKU always wins. Words match in any order; short words must match a whole word. */
export function rank(items: readonly Item[], query: string): Item[] {
  const q = norm(query);
  if (q === '') return [];
  const tokens = q.split(' ').filter((t) => t !== 'x' && t !== 'of' && t !== 'in');
  const scored = items.map((item, index) => {
    const sku = item.sku.toLowerCase();
    const name = norm(item.name);
    const rest = norm(`${item.category} ${item.unit}`);
    let score = sku === q ? 1000 : 0;
    for (const t of tokens) {
      const hit = (text: string) => (t.length <= 2 ? new RegExp(`(^|[^a-z0-9/])${escapeRe(t)}($|[^a-z0-9/])`).test(text) : text.includes(t));
      if (sku.includes(t)) score += 6;
      if (hit(name)) score += 3;
      else if (hit(rest)) score += 1;
    }
    return { item, score, index };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.item);
}

export class Shop {
  private ready: Promise<void> | null = null;

  constructor(private sql: Sql, readonly config: Config, private now: () => Date = () => new Date(), private random: () => number = Math.random) {}

  /** Makes the tables and loads the catalog the first time. Safe to call on every request. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      for (const statement of SCHEMA) await this.sql.run(statement);
      const row = await this.sql.first<{ n: number }>('SELECT COUNT(*) AS n FROM items');
      if ((row?.n ?? 0) === 0) await this.seed();
    })();
    return this.ready;
  }

  private async seed(): Promise<void> {
    await this.sql.run('DELETE FROM items');
    let position = 0;
    for (const item of SEED.items) {
      await this.sql.run('INSERT INTO items (sku, name, category, unit, packs, in_stock, lead_days, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', item.sku, item.name, item.category, item.unit, JSON.stringify(item.packs), item.inStock ? 1 : 0, item.leadDays, position++);
    }
  }

  // ---------- catalog ----------

  async items(): Promise<Item[]> {
    return (await this.sql.all<ItemRow>('SELECT * FROM items ORDER BY position')).map(toItem);
  }

  async item(sku: string): Promise<Item | null> {
    const row = await this.sql.first<ItemRow>('SELECT * FROM items WHERE sku = ? COLLATE NOCASE', sku);
    return row ? toItem(row) : null;
  }

  async search(query: string): Promise<Item[]> {
    return rank(await this.items(), query);
  }

  async catalog(origin: string): Promise<Catalog> {
    const items: CatalogItem[] = (await this.items()).map((i) => ({ sku: i.sku, name: i.name, category: i.category, unit: i.unit, packs: i.packs, inStock: i.inStock, leadDays: i.leadDays, url: `${origin}/p/${i.sku}` }));
    return { currency: SEED.currency, items };
  }

  // ---------- sessions ----------

  async session(id: string | undefined): Promise<Session> {
    if (id) {
      const row = await this.sql.first<{ id: string; signed_in: number; is_admin: number }>('SELECT * FROM sessions WHERE id = ?', id);
      if (row) return { id: row.id, signedIn: row.signed_in === 1, isAdmin: row.is_admin === 1 };
    }
    const fresh = crypto.randomUUID();
    await this.sql.run('INSERT INTO sessions (id, created_at) VALUES (?, ?)', fresh, this.now().toISOString());
    return { id: fresh, signedIn: false, isAdmin: false };
  }

  async signIn(sessionId: string, email: string, password: string): Promise<boolean> {
    if (email.trim().toLowerCase() !== this.config.ACCOUNT_EMAIL.toLowerCase() || password !== this.config.ACCOUNT_PASSWORD) return false;
    await this.sql.run('UPDATE sessions SET signed_in = 1 WHERE id = ?', sessionId);
    return true;
  }

  async signOut(sessionId: string): Promise<void> {
    await this.sql.run('UPDATE sessions SET signed_in = 0, is_admin = 0 WHERE id = ?', sessionId);
  }

  async adminIn(sessionId: string, password: string): Promise<boolean> {
    if (password !== this.config.ADMIN_PASSWORD) return false;
    await this.sql.run('UPDATE sessions SET is_admin = 1 WHERE id = ?', sessionId);
    return true;
  }

  // ---------- cart ----------

  async cart(sessionId: string): Promise<CartLine[]> {
    const rows = await this.sql.all<ItemRow & { pack_index: number; qty: number }>('SELECT i.*, c.pack_index, c.qty FROM cart_lines c JOIN items i ON i.sku = c.sku WHERE c.session_id = ? ORDER BY i.position, c.pack_index', sessionId);
    return rows.flatMap((r) => {
      const item = toItem(r);
      const pack = item.packs[r.pack_index];
      return pack ? [{ sku: item.sku, name: item.name, unit: item.unit, packIndex: r.pack_index, packLabel: pack.label, packSize: pack.size, price: pack.price, qty: r.qty, leadDays: item.leadDays, inStock: item.inStock }] : [];
    });
  }

  async cartCount(sessionId: string): Promise<number> {
    return (await this.sql.first<{ n: number | null }>('SELECT SUM(qty) AS n FROM cart_lines WHERE session_id = ?', sessionId))?.n ?? 0;
  }

  async add(sessionId: string, sku: string, packIndex: number, qty: number): Promise<void> {
    const item = await this.item(sku);
    if (!item) throw new ShopError('That item does not exist.');
    if (!item.inStock) throw new ShopError(`${item.name} is out of stock.`);
    if (!item.packs[packIndex]) throw new ShopError('Choose a pack size.');
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new ShopError('Quantity must be a whole number from 1 to 999.');
    await this.sql.run('INSERT INTO cart_lines (session_id, sku, pack_index, qty) VALUES (?, ?, ?, ?) ON CONFLICT (session_id, sku, pack_index) DO UPDATE SET qty = MIN(999, qty + excluded.qty)', sessionId, item.sku, packIndex, qty);
  }

  async setQty(sessionId: string, sku: string, packIndex: number, qty: number): Promise<void> {
    if (!Number.isInteger(qty) || qty < 1) return this.remove(sessionId, sku, packIndex);
    await this.sql.run('UPDATE cart_lines SET qty = ? WHERE session_id = ? AND sku = ? AND pack_index = ?', Math.min(999, qty), sessionId, sku, packIndex);
  }

  async remove(sessionId: string, sku: string, packIndex: number): Promise<void> {
    await this.sql.run('DELETE FROM cart_lines WHERE session_id = ? AND sku = ? AND pack_index = ?', sessionId, sku, packIndex);
  }

  async empty(sessionId: string): Promise<void> {
    await this.sql.run('DELETE FROM cart_lines WHERE session_id = ?', sessionId);
  }

  /** The day everything in the cart can arrive: the slowest line decides. */
  eta(lines: readonly CartLine[]): string {
    return deliveryDay(this.now(), Math.max(1, ...lines.map((l) => l.leadDays)), this.config.TIME_ZONE);
  }

  // ---------- orders ----------

  async place(sessionId: string, poNumber: string): Promise<StoreOrder> {
    const po = poNumber.trim();
    if (po === '') throw new ShopError('Enter a PO number. An order on account needs one.');
    const lines = await this.cart(sessionId);
    if (lines.length === 0) throw new ShopError('Your cart is empty.');
    const gone = lines.find((l) => !l.inStock);
    if (gone) throw new ShopError(`${gone.name} is out of stock. Remove it to place the order.`);
    const sums = totals(lines);
    const eta = this.eta(lines);
    const createdAt = this.now().toISOString();
    let confirmation = '';
    for (let tries = 0; tries < 20; tries++) {
      confirmation = `OC-${10000 + Math.floor(this.random() * 90000)}`;
      if (!(await this.sql.first('SELECT confirmation FROM orders WHERE confirmation = ?', confirmation))) break;
      confirmation = '';
    }
    if (confirmation === '') throw new ShopError('Could not make a confirmation number. Try again.');
    await this.sql.run('INSERT INTO orders (confirmation, po_number, lines, subtotal, tax, shipping, total, status, eta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', confirmation, po, JSON.stringify(lines), sums.subtotal, sums.tax, sums.shipping, sums.total, 'Confirmed', eta, createdAt);
    await this.empty(sessionId);
    return { confirmation, poNumber: po, lines, ...sums, status: 'Confirmed', eta, createdAt };
  }

  async orders(): Promise<StoreOrder[]> {
    return (await this.sql.all<OrderRow>('SELECT * FROM orders ORDER BY created_at DESC, confirmation DESC')).map(toOrder);
  }

  async order(confirmation: string): Promise<StoreOrder | null> {
    const row = await this.sql.first<OrderRow>('SELECT * FROM orders WHERE confirmation = ? COLLATE NOCASE', confirmation);
    return row ? toOrder(row) : null;
  }

  /** Moves an order forward only. Returns the order when its status changed. */
  async setStatus(confirmation: string, status: OrderStatus): Promise<StoreOrder | null> {
    const order = await this.order(confirmation);
    const rank = { Confirmed: 0, Shipped: 1, Delivered: 2 } as const;
    if (!order || rank[status] <= rank[order.status]) return null;
    await this.sql.run('UPDATE orders SET status = ? WHERE confirmation = ?', status, order.confirmation);
    return { ...order, status };
  }

  // ---------- admin ----------

  async updateItem(sku: string, price: number | null, inStock: boolean): Promise<void> {
    const item = await this.item(sku);
    if (!item) throw new ShopError('That item does not exist.');
    const packs = item.packs.map((p, i) => (i === 0 && price != null && price >= 0 ? { ...p, price: Math.round(price * 100) / 100 } : p));
    await this.sql.run('UPDATE items SET packs = ?, in_stock = ? WHERE sku = ?', JSON.stringify(packs), inStock ? 1 : 0, item.sku);
  }

  /** Clears orders and carts and restores seeded prices and stock. */
  async reset(): Promise<void> {
    await this.sql.run('DELETE FROM orders');
    await this.sql.run('DELETE FROM cart_lines');
    await this.seed();
  }
}
