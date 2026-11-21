// The store's webhook: Offcut Supply tells the hub an order was confirmed, shipped or delivered.
import type { SupplyWebhookBody } from '@reup/contracts';
import type { RoomCore } from '../core/room';
import { weekdayIn } from '../core/time';
import { markPlaced, NotFound, saveOrder } from '../orders';

export function supplyWebhook(room: RoomCore, body: SupplyWebhookBody): void {
  const order = [...room.s.orders].reverse().find((o) => o.poNumber === body.poNumber);
  if (!order) throw new NotFound(`No order with PO number ${body.poNumber}.`);
  const supplier = room.s.suppliers.find((s) => s.id === order.supplierId)?.name ?? 'The store';
  if (order.state === 'failed' || order.state === 'cancelled' || order.state === 'received') return;

  if (body.event === 'order.confirmed') {
    // The store has the order. If the buyer's own report has not landed yet, this is the confirmation.
    if (order.state === 'approved' || order.state === 'placing') markPlaced(room, order, body.confirmation, body.eta);
    else if ((order.state === 'placed' || order.state === 'shipped') && body.eta && body.eta !== order.eta) {
      order.eta = body.eta;
      saveOrder(room, order);
    }
    return;
  }
  if (body.event === 'order.shipped') {
    if (order.state === 'approved' || order.state === 'placing') markPlaced(room, order, body.confirmation, body.eta);
    if (order.state !== 'placed') return;
    order.state = 'shipped';
    if (body.eta) order.eta = body.eta;
    saveOrder(room, order);
    room.activity('info', `${supplier} shipped order ${order.poNumber}.${order.eta ? ` Arrives ${weekdayIn(order.eta, room.config.TIME_ZONE)}.` : ''}`);
    return;
  }
  room.activity('info', `${supplier} says order ${order.poNumber} was delivered.`);
}
