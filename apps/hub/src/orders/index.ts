// Orders: from a count at the reorder point to a delivery back on the board.
// pricing, carting, awaiting_approval, approved, placing, placed, shipped, received. Or failed, or cancelled.
import { marketNote, money, orderReason, unitsText } from '@reup/brain';
import type { IngestCartBody, IngestPlacedBody, IngestQuotesBody, IngestReorderBody, IngestRunsBody, Job, Order, Quote } from '@reup/contracts';
import type { RoomCore } from '../core/room';
import { businessDaysFrom, weekdayIn } from '../core/time';

export class Conflict extends Error {}
export class NotFound extends Error {}

const TEN_MINUTES = 10 * 60 * 1000;
export const NOTHING_BOUGHT = 'Nothing was bought.';

/** Stamps, logs, tells the screens, and lets the screen follow. Every order change goes through here. */
export function saveOrder(room: RoomCore, order: Order): Order {
  order.updatedAt = room.iso();
  room.deps.history.order(order);
  room.emit({ type: 'order', order });
  room.refreshScreen();
  return order;
}

function fail(room: RoomCore, order: Order, error: string): Order {
  order.state = 'failed';
  order.error = error;
  room.x.jobs = room.x.jobs.filter((j) => !('orderId' in j) || j.orderId !== order.id);
  room.holdScreen(order.id);
  room.activity('error', error);
  return saveOrder(room, order);
}

const accountSupplier = (room: RoomCore) => room.s.suppliers.find((s) => s.kind === 'account');
const marketSuppliers = (room: RoomCore) => room.s.suppliers.filter((s) => s.kind === 'market');

function freshMarketQuotes(room: RoomCore, productId: string): boolean {
  const markets = marketSuppliers(room);
  if (markets.length === 0) return true;
  const now = room.nowMs();
  return markets.every((m) => room.s.quotes.some((q) => q.productId === productId && q.supplierId === m.id && now - Date.parse(q.fetchedAt) < TEN_MINUTES));
}

/** Opens an order for a product and hands the buyer its jobs. Throws Conflict when one is already open. */
export function openOrder(room: RoomCore, productId: string, trigger: Order['trigger'], units?: number): Order {
  const product = room.product(productId);
  if (!product) throw new NotFound(`No product ${productId}.`);
  if (room.openOrderFor(productId)) throw new Conflict('This product already has an open order.');
  const supplier = accountSupplier(room);
  if (!supplier) throw new Conflict('No account supplier is set up.');
  const policy = room.policy(productId) ?? room.recomputePolicy(productId);
  const count = room.count(productId)?.count ?? 0;
  const qty = Math.max(1, units ?? policy?.orderQty ?? 1);
  room.x.poSeq += 1;
  const now = room.iso();
  const order: Order = {
    id: room.id('o'),
    productId,
    supplierId: supplier.id,
    state: 'pricing',
    units: qty,
    packs: qty,
    packSize: 1,
    unitPrice: null,
    total: null,
    currency: 'CAD',
    reason: orderReason(qty, product.unit, count, product.capacity, policy?.daysOfCover ?? null, policy?.leadDays ?? 2),
    marketNote: null,
    poNumber: `RU-${room.x.poSeq}`,
    confirmation: null,
    eta: null,
    approvedBy: null,
    trigger,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  room.s.orders.push(order);
  if (room.s.orders.length > 20) room.s.orders.splice(0, room.s.orders.length - 20);

  const markets = marketSuppliers(room);
  const checkMarket = markets.length > 0 && !freshMarketQuotes(room, productId);
  if (checkMarket) {
    const job: Job = { id: room.id('j'), kind: 'market', productId, searchPhrase: product.searchPhrase, supplierIds: markets.map((m) => m.id), replay: room.x.replay.market };
    room.emitJob(job);
  }
  room.emitJob({ id: room.id('j'), kind: 'cart', orderId: order.id, productId, supplierId: supplier.id, sku: product.sku, searchPhrase: product.searchPhrase, units: qty, replay: room.x.replay.cart });

  if (trigger === 'hub') room.holdShelf(order.id);
  saveOrder(room, order);
  const retailers = `${markets.length} ${markets.length === 1 ? 'retailer' : 'retailers'}`;
  room.activity('working', checkMarket ? `Checking ${retailers} and filling a cart at ${supplier.name}.` : `Filling a cart at ${supplier.name}.`);
  if (!room.s.buyerOnline) room.activity('error', 'The buyer is offline.');
  return order;
}

/** Called after the count of record for a product changed. */
export function afterCountChange(room: RoomCore, productId: string, before: number, after: number): void {
  const product = room.product(productId);
  if (!product) return;
  const waiting = room.s.orders.find((o) => o.productId === productId && (o.state === 'placed' || o.state === 'shipped'));
  if (waiting && after > before) {
    waiting.state = 'received';
    saveOrder(room, waiting);
    room.activity('info', `${unitsText(after - before, product.unit)} of ${product.name.toLowerCase()} arrived. Order ${waiting.poNumber} is done.`);
    return;
  }
  const policy = room.policy(productId);
  if (!policy || after > policy.reorderPoint || room.openOrderFor(productId)) return;
  const name = room.zone(product.zoneId)?.name ?? product.name;
  const many = /s$/.test(name);
  room.activity('attention', after === 0 ? `${name} ran out.` : `${name} ${many ? 'are' : 'is'} at the reorder point.`);
  openOrder(room, productId, 'hub');
}

export function ingestReorder(room: RoomCore, body: IngestReorderBody): void {
  if (!room.firstTime(`reorder:${body.id}`)) return;
  if (!room.product(body.productId) || room.openOrderFor(body.productId)) return;
  room.activity('attention', 'The shelf node called for a reorder while it was offline.');
  openOrder(room, body.productId, 'node');
}

export function ingestRuns(room: RoomCore, body: IngestRunsBody): void {
  const run = body.run;
  const i = room.s.runs.findIndex((r) => r.id === run.id);
  if (i >= 0) room.s.runs[i] = run;
  else room.s.runs.push(run);
  if (room.s.runs.length > 30) room.s.runs.splice(0, room.s.runs.length - 30);
  room.deps.history.run(run);
  room.emit({ type: 'run', run });
  const order = run.orderId ? room.order(run.orderId) : undefined;
  if (!order || run.status !== 'running') return;
  if (run.kind === 'cart' && order.state === 'pricing') {
    order.state = 'carting';
    saveOrder(room, order);
  }
  if (run.kind === 'place' && order.state === 'approved') {
    order.state = 'placing';
    saveOrder(room, order);
  }
}

function refreshMarketNote(room: RoomCore, order: Order): void {
  const product = room.product(order.productId);
  if (!product) return;
  order.marketNote = marketNote(order.unitPrice, room.s.quotes.filter((q) => q.productId === order.productId), room.s.suppliers, product.unit);
}

function storeQuote(room: RoomCore, quote: Quote): void {
  room.s.quotes = room.s.quotes.filter((q) => !(q.productId === quote.productId && q.supplierId === quote.supplierId));
  room.s.quotes.push(quote);
  if (room.s.quotes.length > 40) room.s.quotes.splice(0, room.s.quotes.length - 40);
  room.deps.history.quote(quote);
  room.emit({ type: 'quote', quote });
}

export function ingestQuotes(room: RoomCore, body: IngestQuotesBody): void {
  for (const quote of body.quotes) storeQuote(room, quote);
  room.finishJob(body.jobId);
  for (const order of room.s.orders) {
    if (order.state !== 'awaiting_approval' || !body.quotes.some((q) => q.productId === order.productId)) continue;
    const before = order.marketNote;
    refreshMarketNote(room, order);
    if (order.marketNote !== before) saveOrder(room, order);
  }
}

export function ingestCart(room: RoomCore, body: IngestCartBody): Order {
  const order = room.order(body.orderId);
  if (!order) throw new NotFound(`No order ${body.orderId}.`);
  room.finishJob(body.jobId);
  if (order.state !== 'pricing' && order.state !== 'carting') throw new Conflict(`Order ${order.id} is ${order.state}, not waiting for a cart.`);
  const supplier = room.s.suppliers.find((s) => s.id === order.supplierId);
  if (!body.ok || body.unitPrice == null || body.total == null) {
    return fail(room, order, `Could not fill the cart${body.error ? `: ${body.error.replace(/\.$/, '')}` : ''}. ${NOTHING_BOUGHT}`);
  }
  order.packSize = body.packSize ?? 1;
  order.packs = body.packs ?? Math.ceil(order.units / order.packSize);
  order.unitPrice = body.unitPrice;
  order.total = body.total;
  const lead = body.deliveryDays ?? room.x.leadDays[order.productId] ?? 2;
  order.eta = room.iso(businessDaysFrom(new Date(room.nowMs()), lead, room.config.TIME_ZONE).getTime());
  if (body.deliveryDays != null && room.x.leadDays[order.productId] !== body.deliveryDays) {
    room.x.leadDays[order.productId] = body.deliveryDays;
    room.recomputePolicy(order.productId);
  }
  storeQuote(room, {
    id: room.id('q'), productId: order.productId, supplierId: order.supplierId, listingName: room.product(order.productId)?.name ?? null, packSize: order.packSize,
    price: Math.round(body.unitPrice * order.packSize * 100) / 100, currency: order.currency, unitPrice: body.unitPrice, inStock: true, deliveryDays: lead, url: null, runId: null, ok: true, fetchedAt: room.iso(),
  });
  refreshMarketNote(room, order);
  order.state = 'awaiting_approval';
  saveOrder(room, order);
  room.activity('attention', `The cart is ready at ${supplier?.name ?? 'the supplier'}. Waiting for a yes.`);
  return order;
}

function spentToday(room: RoomCore): number {
  if (room.x.spend.day !== room.today()) room.x.spend = { day: room.today(), total: 0 };
  const inFlight = room.s.orders.filter((o) => o.state === 'approved' || o.state === 'placing').reduce((sum, o) => sum + (o.total ?? 0), 0);
  return room.x.spend.total + inFlight;
}

export function approve(room: RoomCore, orderId: string, by: 'button' | 'phone'): Order {
  const order = room.order(orderId);
  if (!order) throw new NotFound(`No order ${orderId}.`);
  if (order.state !== 'awaiting_approval') throw new Conflict(`Order ${order.poNumber} is ${order.state.replace('_', ' ')}. Only an order waiting for approval can be approved.`);
  const total = order.total ?? 0;
  if (total > room.config.ORDER_CAP_CAD) return fail(room, order, `${money(total)} is over the spend cap of $${room.config.ORDER_CAP_CAD} an order. ${NOTHING_BOUGHT}`);
  if (spentToday(room) + total > room.config.DAY_CAP_CAD) return fail(room, order, `This order would pass the spend cap of $${room.config.DAY_CAP_CAD} a day. ${NOTHING_BOUGHT}`);
  order.state = 'approved';
  order.approvedBy = by;
  room.emitJob({ id: room.id('j'), kind: 'place', orderId: order.id, supplierId: order.supplierId, poNumber: order.poNumber, replay: room.x.replay.place });
  saveOrder(room, order);
  const supplier = room.s.suppliers.find((s) => s.id === order.supplierId);
  room.activity('working', `Placing the order at ${supplier?.name ?? 'the supplier'}.`);
  return order;
}

/** The order is in at the store. Used by the buyer's result and by the store's webhook, whichever lands first. */
export function markPlaced(room: RoomCore, order: Order, confirmation: string, eta: string | null): Order {
  const first = order.state !== 'placed' && order.state !== 'shipped' && order.state !== 'received';
  order.confirmation = confirmation;
  if (eta) order.eta = eta;
  if (!first) return saveOrder(room, order);
  order.state = 'placed';
  if (room.x.spend.day !== room.today()) room.x.spend = { day: room.today(), total: 0 };
  room.x.spend.total += order.total ?? 0;
  room.x.jobs = room.x.jobs.filter((j) => !('orderId' in j) || j.orderId !== order.id);
  room.holdScreen(order.id);
  saveOrder(room, order);
  room.activity('info', `Ordered. Confirmation ${confirmation}.${order.eta ? ` Arrives ${weekdayIn(order.eta, room.config.TIME_ZONE)}.` : ''}`);
  return order;
}

export function ingestPlaced(room: RoomCore, body: IngestPlacedBody): Order {
  const order = room.order(body.orderId);
  if (!order) throw new NotFound(`No order ${body.orderId}.`);
  room.finishJob(body.jobId);
  if (order.state === 'placed' || order.state === 'shipped' || order.state === 'received') return order;
  if (order.state !== 'approved' && order.state !== 'placing') throw new Conflict(`Order ${order.id} is ${order.state}, not being placed.`);
  if (!body.ok || !body.confirmation) return fail(room, order, `Could not place the order${body.error ? `: ${body.error.replace(/\.$/, '')}` : ''}. ${NOTHING_BOUGHT}`);
  return markPlaced(room, order, body.confirmation, body.eta);
}

export function cancel(room: RoomCore, orderId: string): Order {
  const order = room.order(orderId);
  if (!order) throw new NotFound(`No order ${orderId}.`);
  if (['placed', 'shipped', 'received'].includes(order.state)) throw new Conflict(`Order ${order.poNumber} is already ${order.state}. It cannot be cancelled here.`);
  if (order.state === 'cancelled' || order.state === 'failed') return order;
  order.state = 'cancelled';
  room.x.jobs = room.x.jobs.filter((j) => !('orderId' in j) || j.orderId !== order.id);
  saveOrder(room, order);
  room.activity('info', `Order ${order.poNumber} cancelled. ${NOTHING_BOUGHT}`);
  return order;
}
