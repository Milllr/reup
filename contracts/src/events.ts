// Messages on the hub's WebSocket, GET /live?role=screen|ops|buyer.
// The hub sends a snapshot first, then one message per change. Clients never send state over the socket;
// they use the REST routes in api.ts. The only client message is a ping.
import { z } from 'zod';
import { Activity, Count, Id, NodeStatus, Order, PickEvent, Policy, Product, Quote, Reach, Run, Screen, Season, Snapshot, TeachState, Zone, Camera } from './schema';

/** Work the hub hands to the buyer. Sent only to sockets with role=buyer, and returned by GET /api/jobs. */
export const Job = z.discriminatedUnion('kind', [
  z.object({
    id: Id,
    kind: z.literal('market'),
    productId: Id,
    searchPhrase: z.string(),
    /** Market suppliers to check, one run each, all at once. */
    supplierIds: z.array(Id).min(1),
  }),
  z.object({
    id: Id,
    kind: z.literal('cart'),
    orderId: Id,
    productId: Id,
    supplierId: Id,
    sku: z.string().nullable(),
    searchPhrase: z.string(),
    units: z.number().int().positive(),
  }),
  z.object({
    id: Id,
    kind: z.literal('place'),
    orderId: Id,
    supplierId: Id,
    poNumber: z.string(),
  }),
  z.object({
    id: Id,
    kind: z.literal('track'),
    orderId: Id,
    supplierId: Id,
    confirmation: z.string(),
  }),
]);

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: Snapshot }),
  z.object({ type: z.literal('count'), count: Count }),
  z.object({ type: z.literal('pick'), pick: PickEvent }),
  z.object({ type: z.literal('reach'), reach: Reach }),
  z.object({ type: z.literal('policy'), policy: Policy }),
  z.object({ type: z.literal('product'), product: Product }),
  z.object({ type: z.literal('zones'), zones: z.array(Zone) }),
  z.object({ type: z.literal('quote'), quote: Quote }),
  z.object({ type: z.literal('run'), run: Run }),
  z.object({ type: z.literal('order'), order: Order }),
  z.object({ type: z.literal('node'), node: NodeStatus }),
  z.object({ type: z.literal('cameras'), cameras: z.array(Camera) }),
  z.object({ type: z.literal('buyer'), online: z.boolean() }),
  z.object({ type: z.literal('screen'), screen: Screen, focusProductId: Id.nullable() }),
  z.object({ type: z.literal('teach'), teach: TeachState.nullable() }),
  z.object({ type: z.literal('season'), season: Season }),
  z.object({ type: z.literal('activity'), activity: Activity }),
  z.object({ type: z.literal('job'), job: Job }),
  z.object({ type: z.literal('pong') }),
]);

export const ClientMessage = z.object({ type: z.literal('ping') });

export type Job = z.infer<typeof Job>;
export type ServerMessage = z.infer<typeof ServerMessage>;
export type ClientMessage = z.infer<typeof ClientMessage>;
