// Every shape that crosses a lane. Field names here are the names everywhere.
// Units on the board are boxes or bags, never single screws. Money is CAD dollars as a number.
import { z } from 'zod';

export const Id = z.string().min(1);
/** ISO 8601 with Z or an offset, for example 2026-11-21T09:14:03Z */
export const IsoTime = z.iso.datetime({ offset: true });
export const Money = z.number().nonnegative();
/** A point in a camera frame, normalized: [x, y] with 0,0 at the top left and 1,1 at the bottom right. */
export const Point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);

// ---------- the board ----------

export const CameraId = z.enum(['board', 'aux', 'node']);
/** pockets: one unit per pocket, full or empty. open: items counted by the detector. bin: loose bulk, a fill level. */
export const ZoneKind = z.enum(['pockets', 'open', 'bin']);

export const Zone = z.object({
  id: Id,
  name: z.string(),
  kind: ZoneKind,
  camera: CameraId,
  /** Corners clockwise from the top left, in that camera's frame. */
  quad: z.array(Point).length(4),
  /** Pocket zones only: the grid inside the quad. Pockets are numbered row by row from the top left, starting at 0. */
  rows: z.number().int().positive().nullable(),
  cols: z.number().int().positive().nullable(),
  productId: Id.nullable(),
});

export const Product = z.object({
  id: Id,
  name: z.string(),
  /** What one unit is, for example "box of 100" or "each". */
  unit: z.string(),
  /** The Offcut Supply SKU, once matched. */
  sku: z.string().nullable(),
  zoneId: Id.nullable(),
  /** How many units the zone holds when full. Pocket zones: rows times cols. */
  capacity: z.number().int().positive().nullable(),
  /** What to type into a store's search box. */
  searchPhrase: z.string(),
  imageUrl: z.string().nullable(),
  createdAt: IsoTime,
});

export const CountSource = z.enum(['eye', 'node', 'manual', 'seed']);

export const Count = z.object({
  productId: Id,
  zoneId: Id,
  /** Units in stock. For a bin zone this is 0 and level carries the reading. */
  count: z.number().int().nonnegative(),
  /** Bin zones: 0 empty to 1 full. Null for other kinds. */
  level: z.number().min(0).max(1).nullable(),
  /** Pocket zones: true where a pocket is full, in pocket order. Null for other kinds. */
  pockets: z.array(z.boolean()).nullable(),
  source: CountSource,
  ts: IsoTime,
});

/** A change in stock that a person caused: a take (negative delta) or a restock (positive delta). */
export const PickEvent = z.object({
  /** Unique per event, made by the sender, so a replay after a network drop is not counted twice. */
  id: Id,
  productId: Id,
  zoneId: Id,
  delta: z.number().int(),
  countAfter: z.number().int().nonnegative(),
  source: CountSource,
  /** True when the node saw a hand in the zone around this change. */
  handSeen: z.boolean(),
  ts: IsoTime,
});

/** A hand entering or leaving the board, seen by the shelf node's hand model. Level 1 of the node sends only these. */
export const Reach = z.object({
  /** One id per reach; the start and the end share it. */
  id: Id,
  /** The zone the hand was over, when the node knows the zones. */
  zoneId: Id.nullable(),
  state: z.enum(['start', 'end']),
  ts: IsoTime,
});

// ---------- the reorder brain ----------

export const Policy = z.object({
  productId: Id,
  /** Units used per day, weighted toward recent days, before the season factor. */
  ratePerDay: z.number().nonnegative(),
  seasonFactor: z.number().positive(),
  /** Delivery days from the latest account supplier quote. */
  leadDays: z.number().nonnegative(),
  reviewDays: z.number().nonnegative(),
  /** Safety factor. 1.65 is about a 95 percent chance of not running out. */
  z: z.number(),
  reorderPoint: z.number().int().nonnegative(),
  orderQty: z.number().int().positive(),
  /** Days until empty at the current rate. Null when the rate is 0. */
  daysOfCover: z.number().nonnegative().nullable(),
  /** One plain sentence for the screen, for example "Uses about 2.1 a day. Delivery takes 3 days. Reorder at 4." */
  reason: z.string(),
  /** True while the rate comes from seeded sample history, not real picks. The screen says so. */
  sampleHistory: z.boolean(),
  updatedAt: IsoTime,
});

export const Season = z.object({ factor: z.number().positive(), label: z.string() });

// ---------- suppliers, quotes, runs, orders ----------

/** account: a supplier reup may place orders with (Offcut Supply). market: a live retailer, prices only. */
export const SupplierKind = z.enum(['account', 'market']);

export const Supplier = z.object({
  id: Id,
  name: z.string(),
  kind: SupplierKind,
  baseUrl: z.url(),
  /** A search results URL with {q} where the query goes. Runs start here, not on the home page. */
  searchUrl: z.string(),
  /** ISO country code for the TinyFish proxy, for example CA. */
  country: z.string().length(2),
});

export const Quote = z.object({
  id: Id,
  productId: Id,
  supplierId: Id,
  listingName: z.string().nullable(),
  /** Units in the listing, for example 1 for a single box or 10 for a case of boxes. */
  packSize: z.number().int().positive().nullable(),
  /** Price of the listing before tax and shipping. */
  price: Money.nullable(),
  currency: z.string().nullable(),
  /** price divided by packSize. */
  unitPrice: Money.nullable(),
  inStock: z.boolean().nullable(),
  deliveryDays: z.number().nonnegative().nullable(),
  url: z.string().nullable(),
  runId: Id.nullable(),
  /** False when the run failed, was blocked, or returned no price. A failed quote is kept so the screen can say so. */
  ok: z.boolean(),
  fetchedAt: IsoTime,
});

export const RunKind = z.enum(['market', 'cart', 'place', 'track']);
export const RunStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);

/** One TinyFish agent run, mirrored for the screens. */
export const Run = z.object({
  id: Id,
  tinyfishRunId: z.string().nullable(),
  kind: RunKind,
  supplierId: Id,
  productId: Id.nullable(),
  orderId: Id.nullable(),
  status: RunStatus,
  /** The TinyFish live preview URL. View only. Goes straight into an iframe. */
  streamingUrl: z.url().nullable(),
  /** What the agent is doing, newest last. */
  steps: z.array(z.object({ ts: IsoTime, purpose: z.string() })),
  /** True when this is a recording of an earlier good run. The screen must show the word Replay. */
  replay: z.boolean(),
  error: z.string().nullable(),
  startedAt: IsoTime,
  finishedAt: IsoTime.nullable(),
});

export const OrderState = z.enum([
  'pricing', // market check and cached quotes
  'carting', // the cart run is filling the cart at the account supplier
  'awaiting_approval', // cart is at the review page; waiting for the button or a phone
  'approved',
  'placing', // the place run is clicking Place order
  'placed', // confirmation number in hand
  'shipped', // the store says it shipped; eta is set
  'received', // the count for this product rose after the order was placed
  'failed',
  'cancelled',
]);

export const Order = z.object({
  id: Id,
  productId: Id,
  supplierId: Id,
  state: OrderState,
  /** Units ordered. */
  units: z.number().int().positive(),
  /** Listing packs bought: ceil(units / packSize). */
  packs: z.number().int().positive(),
  packSize: z.number().int().positive(),
  unitPrice: Money.nullable(),
  total: Money.nullable(),
  currency: z.string(),
  /** One plain sentence, for example "8 boxes covers 14 days and arrives before the board runs out." */
  reason: z.string(),
  /** For example "Home Depot is $1.20 more per box." Null when no market quote came back. */
  marketNote: z.string().nullable(),
  /** Made by the hub, for example RU-1042. Entered at checkout. */
  poNumber: z.string(),
  confirmation: z.string().nullable(),
  eta: IsoTime.nullable(),
  approvedBy: z.enum(['button', 'phone']).nullable(),
  /** Who called for it: the hub's brain, the node while offline, or a person on the operator page. */
  trigger: z.enum(['hub', 'node', 'manual']),
  error: z.string().nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
});

// ---------- the shelf node, cameras, teaching ----------

export const NodeStatus = z.object({
  online: z.boolean(),
  /** 0 not seen yet, 1 reach and ledger, 2 pocket counts on the Pi, 3 supervised processes, 4 trained model on the Pi. */
  level: z.number().int().min(0).max(4),
  lastSeen: IsoTime.nullable(),
  /** Events on the Pi not yet accepted by the hub. */
  queued: z.number().int().nonnegative(),
  visionRestarts: z.number().int().nonnegative(),
  /** Set by the node when it last lost the hub; null when it has been connected since boot. */
  offlineSince: IsoTime.nullable(),
});

export const Camera = z.object({
  id: CameraId,
  online: z.boolean(),
  fps: z.number().nonnegative(),
  /** MJPEG URL on the local network. Null when the camera has no stream (the node). */
  streamUrl: z.string().nullable(),
});

export const TeachSuggestion = z.object({
  name: z.string(),
  unit: z.string(),
  sku: z.string().nullable(),
  searchPhrase: z.string(),
  confidence: z.enum(['sure', 'fairly_sure', 'not_sure']),
});

export const TeachState = z.object({
  id: Id,
  status: z.enum(['seen', 'naming', 'needs_confirm', 'confirmed', 'cancelled', 'failed']),
  cropUrl: z.string().nullable(),
  suggestion: TeachSuggestion.nullable(),
  zoneId: Id.nullable(),
  error: z.string().nullable(),
  ts: IsoTime,
});

// ---------- what the screens read ----------

export const Activity = z.object({
  id: Id,
  ts: IsoTime,
  tone: z.enum(['info', 'working', 'attention', 'error']),
  text: z.string(),
});

export const Screen = z.enum(['shelf', 'shop', 'order', 'why']);

/** The whole live state. Sent once when a WebSocket connects and returned by GET /api/state. */
export const Snapshot = z.object({
  now: IsoTime,
  screen: Screen,
  focusProductId: Id.nullable(),
  zones: z.array(Zone),
  products: z.array(Product),
  counts: z.array(Count),
  policies: z.array(Policy),
  suppliers: z.array(Supplier),
  quotes: z.array(Quote),
  orders: z.array(Order),
  runs: z.array(Run),
  node: NodeStatus,
  cameras: z.array(Camera),
  buyerOnline: z.boolean(),
  teach: TeachState.nullable(),
  /** Newest last, at most 20. */
  activity: z.array(Activity),
  season: Season,
});

// ---------- Offcut Supply's public catalog ----------

export const CatalogPack = z.object({
  /** For example "Box of 100" or "Case of 10 boxes". */
  label: z.string(),
  /** Units in this pack, in the product's base unit. */
  size: z.number().int().positive(),
  price: Money,
});

export const CatalogItem = z.object({
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  unit: z.string(),
  packs: z.array(CatalogPack).min(1),
  inStock: z.boolean(),
  leadDays: z.number().int().nonnegative(),
  url: z.string(),
});

export const Catalog = z.object({ currency: z.string(), items: z.array(CatalogItem) });

export type Zone = z.infer<typeof Zone>;
export type Product = z.infer<typeof Product>;
export type Count = z.infer<typeof Count>;
export type PickEvent = z.infer<typeof PickEvent>;
export type Reach = z.infer<typeof Reach>;
export type Policy = z.infer<typeof Policy>;
export type Season = z.infer<typeof Season>;
export type Supplier = z.infer<typeof Supplier>;
export type Quote = z.infer<typeof Quote>;
export type Run = z.infer<typeof Run>;
export type RunKind = z.infer<typeof RunKind>;
export type Order = z.infer<typeof Order>;
export type OrderState = z.infer<typeof OrderState>;
export type NodeStatus = z.infer<typeof NodeStatus>;
export type Camera = z.infer<typeof Camera>;
export type TeachState = z.infer<typeof TeachState>;
export type TeachSuggestion = z.infer<typeof TeachSuggestion>;
export type Activity = z.infer<typeof Activity>;
export type Screen = z.infer<typeof Screen>;
export type Snapshot = z.infer<typeof Snapshot>;
export type CatalogItem = z.infer<typeof CatalogItem>;
export type Catalog = z.infer<typeof Catalog>;
export type CatalogPack = z.infer<typeof CatalogPack>;
export type CameraId = z.infer<typeof CameraId>;
export type ZoneKind = z.infer<typeof ZoneKind>;
export type CountSource = z.infer<typeof CountSource>;
export type RunStatus = z.infer<typeof RunStatus>;
export type SupplierKind = z.infer<typeof SupplierKind>;
