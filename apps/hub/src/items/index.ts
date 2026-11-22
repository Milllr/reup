// Items: what a person does to the list in the dashboard. Add an item on a free ledge or counted by hand,
// change its details, type its count, remove it. The camera, the teach spot and the operator's board setup are elsewhere.
import type { Count, Product, ProductAddBody, ProductEditBody, Zone } from '@reup/contracts';
import { closeCheck, openCheckFor } from '../checks';
import type { RoomCore } from '../core/room';
import { countByHand } from '../ingest';
import { Conflict, NotFound, withdraw } from '../orders';
import { TEACH_ZONE, applySampleFor } from '../seed';
import { dropMadeZone } from '../teach';

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'item';

/** Business days the store takes for a SKU, from its catalog when the hub has read it. */
const leadDaysFor = (room: RoomCore, sku: string | null) => room.x.catalog?.items.find((i) => i.sku === sku)?.leadDays ?? 2;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function itemOr404(room: RoomCore, id: string): Product {
  const product = room.product(id);
  if (!product) throw new NotFound(`No item ${id}.`);
  return product;
}

/**
 * A new item. On a free zone the camera counts it from its next look. With no zone it is counted by hand: its count is
 * filed under its own id, since a count always names where it was taken. Either way it behaves like a part set up on
 * the board: what the shelf holds is learned from what is on it, and its sample use gives it a reorder point at once.
 * An item that comes with its use a day, from an inventory export, gets its reorder point from that figure.
 */
export function addItem(room: RoomCore, body: ProductAddBody): Product {
  let zone: Zone | undefined;
  if (body.zoneId != null) {
    zone = room.zone(body.zoneId);
    if (!zone) throw new NotFound(`No zone ${body.zoneId}.`);
    const holder = room.product(zone.productId);
    if (holder) throw new Conflict(`${zone.name} already holds ${holder.name}.`);
    if (room.s.teach?.zoneId === zone.id) throw new Conflict('A new part is waiting on that spot. Confirm it or dismiss it first.');
  }
  if (room.s.products.some((p) => sameName(p.name, body.name))) throw new Conflict(`There is already an item called ${body.name}.`);

  let id = `p-${slug(body.name)}`;
  if (room.product(id)) id = `${id}-${room.id('n').split('-')[1]}`;
  const now = room.iso();
  const pockets = zone && zone.kind === 'pockets' && zone.rows != null && zone.cols != null ? zone.rows * zone.cols : null;
  const product: Product = {
    id, name: body.name, unit: body.unit, sku: body.sku, zoneId: zone?.id ?? null,
    capacity: pockets ?? (body.count > 0 ? body.count : null),
    searchPhrase: body.searchPhrase ?? body.name, imageUrl: null, createdAt: now,
  };
  room.s.products.push(product);
  // Kept with the item, so a demo reset gives it this history again and not the board's sample.
  room.x.board[id] = body.usePerDay != null ? { learn: pockets == null, usePerDay: body.usePerDay } : { learn: pockets == null };
  room.x.leadDays[id] = leadDaysFor(room, body.sku);
  if (zone) {
    zone.productId = id;
    room.s.counts = room.s.counts.filter((c) => c.zoneId !== zone.id);
    // What the cameras last said about this zone was about an empty ledge. Their next look is the first word on this item.
    delete room.x.eyeCounts[zone.id];
    delete room.x.nodeCounts[zone.id];
    room.emit({ type: 'zones', zones: room.s.zones });
  }
  const count: Count = { productId: id, zoneId: zone?.id ?? id, count: body.count, level: null, pockets: null, source: 'manual', ts: now };
  room.s.counts.push(count);
  // Use from the shop's own records gives the reorder point. With none, the item gets sample use like a part on the board.
  applySampleFor(room, product);
  room.emit({ type: 'product', product });
  room.emit({ type: 'count', count });
  room.recomputePolicy(id);
  room.activity('info', `${product.name} added. ${zone ? 'The camera counts it.' : 'Counted by hand.'}`);
  return product;
}

/** Only the fields given change. A new store item means a new delivery time, and the old item's price no longer applies. */
export function editItem(room: RoomCore, id: string, body: ProductEditBody): Product {
  const product = itemOr404(room, id);
  const name = body.name;
  if (name != null && !sameName(name, product.name) && room.s.products.some((p) => p.id !== id && sameName(p.name, name))) throw new Conflict(`There is already an item called ${name}.`);
  if (name != null) product.name = name;
  if (body.unit != null) product.unit = body.unit;
  if (body.searchPhrase != null) product.searchPhrase = body.searchPhrase;
  if (body.sku !== undefined && body.sku !== product.sku) {
    product.sku = body.sku;
    room.x.leadDays[id] = leadDaysFor(room, body.sku);
    const account = room.s.suppliers.find((s) => s.kind === 'account');
    room.s.quotes = room.s.quotes.filter((q) => !(q.productId === id && q.supplierId === account?.id));
    room.recomputePolicy(id, false);
  }
  // Rare, and it can touch quotes and the policy as well as the product: every screen gets the whole picture again.
  room.emit({ type: 'snapshot', snapshot: room.snapshot() });
  return product;
}

/** The count a person read off the shelf. It becomes the count of record the way a camera's does, so use, the reorder point and a delivery all follow from it. */
export function countItem(room: RoomCore, id: string, count: number): Count {
  const product = itemOr404(room, id);
  const record = countByHand(room, product, count);
  room.refreshScreen();
  return record;
}

/**
 * Takes an item off the lists and frees its ledge. An order still being shopped for it is withdrawn. One that is
 * being placed right now has to finish first. Orders already placed stay in the record.
 * The item is simply gone: no line says it was removed, the lines that named it go with it, and its box comes off
 * the board. The one box that stays is the teach spot, which belongs to the station and not to the part on it.
 */
export function removeItem(room: RoomCore, id: string): void {
  const product = itemOr404(room, id);
  const placing = room.s.orders.find((o) => o.productId === id && (o.state === 'approved' || o.state === 'placing'));
  if (placing) throw new Conflict(`Order ${placing.poNumber} for ${product.name} is being placed. Remove the item once it is done.`);
  for (const order of room.s.orders.filter((o) => o.productId === id && (o.state === 'pricing' || o.state === 'carting' || o.state === 'awaiting_approval'))) {
    withdraw(room, order, `${product.name} was removed.`);
  }
  const check = openCheckFor(room, id);
  if (check) closeCheck(room, check.id);
  const zone = room.zone(product.zoneId);
  // What the screens called it: its own name, and its ledge's name when the ledge is named for it.
  const names = [product.name, ...(zone && zone.id !== TEACH_ZONE ? [zone.name] : [])].map((n) => n.trim().toLowerCase()).filter((n) => n !== '');
  if (zone) {
    zone.productId = null;
    delete room.x.eyeCounts[zone.id];
    delete room.x.nodeCounts[zone.id];
    delete room.x.disagree[zone.id];
    delete room.x.recentChanges[zone.id];
    if (zone.id !== TEACH_ZONE) {
      dropMadeZone(room, zone.id);
      room.s.zones = room.s.zones.filter((z) => z.id !== zone.id);
    }
  }
  room.s.products = room.s.products.filter((p) => p.id !== id);
  room.s.counts = room.s.counts.filter((c) => c.productId !== id);
  room.s.policies = room.s.policies.filter((p) => p.productId !== id);
  room.s.quotes = room.s.quotes.filter((q) => q.productId !== id);
  delete room.x.usage[id];
  delete room.x.leadDays[id];
  delete room.x.board[id];
  room.x.trail = room.x.trail.filter((t) => t.productId !== id);
  room.x.recentPicks = room.x.recentPicks.filter((r) => r.pick.productId !== id);
  if (room.s.focusProductId === id) room.s.focusProductId = null;
  room.s.activity = room.s.activity.filter((a) => !names.some((n) => a.text.toLowerCase().includes(n)));
  room.refreshScreen();
  room.emit({ type: 'snapshot', snapshot: room.snapshot() });
}
