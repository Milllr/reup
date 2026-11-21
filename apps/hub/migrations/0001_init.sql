-- The hub's log. The live state is in the Room; these tables are the record of what happened.
CREATE TABLE IF NOT EXISTS counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  level REAL,
  pockets TEXT,
  source TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS counts_product_ts ON counts (product_id, ts);

CREATE TABLE IF NOT EXISTS picks (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  count_after INTEGER NOT NULL,
  source TEXT NOT NULL,
  hand_seen INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS picks_product_ts ON picks (product_id, ts);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  state TEXT NOT NULL,
  po_number TEXT NOT NULL,
  json TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events (order_id, id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  order_id TEXT,
  status TEXT NOT NULL,
  replay INTEGER NOT NULL DEFAULT 0,
  json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  unit_price REAL,
  ok INTEGER NOT NULL,
  json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quotes_product ON quotes (product_id, fetched_at);
