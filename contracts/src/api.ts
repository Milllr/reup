// Request and response bodies for every hub route. contracts/api.md is the readable version of this file.
// Auth: ingest routes need "Authorization: Bearer DEVICE_TOKEN". Ops routes need OPS_TOKEN.
// Approve needs APPROVE_KEY (the phone link carries it) or DEVICE_TOKEN (the node's button).
import { z } from 'zod';
import { Camera, Count, Id, IsoTime, Money, NodeStatus, Order, PickEvent, Product, Quote, Reach, Run, Season, Snapshot, TeachState, Zone } from './schema';
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
export type TeachBody = z.infer<typeof TeachBody>;
export type TeachConfirmBody = z.infer<typeof TeachConfirmBody>;
export type ApproveBody = z.infer<typeof ApproveBody>;
export type ManualOrderBody = z.infer<typeof ManualOrderBody>;
export type ZonesBody = z.infer<typeof ZonesBody>;
export type BoardProduct = z.infer<typeof BoardProduct>;
export type BoardBody = z.infer<typeof BoardBody>;
export type ScreenBody = z.infer<typeof ScreenBody>;
export type ReplayBody = z.infer<typeof ReplayBody>;
export type SupplyWebhookBody = z.infer<typeof SupplyWebhookBody>;
