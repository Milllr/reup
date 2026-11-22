// Teaching: a new part sits on the teach spot, the hub stores the crop, asks for a name, and a person confirms it.
import { Catalog, type CatalogItem, type Product, type TeachBody, type TeachConfirmBody, type TeachState } from '@reup/contracts';
import type { RoomCore } from '../core/room';
import { daysBefore } from '../core/time';
import { Conflict, NotFound } from '../orders';

const FIVE_MINUTES = 5 * 60 * 1000;
export const NAME_TIMEOUT_MS = 12_000;

export const cropKey = (id: string) => `crop:${id}`;

/** Offcut's public catalog, cached for 5 minutes. A failed fetch falls back to the last good copy. */
export async function catalog(room: RoomCore): Promise<CatalogItem[]> {
  const cached = room.x.catalog;
  if (cached && room.nowMs() - cached.at < FIVE_MINUTES) return cached.items;
  try {
    const res = await (room.deps.fetch ?? fetch)(`${room.config.SUPPLY_URL}/catalog.json`);
    if (!res.ok) throw new Error(`The store answered ${res.status}.`);
    const items = Catalog.parse(await res.json()).items;
    room.x.catalog = { at: room.nowMs(), items };
    return items;
  } catch (err) {
    console.error('catalog fetch failed', err);
    return cached?.items ?? [];
  }
}

function setTeach(room: RoomCore, teach: TeachState | null): void {
  room.setTeach(teach);
}

async function nameIt(room: RoomCore, id: string, jpegBase64: string): Promise<void> {
  const failed = (error: string) => {
    if (room.s.teach?.id !== id || room.s.teach.status !== 'naming') return;
    setTeach(room, { ...room.s.teach, status: 'failed', error, ts: room.iso() });
  };
  try {
    const namer = room.deps.namer;
    if (!namer) return failed('Naming is not set up. Type a name to add it.');
    const items = await catalog(room);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Naming took longer than 12 seconds.'));
      }, NAME_TIMEOUT_MS);
    });
    const result = await Promise.race([namer.name(jpegBase64, items, controller.signal), timeout]).finally(() => {
      if (timer != null) clearTimeout(timer);
    });
    if (room.s.teach?.id !== id || room.s.teach.status !== 'naming') return;
    const item = result.sku ? items.find((i) => i.sku === result.sku) : undefined;
    // A SKU that is not in the catalog is treated as no match.
    const suggestion = item
      ? { name: item.name, unit: item.unit, sku: item.sku, searchPhrase: item.name, confidence: result.confidence }
      : { name: result.name || 'New part', unit: result.unit || 'each', sku: null, searchPhrase: result.name || 'New part', confidence: result.sku ? ('not_sure' as const) : result.confidence };
    setTeach(room, { ...room.s.teach, status: 'needs_confirm', suggestion, error: null, ts: room.iso() });
  } catch (err) {
    console.error('naming failed', err);
    failed('Could not name it. Type a name to add it.');
  } finally {
    await room.save();
  }
}

export async function startTeach(room: RoomCore, body: TeachBody): Promise<TeachState> {
  const previous = room.s.teach;
  if (previous) await room.deps.store.delete(cropKey(previous.id));
  const id = room.id('t');
  await room.deps.store.put(cropKey(id), body.jpegBase64);
  const teach: TeachState = { id, status: 'naming', cropUrl: `/api/teach/${id}/crop.jpg`, suggestion: null, zoneId: body.zoneId, error: null, ts: room.iso() };
  setTeach(room, teach);
  room.activity('working', 'A new part is on the teach spot. Naming it.');
  room.later(nameIt(room, id, body.jpegBase64));
  return teach;
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'part';

export function confirmTeach(room: RoomCore, id: string, body: TeachConfirmBody): Product {
  const teach = room.s.teach;
  if (!teach || teach.id !== id) throw new NotFound(`No teach ${id} is waiting.`);
  const zone = room.zone(body.zoneId);
  if (!zone) throw new NotFound(`No zone ${body.zoneId}.`);
  if (teach.status === 'confirmed' || teach.status === 'cancelled') throw new Conflict('This part was already handled.');

  let productId = `p-${slug(body.name)}`;
  if (room.product(productId)) productId = `${productId}-${room.id('n').split('-')[1]}`;
  const now = room.iso();
  const product: Product = {
    id: productId, name: body.name, unit: body.unit, sku: body.sku, zoneId: zone.id,
    capacity: zone.kind === 'pockets' && zone.rows != null && zone.cols != null ? zone.rows * zone.cols : null,
    searchPhrase: body.searchPhrase, imageUrl: teach.cropUrl, createdAt: now,
  };
  // The zone now belongs to the new part. A part that sat there before keeps its history and loses the zone.
  for (const p of room.s.products) if (p.zoneId === zone.id) p.zoneId = null;
  room.s.products.push(product);
  zone.productId = product.id;
  room.s.counts = room.s.counts.filter((c) => c.zoneId !== zone.id);
  const count = { productId: product.id, zoneId: zone.id, count: 1, level: null, pockets: null, source: 'manual' as const, ts: now };
  room.s.counts.push(count);
  delete room.x.eyeCounts[zone.id];
  delete room.x.nodeCounts[zone.id];

  // No use yet: the rate starts at zero, so a new part is counted but never shown as low or reordered until someone uses it.
  const byDay: RoomCore['x']['usage'][string] = {};
  daysBefore(room.today(), 30).forEach((day) => {
    byDay[day] = { used: 0, restocked: 0, sample: true };
  });
  room.x.usage[product.id] = byDay;
  room.x.leadDays[product.id] = room.x.catalog?.items.find((i) => i.sku === body.sku)?.leadDays ?? 2;

  room.emit({ type: 'product', product });
  room.emit({ type: 'zones', zones: room.s.zones });
  room.emit({ type: 'count', count });
  room.recomputePolicy(product.id);
  setTeach(room, null);
  room.activity('info', `${product.name} added. Counting it now.`);
  return product;
}

export async function cancelTeach(room: RoomCore, id: string): Promise<void> {
  const teach = room.s.teach;
  if (!teach || teach.id !== id) throw new NotFound(`No teach ${id} is waiting.`);
  await room.deps.store.delete(cropKey(id));
  setTeach(room, null);
}
