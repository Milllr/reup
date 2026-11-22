// Orders: from a count at the reorder point to a delivery back on the board.
// pricing, carting, awaiting_approval, approved, placing, placed, shipped, received. Or failed, or cancelled.
import { marketNote, money, orderReason, unitsText } from '@reup/brain';
import type { CheckAnswerBody, CountSource, IngestCartBody, IngestPlacedBody, IngestQuotesBody, IngestReorderBody, IngestRunsBody, Job, Order, Quote } from '@reup/contracts';
import { PLACED_MAX, type RoomCore } from '../core/room';
import { businessDaysFrom, weekdayIn } from '../core/time';
import { closeCheck, checks, openCheckFor, raiseCheck, unusualDrop } from '../checks';

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
  // No second price check while one for this part is still running: a box put back and taken again must not shop twice.
  const checking = room.x.jobs.some((j) => j.kind === 'market' && j.productId === productId);
  const checkMarket = markets.length > 0 && !checking && !freshMarketQuotes(room, productId);
  if (checkMarket) {
    const job: Job = { id: room.id('j'), kind: 'market', productId, searchPhrase: product.searchPhrase, supplierIds: markets.map((m) => m.id), replay: room.x.replay.market };
    room.emitJob(job);
  }
  room.emitJob({ id: room.id('j'), kind: 'cart', orderId: order.id, productId, supplierId: supplier.id, sku: product.sku, searchPhrase: product.searchPhrase, units: qty, replay: room.x.replay.cart });

  if (trigger === 'hub') room.holdShelf(order.id);
  room.heardFrom(order.id);
  saveOrder(room, order);
  const retailers = `${markets.length} ${markets.length === 1 ? 'retailer' : 'retailers'}`;
  room.activity('working', checkMarket ? `Checking ${retailers} and filling a cart at ${supplier.name}.` : `Filling a cart at ${supplier.name}.`);
  if (!room.s.buyerOnline) room.activity('error', 'The buyer is offline.');
  return order;
}

const NOT_APPROVED = ['pricing', 'carting', 'awaiting_approval'];
const ON_ITS_WAY = ['placed', 'shipped'];

/** True while an order for this part has been placed and has not all come in. A count that rises then is the delivery. */
export function deliveryExpected(room: RoomCore, productId: string): boolean {
  return room.s.orders.some((o) => o.productId === productId && ON_ITS_WAY.includes(o.state));
}

/** Counts a delivery in as the board fills. The order is done when all of it is in, or when the board is full. */
function trackDelivery(room: RoomCore, order: Order, capacity: number | null, unit: string, before: number, after: number): void {
  const mark = (room.x.deliveries[order.id] ??= { low: before });
  // Someone took one while the delivery was on its way: what comes in is measured from the new low.
  if (after < mark.low) mark.low = after;
  const cameIn = Math.max(0, after - mark.low);
  const full = capacity != null && after >= capacity;
  order.unitsReceived = Math.min(order.units, cameIn);
  if (after > before && (cameIn >= order.units || full)) {
    order.state = 'received';
    delete room.x.deliveries[order.id];
    saveOrder(room, order);
    room.activity('info', cameIn >= order.units ? `All ${unitsText(order.units, unit)} are in. Order ${order.poNumber} is done.` : `The board is full. Order ${order.poNumber} is done.`);
    return;
  }
  saveOrder(room, order);
}

/** Cancels an order nobody has said yes to, because the board changed under it. */
export function withdraw(room: RoomCore, order: Order, why: string): void {
  order.state = 'cancelled';
  room.x.jobs = room.x.jobs.filter((j) => !('orderId' in j) || j.orderId !== order.id);
  delete room.x.shopAfter[order.id];
  saveOrder(room, order);
  room.activity('info', `${why} Order ${order.poNumber} cancelled. ${NOTHING_BOUGHT}`);
}

/**
 * Called after the count of record for a product changed, up or down. source is who counted it, when known:
 * a camera drop far bigger than normal use is held as a count check instead of shopping.
 */
export function afterCountChange(room: RoomCore, productId: string, before: number, after: number, source: CountSource | null = null, zoneId: string | null = null): void {
  const product = room.product(productId);
  if (!product) return;
  const name = room.zone(product.zoneId)?.name ?? product.name;
  const many = /s$/.test(name);

  // 0. A count check is open and the count came back above the reorder point: it was a misread.
  const check = openCheckFor(room, productId);
  if (check && after > before) {
    const line = room.policy(productId)?.reorderPoint;
    if (line == null || after > line) {
      closeCheck(room, check.id);
      room.activity('info', `The count of ${name.toLowerCase()} came back. ${NOTHING_BOUGHT}`);
    }
  }

  // 1. An order is on its way: this is the delivery arriving (or one more taken while waiting for it).
  const waiting = room.s.orders.find((o) => o.productId === productId && ON_ITS_WAY.includes(o.state));
  if (waiting) {
    trackDelivery(room, waiting, product.capacity, product.unit, before, after);
    return;
  }

  // 2. Parts were put back while an order was still being shopped or waiting for a yes.
  const pending = room.s.orders.find((o) => o.productId === productId && NOT_APPROVED.includes(o.state));
  if (pending && after > before) {
    const line = room.policy(productId)?.reorderPoint;
    if (line != null && after > line) {
      withdraw(room, pending, `${name} ${many ? 'are' : 'is'} back above the reorder point.`);
      return;
    }
    // Still low, but the order was sized for an emptier board and would no longer fit. Shop again for the right amount.
    if (product.capacity != null && pending.units > product.capacity - after) {
      withdraw(room, pending, `The count of ${name.toLowerCase()} changed.`);
      openOrder(room, productId, pending.trigger);
      return;
    }
  }

  const policy = room.policy(productId);
  // A part with no use yet has no reorder point to cross.
  if (!policy || policy.ratePerDay <= 0 || after > policy.reorderPoint || room.openOrderFor(productId)) return;
  // A check is waiting for a person: no order until they answer.
  if (openCheckFor(room, productId)) return;
  if (unusualDrop(room, productId, before, after, source)) {
    raiseCheck(room, productId, zoneId ?? product.zoneId ?? productId, before, after);
    return;
  }
  room.activity('attention', after === 0 ? `${name} ran out.` : `${name} ${many ? 'are' : 'is'} at the reorder point.`);
  openOrder(room, productId, 'hub');
}

/** A person answered a count check. right: the drop was real, so shop as usual. miscount: close it, buy nothing. */
export function answerCheck(room: RoomCore, id: string, answer: CheckAnswerBody['answer']): void {
  const check = checks(room).find((c) => c.id === id);
  if (!check) throw new NotFound(`No count check ${id}.`);
  closeCheck(room, id);
  const product = room.product(check.productId);
  const name = (room.zone(product?.zoneId)?.name ?? product?.name ?? 'the part').toLowerCase();
  if (answer === 'miscount') {
    room.activity('info', `Marked as a miscount of ${name}. ${NOTHING_BOUGHT}`);
    room.refreshScreen();
    return;
  }
  const policy = room.policy(check.productId);
  const count = room.count(check.productId)?.count ?? check.after;
  if (!policy || count > policy.reorderPoint || room.openOrderFor(check.productId)) {
    room.activity('info', `Checked. The count of ${name} is right.`);
    room.refreshScreen();
    return;
  }
  room.activity('attention', `Checked. The count of ${name} is right.`);
  openOrder(room, check.productId, 'hub');
}

export function ingestReorder(room: RoomCore, body: IngestReorderBody): void {
  if (!room.firstTime(`reorder:${body.id}`)) return;
  if (!room.product(body.productId)) return;
  // The hub is holding this part for a count check. The node's call waits for the same answer.
  if (openCheckFor(room, body.productId)) return;
  // The call was made offline. If the parts were put back before it got here, there is nothing to order.
  const line = room.policy(body.productId)?.reorderPoint;
  const seen = room.count(body.productId);
  if (line != null && seen && seen.count > line && Date.parse(seen.ts) > Date.parse(body.ts)) return;
  const open = room.openOrderFor(body.productId);
  if (open) {
    // The node's count arrived just before its call and already opened the order. The call was still the node's.
    if (open.trigger === 'hub' && ['pricing', 'carting', 'awaiting_approval'].includes(open.state)) {
      open.trigger = 'node';
      saveOrder(room, open);
      room.activity('attention', 'The shelf node called for this reorder while it was offline.');
    }
    return;
  }
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
  // Any word from the buyer keeps its orders waiting: a run for the order itself, or a price check for its part.
  if (order) room.heardFrom(order.id);
  else if (run.productId) for (const o of room.s.orders) if (o.productId === run.productId && o.state === 'pricing') room.heardFrom(o.id);
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

export function approve(room: RoomCore, orderId: string, by: NonNullable<Order['approvedBy']>): Order {
  const order = room.order(orderId);
  if (!order) throw new NotFound(`No order ${orderId}.`);
  if (order.state !== 'awaiting_approval') throw new Conflict(`Order ${order.poNumber} is ${order.state.replace('_', ' ')}. Only an order waiting for approval can be approved.`);
  const total = order.total ?? 0;
  if (total > room.config.ORDER_CAP_CAD) return fail(room, order, `${money(total)} is over the spend cap of $${room.config.ORDER_CAP_CAD} an order. ${NOTHING_BOUGHT}`);
  if (spentToday(room) + total > room.config.DAY_CAP_CAD) return fail(room, order, `This order would pass the spend cap of $${room.config.DAY_CAP_CAD} a day. ${NOTHING_BOUGHT}`);
  order.state = 'approved';
  order.approvedBy = by;
  room.heardFrom(order.id);
  room.emitJob({ id: room.id('j'), kind: 'place', orderId: order.id, supplierId: order.supplierId, poNumber: order.poNumber, replay: room.x.replay.place });
  saveOrder(room, order);
  const supplier = room.s.suppliers.find((s) => s.id === order.supplierId);
  room.activity('working', `Placing the order at ${supplier?.name ?? 'the supplier'}.`);
  return order;
}

/** True for an order that had its yes and then failed: the store may have it all the same. */
export const gaveUpPlacing = (order: Order) => order.state === 'failed' && order.approvedBy != null;

/** The order is in at the store. Used by the buyer's result and by the store's webhook, whichever lands first. */
export function markPlaced(room: RoomCore, order: Order, confirmation: string, eta: string | null): Order {
  const first = order.state !== 'placed' && order.state !== 'shipped' && order.state !== 'received';
  order.confirmation = confirmation;
  if (eta) order.eta = eta;
  if (!first) return saveOrder(room, order);
  order.state = 'placed';
  order.error = null;
  order.unitsReceived = 0;
  room.x.deliveries[order.id] = { low: room.count(order.productId)?.count ?? 0 };
  if (room.x.spend.day !== room.today()) room.x.spend = { day: room.today(), total: 0 };
  room.x.spend.total += order.total ?? 0;
  room.x.jobs = room.x.jobs.filter((j) => !('orderId' in j) || j.orderId !== order.id);
  room.x.placed.push({ poNumber: order.poNumber, productId: order.productId, name: room.product(order.productId)?.name ?? 'A part', units: order.units, total: order.total, confirmation, ts: room.iso() });
  if (room.x.placed.length > PLACED_MAX) room.x.placed.splice(0, room.x.placed.length - PLACED_MAX);
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
  // The hub gave up waiting and the buyer placed it after all: the order is in at the store, so it is placed.
  if (gaveUpPlacing(order) && body.ok && body.confirmation) return markPlaced(room, order, body.confirmation, body.eta);
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
