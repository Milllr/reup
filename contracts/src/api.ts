// Request and response bodies for every hub route. contracts/api.md is the readable version of this file.
// Auth: ingest routes need "Authorization: Bearer DEVICE_TOKEN". Ops routes need OPS_TOKEN.
// Approve needs APPROVE_KEY (the phone link carries it) or DEVICE_TOKEN (the node's button).
import { z } from 'zod';
import { Camera, Count, Id, IsoTime, Money, NodeStatus, Order, PickEvent, Point, Product, Quote, Reach, Run, Season, Snapshot, TeachState, Zone } from './schema';
import { Job } from './events';

export const Ok = z.object({ ok: z.literal(true) });
/** Every error response, with the matching HTTP status. */
export const ApiError = z.object({
  ok: z.literal(false),
  code: z.enum(['bad_request', 'unauthorized', 'not_found', 'conflict', 'upstream_failed']),
  message: z.string(),
});

// ---------- ingest: eye, node, buyer ----------

/** POST /ingest/counts (eye, node). Only changed, settled counts. Camera health can ride along, or go alone with an empty counts list. */
export const IngestCountsBody = z
  .object({ counts: z.array(Count), cameras: z.array(Camera).optional() })
  .refine((b) => b.counts.length > 0 || (b.cameras?.length ?? 0) > 0, { message: 'counts or cameras must have at least one entry', path: ['counts'] });
/** POST /ingest/picks (node, eye). Safe to resend: ids already seen are skipped. */
export const IngestPicksBody = z.object({ picks: z.array(PickEvent).min(1) });
export const IngestPicksResult = z.object({ ok: z.literal(true), accepted: z.number().int().nonnegative(), duplicates: z.number().int().nonnegative() });
/** POST /ingest/reaches (node). The hub marks picks within 2 seconds of a reach as handSeen and tells the screens. Safe to resend. */
export const IngestReachesBody = z.object({ reaches: z.array(Reach).min(1) });
/** POST /ingest/node (node). A heartbeat every 5 seconds. The hub marks the node offline after 15 seconds without one. */
export const IngestNodeBody = z.object({ status: NodeStatus });
/** What the node gets back with each heartbeat: what it needs to keep working alone. */
export const IngestNodeResult = z.object({
  ok: z.literal(true),
  zones: z.array(Zone),
  reorderPoints: z.array(z.object({ productId: Id, zoneId: Id, reorderPoint: z.number().int().nonnegative() })),
  /** Orders waiting for the button. The node approves the oldest one when the button is pressed. */
  awaitingApproval: z.array(Id),
});
/** POST /ingest/reorder (node). The node decided to reorder while it could not reach the hub. */
export const IngestReorderBody = z.object({ id: Id, productId: Id, countAfter: z.number().int().nonnegative(), ts: IsoTime });
/** POST /ingest/runs (buyer). The whole run each time it changes. */
export const IngestRunsBody = z.object({ run: Run });
/** POST /ingest/quotes (buyer). */
export const IngestQuotesBody = z.object({ jobId: Id, quotes: z.array(Quote) });
/** POST /ingest/cart (buyer). The cart run reached the review page, or failed. */
export const IngestCartBody = z.object({
  jobId: Id,
  orderId: Id,
  ok: z.boolean(),
  packSize: z.number().int().positive().nullable(),
  packs: z.number().int().positive().nullable(),
  unitPrice: Money.nullable(),
  total: Money.nullable(),
  deliveryDays: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
});
/** POST /ingest/placed (buyer). The place run finished. */
export const IngestPlacedBody = z.object({
  jobId: Id,
  orderId: Id,
  ok: z.boolean(),
  confirmation: z.string().nullable(),
  eta: IsoTime.nullable(),
  error: z.string().nullable(),
});
/** GET /api/jobs (buyer). Jobs not yet finished, oldest first. The buyer calls it on connect, in case it missed a socket message. */
export const JobsResult = z.object({ ok: z.literal(true), jobs: z.array(Job) });

// ---------- screens ----------

/** GET /api/state */
export const StateResult = Snapshot;

/** GET /api/products/:id/history */
export const HistoryResult = z.object({
  productId: Id,
  /** Oldest first, one entry per day, 30 days. */
  days: z.array(z.object({ day: z.string(), used: z.number().int().nonnegative(), endCount: z.number().int().nonnegative(), sample: z.boolean() })),
  /** The next 7 days. */
  forecast: z.array(z.object({ day: z.string(), expected: z.number().nonnegative(), low: z.number().nonnegative(), high: z.number().nonnegative() })),
  reorderPoint: z.number().int().nonnegative(),
});

/** One part on the Analytics page: where it stands, the 30 days behind it and the 60 days ahead. */
export const AnalyticsPart = z.object({
  productId: Id,
  name: z.string(),
  unit: z.string(),
  count: z.number().int().nonnegative(),
  capacity: z.number().int().positive().nullable(),
  /** Units used a day, after the season factor. */
  ratePerDay: z.number().nonnegative(),
  reorderPoint: z.number().int().nonnegative(),
  leadDays: z.number().nonnegative(),
  /** Days until the board is empty at this rate. Null when the part is not in use. */
  daysOfCover: z.number().nonnegative().nullable(),
  /** The local day reup next orders it by its own rule, within the days ahead. Null when it does not, or an order is already open. */
  reorderOn: z.string().nullable(),
  /** The local day the board would be empty if nothing were ordered. Null when the part is not in use. */
  runsOutOn: z.string().nullable(),
  /** What one unit costs at the account supplier, from its last quote or the store catalog. Null when neither says. */
  unitPrice: Money.nullable(),
  /** Oldest first, one entry per completed local day, 30 days. sample marks history that was made up for the demo, not seen. */
  days: z.array(z.object({ day: z.string(), used: z.number().int().nonnegative(), restocked: z.number().int().nonnegative(), endCount: z.number().int().nonnegative(), sample: z.boolean() })),
  /** Today so far, as the cameras saw it. */
  today: z.object({ used: z.number().int().nonnegative(), restocked: z.number().int().nonnegative() }),
  /** The next 60 days if reup keeps ordering by its own rule. expected is the end of the day. ordered and arrives are units. */
  projection: z.array(z.object({ day: z.string(), expected: z.number().nonnegative(), low: z.number().nonnegative(), high: z.number().nonnegative(), ordered: z.number().int().nonnegative(), arrives: z.number().int().nonnegative() })),
});

/** GET /api/analytics. Everything the Analytics page draws, for every part on the board, in one answer. */
export const AnalyticsResult = z.object({
  now: IsoTime,
  /** The local day that now falls in. */
  today: z.string(),
  parts: z.array(AnalyticsPart),
  /** Every change of a count in the last 24 hours, oldest first, at most 400. Kept through a demo reset: it is the record of the day. */
  trail: z.array(z.object({ productId: Id, ts: IsoTime, delta: z.number().int(), countAfter: z.number().int().nonnegative() })),
  /** Every order reup placed, newest first, at most 50. Kept through a demo reset, with the part's name as it was then. */
  placed: z.array(z.object({ poNumber: z.string(), productId: Id, name: z.string(), units: z.number().int().positive(), total: Money.nullable(), confirmation: z.string(), ts: IsoTime })),
});

/** POST /api/ask (no token). A plain question about use, stock and orders, answered from the hub's own data. */
export const AskBody = z.object({ question: z.string().trim().min(1).max(200) });
export const AskResult = z.object({
  /** One or two plain sentences with numbers. */
  answer: z.string().min(1),
  /** gemini: the model answered from the facts. fallback: no key, or the model failed, and the hub answered by itself. */
  source: z.enum(['gemini', 'fallback']),
  /** The fact lines the answer rests on, as short plain text. Empty when the data does not answer the question. */
  facts: z.array(z.string()),
});

// ---------- teaching ----------

/** POST /api/teach (eye). A new item is sitting on the teach spot. jpegBase64 is the crop, at most 400 kB. */
export const TeachBody = z.object({ jpegBase64: z.string().min(1), zoneId: Id.nullable() });
export const TeachResult = TeachState;
/** POST /api/teach/:id/confirm (phone or ops). The person may have edited the suggestion. */
export const TeachConfirmBody = z.object({ name: z.string().min(1), unit: z.string().min(1), sku: z.string().nullable(), searchPhrase: z.string().min(1), zoneId: Id });
export const TeachConfirmResult = Product;
/** POST /api/teach/:id/cancel */

// ---------- orders ----------

/** POST /api/orders/:id/approve */
export const ApproveBody = z.object({ by: z.enum(['button', 'phone', 'keyboard']) });
export const OrderResult = Order;
/** POST /api/orders/:id/cancel (ops) */
/** POST /api/orders (ops). Start an order by hand for a product. */
export const ManualOrderBody = z.object({ productId: Id, units: z.number().int().positive().optional() });

// ---------- count checks ----------

/**
 * POST /api/checks/:id (phone or ops). right: the drop was real, so the order opens as usual.
 * miscount: the camera misread, so the check closes and nothing is bought.
 */
export const CheckAnswerBody = z.object({ answer: z.enum(['right', 'miscount']) });

// ---------- items ----------

/**
 * POST /api/products (approve key or ops token). A person adds an item in the dashboard.
 * zoneId is a free zone a camera sees, or null for an item counted by hand. count is what is on the shelf now:
 * for a camera zone it stands until the camera reports its own.
 */
export const ProductAddBody = z.object({
  name: z.string().trim().min(1).max(80),
  unit: z.string().trim().min(1).max(40),
  /** The Offcut Supply SKU it is bought as, or null when it is not matched yet. */
  sku: z.string().trim().min(1).max(40).nullable(),
  /** What to type into a store's search box. Left out, it is the name. */
  searchPhrase: z.string().trim().min(1).max(120).optional(),
  zoneId: Id.nullable(),
  count: z.number().int().nonnegative().max(9999),
  /**
   * Units used a day, from the shop's own records: an export of its inventory system. Given, the item's reorder point
   * comes from this figure. Left out, the item gets sample use like any part set up on the board.
   */
  usePerDay: z.number().nonnegative().max(999).optional(),
});

/** PUT /api/products/:id (approve key or ops token). Only the fields given change. */
export const ProductEditBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  unit: z.string().trim().min(1).max(40).optional(),
  sku: z.string().trim().min(1).max(40).nullable().optional(),
  searchPhrase: z.string().trim().min(1).max(120).optional(),
});

/** POST /api/products/:id/count (approve key or ops token). The count a person read off the shelf. Answers with the Count of record. */
export const ProductCountBody = z.object({ count: z.number().int().nonnegative().max(9999) });

/** POST /api/zones/:id/quad (approve key or ops). Moves one zone's four corners on its camera's picture. Nothing else about the zone changes. */
export const ZoneQuadBody = z.object({ quad: z.array(Point).length(4) });

// ---------- operator ----------

/** PUT /api/zones (ops). Replaces every zone. */
export const ZonesBody = z.object({ zones: z.array(Zone) });
/** One part on the board. The zone that holds it names it with productId. */
export const BoardProduct = z.object({
  id: Id,
  name: z.string(),
  unit: z.string(),
  sku: z.string().nullable(),
  searchPhrase: z.string(),
  /** How many the zone holds when full. Null or left out for a ledge: the hub learns it from what is stocked. */
  capacity: z.number().int().positive().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
});
/**
 * PUT /api/board (ops). Sets up the station: replaces every zone and every part, cancels open orders and clears the demo.
 * A part with no capacity holds what is stocked: its capacity follows the most the board has held since the last reset,
 * and its sample use is sized so that taking two crosses its reorder point.
 */
export const BoardBody = z.object({ zones: z.array(Zone), products: z.array(BoardProduct) });
/** POST /api/demo/season (ops) */
export const SeasonBody = Season;
/** POST /api/demo/reset (ops). Cancels open orders, clears runs and activity, restores seeded history and policies. Zones and products stay. */
/** POST /api/demo/screen (ops). Force a screen, or null to let the hub choose again. */
export const ScreenBody = z.object({ screen: z.enum(['shelf', 'shop', 'order', 'why']).nullable(), focusProductId: Id.nullable() });
/** POST /api/demo/replay (ops). Play the last good recorded run of a kind in place of a live one. */
export const ReplayBody = z.object({ kind: z.enum(['market', 'cart', 'place']), on: z.boolean() });

// ---------- webhooks ----------

/** POST /hooks/supply (Offcut Supply). Header X-Offcut-Secret must equal SUPPLY_WEBHOOK_SECRET. */
export const SupplyWebhookBody = z.object({
  event: z.enum(['order.confirmed', 'order.shipped', 'order.delivered']),
  confirmation: z.string(),
  poNumber: z.string(),
  eta: IsoTime.nullable(),
});

/** One line per route, for tests and for the readable doc. */
export const ROUTES = [
  ['GET', '/live', 'WebSocket. role=screen|ops|buyer. Sends ServerMessage.'],
  ['GET', '/api/state', 'Snapshot'],
  ['GET', '/api/products/:id/history', 'HistoryResult'],
  ['GET', '/api/analytics', 'AnalyticsResult'],
  ['GET', '/api/catalog', 'Catalog'],
  ['POST', '/api/ask', 'AskBody -> AskResult (no token)'],
  ['GET', '/api/jobs', 'JobsResult (device token)'],
  ['POST', '/ingest/counts', 'IngestCountsBody -> Ok (device token)'],
  ['POST', '/ingest/picks', 'IngestPicksBody -> IngestPicksResult (device token)'],
  ['POST', '/ingest/reaches', 'IngestReachesBody -> Ok (device token)'],
  ['POST', '/ingest/node', 'IngestNodeBody -> IngestNodeResult (device token)'],
  ['POST', '/ingest/reorder', 'IngestReorderBody -> Ok (device token)'],
  ['POST', '/ingest/runs', 'IngestRunsBody -> Ok (device token)'],
  ['POST', '/ingest/quotes', 'IngestQuotesBody -> Ok (device token)'],
  ['POST', '/ingest/cart', 'IngestCartBody -> Ok (device token)'],
  ['POST', '/ingest/placed', 'IngestPlacedBody -> Ok (device token)'],
  ['POST', '/api/teach', 'TeachBody -> TeachResult (device token)'],
  ['POST', '/api/teach/:id/confirm', 'TeachConfirmBody -> TeachConfirmResult (approve key or ops token)'],
  ['POST', '/api/teach/:id/cancel', 'Ok (approve key, ops token or device token)'],
  ['POST', '/api/orders', 'ManualOrderBody -> OrderResult (ops token)'],
  ['POST', '/api/orders/:id/approve', 'ApproveBody -> OrderResult (approve key or device token)'],
  ['POST', '/api/orders/:id/cancel', 'OrderResult (ops token)'],
  ['POST', '/api/checks/:id', 'CheckAnswerBody -> Ok (approve key or ops token)'],
  ['POST', '/api/products', 'ProductAddBody -> Product (approve key or ops token)'],
  ['PUT', '/api/products/:id', 'ProductEditBody -> Product (approve key or ops token)'],
  ['POST', '/api/products/:id/count', 'ProductCountBody -> Count (approve key or ops token)'],
  ['POST', '/api/zones/:id/quad', 'ZoneQuadBody -> Zone (approve key or ops token)'],
  ['POST', '/api/products/:id/remove', 'Ok (approve key or ops token)'],
  ['PUT', '/api/zones', 'ZonesBody -> Ok (ops token)'],
  ['PUT', '/api/board', 'BoardBody -> Snapshot (ops token)'],
  ['POST', '/api/demo/season', 'SeasonBody -> Ok (ops token)'],
  ['POST', '/api/demo/reset', 'Snapshot (ops token)'],
  ['POST', '/api/demo/screen', 'ScreenBody -> Ok (ops token)'],
  ['POST', '/api/demo/replay', 'ReplayBody -> Ok (ops token)'],
  ['POST', '/hooks/supply', 'SupplyWebhookBody -> Ok (store secret)'],
] as const;

export type ApiError = z.infer<typeof ApiError>;
export type IngestCountsBody = z.infer<typeof IngestCountsBody>;
export type IngestPicksBody = z.infer<typeof IngestPicksBody>;
export type IngestPicksResult = z.infer<typeof IngestPicksResult>;
export type IngestReachesBody = z.infer<typeof IngestReachesBody>;
export type IngestNodeBody = z.infer<typeof IngestNodeBody>;
export type IngestNodeResult = z.infer<typeof IngestNodeResult>;
export type IngestReorderBody = z.infer<typeof IngestReorderBody>;
export type IngestRunsBody = z.infer<typeof IngestRunsBody>;
export type IngestQuotesBody = z.infer<typeof IngestQuotesBody>;
export type IngestCartBody = z.infer<typeof IngestCartBody>;
export type IngestPlacedBody = z.infer<typeof IngestPlacedBody>;
export type JobsResult = z.infer<typeof JobsResult>;
export type HistoryResult = z.infer<typeof HistoryResult>;
export type AnalyticsPart = z.infer<typeof AnalyticsPart>;
export type AnalyticsResult = z.infer<typeof AnalyticsResult>;
export type AskBody = z.infer<typeof AskBody>;
export type AskResult = z.infer<typeof AskResult>;
export type TeachBody = z.infer<typeof TeachBody>;
export type TeachConfirmBody = z.infer<typeof TeachConfirmBody>;
export type ApproveBody = z.infer<typeof ApproveBody>;
export type ManualOrderBody = z.infer<typeof ManualOrderBody>;
export type CheckAnswerBody = z.infer<typeof CheckAnswerBody>;
export type ProductAddBody = z.infer<typeof ProductAddBody>;
export type ProductEditBody = z.infer<typeof ProductEditBody>;
export type ProductCountBody = z.infer<typeof ProductCountBody>;
export type ZoneQuadBody = z.infer<typeof ZoneQuadBody>;
export type ZonesBody = z.infer<typeof ZonesBody>;
export type BoardProduct = z.infer<typeof BoardProduct>;
export type BoardBody = z.infer<typeof BoardBody>;
export type ScreenBody = z.infer<typeof ScreenBody>;
export type ReplayBody = z.infer<typeof ReplayBody>;
export type SupplyWebhookBody = z.infer<typeof SupplyWebhookBody>;
