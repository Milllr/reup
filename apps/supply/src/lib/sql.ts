// The little of D1 the store uses, so tests can run the same SQL on SQLite in Node.
export interface Sql {
  run(sql: string, ...args: unknown[]): Promise<void>;
  all<T>(sql: string, ...args: unknown[]): Promise<T[]>;
  first<T>(sql: string, ...args: unknown[]): Promise<T | null>;
}

export function d1(db: D1Database): Sql {
  return {
    run: async (sql, ...args) => {
      await db.prepare(sql).bind(...args).run();
    },
    all: async <T,>(sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).all<T>()).results,
    first: <T,>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).first<T>(),
  };
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (sku TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL, packs TEXT NOT NULL, in_stock INTEGER NOT NULL DEFAULT 1, lead_days INTEGER NOT NULL DEFAULT 2, position INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, signed_in INTEGER NOT NULL DEFAULT 0, is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cart_lines (session_id TEXT NOT NULL, sku TEXT NOT NULL, pack_index INTEGER NOT NULL, qty INTEGER NOT NULL, PRIMARY KEY (session_id, sku, pack_index))`,
  `CREATE TABLE IF NOT EXISTS orders (confirmation TEXT PRIMARY KEY, po_number TEXT NOT NULL, lines TEXT NOT NULL, subtotal REAL NOT NULL, tax REAL NOT NULL, shipping REAL NOT NULL, total REAL NOT NULL, status TEXT NOT NULL DEFAULT 'Confirmed', eta TEXT NOT NULL, created_at TEXT NOT NULL)`,
];
