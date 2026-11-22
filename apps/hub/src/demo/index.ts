// Operator tools: season, reset, the screen override, replay switches and the zone editor's save.
import type { BoardBody, Product, ReplayBody, ScreenBody, Season, Snapshot, ZonesBody } from '@reup/contracts';
import { clearChecks } from '../checks';
import type { RoomCore } from '../core/room';
import { TEACH_ZONE, applySampleFor, applySampleHistory } from '../seed';

const TEN_MINUTES = 10 * 60 * 1000;

export function setSeason(room: RoomCore, season: Season): void {
  room.s.season = season;
  room.emit({ type: 'season', season });
  for (const p of room.s.products) room.recomputePolicy(p.id);
}

/** Cancels what is open and wipes what the last judge left on the screens: orders, runs, activity, the season, the teach card. */
function clearDemo(room: RoomCore): void {
  for (const order of room.s.orders) {
    if (['pricing', 'carting', 'awaiting_approval', 'approved', 'placing'].includes(order.state)) {
      order.state = 'cancelled';
      order.updatedAt = room.iso();
      room.deps.history.order(order);
    }
  }
  const now = room.nowMs();
  room.s.orders = [];
  room.s.runs = [];
  room.s.quotes = room.s.quotes.filter((q) => now - Date.parse(q.fetchedAt) < TEN_MINUTES);
  room.s.activity = [];
  room.s.teach = null;
  room.x.teachUntil = null;
  room.s.season = { factor: 1, label: 'Normal' };
  room.x.jobs = [];
  room.x.deliveries = {};
  room.x.screenOverride = null;
  room.x.screenUntil = {};
  room.x.shopAfter = {};
  room.x.spend = { day: room.today(), total: 0 };
  room.x.disagree = {};
  room.x.recentChanges = {};
  clearChecks(room);
}

/**
 * A ledge part holds what is stocked. When the cameras count more than its capacity, that is its capacity now, and its
 * sample use is sized to it again. Returns true when the capacity changed.
 */
export function learnStock(room: RoomCore, product: Product, count: number, exact = false): boolean {
  if (!room.x.board[product.id]?.learn) return false;
  // exact is a reset: the ledge holds what is on it now, and an empty ledge holds nothing known yet.
  const next = count > 0 ? count : null;
  if (product.capacity === next || (!exact && (next == null || (product.capacity != null && next < product.capacity)))) return false;
  product.capacity = next;
  applySampleFor(room, product);
  return true;
}

/** The same clean start for every judge. Zones, products and what the cameras count stay as they are. */
export function reset(room: RoomCore): Snapshot {
  clearDemo(room);
  // A part taught on the teach spot belongs to the last judge. It goes, and the spot is free again.
  for (const taught of room.s.products.filter((p) => p.zoneId === TEACH_ZONE)) {
    room.s.products = room.s.products.filter((p) => p.id !== taught.id);
    room.s.counts = room.s.counts.filter((c) => c.productId !== taught.id);
    room.s.policies = room.s.policies.filter((p) => p.productId !== taught.id);
    delete room.x.usage[taught.id];
    delete room.x.leadDays[taught.id];
    delete room.x.board[taught.id];
  }
  const spot = room.zone(TEACH_ZONE);
  if (spot) {
    spot.productId = null;
    delete room.x.eyeCounts[TEACH_ZONE];
    delete room.x.nodeCounts[TEACH_ZONE];
  }
  const today = room.today();
  for (const byDay of Object.values(room.x.usage)) delete byDay[today];
  // Reset means the parts are back: what the cameras count on a ledge now is what that ledge holds.
  for (const p of room.s.products) {
    const live = p.zoneId ? (room.x.eyeCounts[p.zoneId] ?? room.x.nodeCounts[p.zoneId]) : undefined;
    if (live) learnStock(room, p, live.count, true);
  }
  applySampleHistory(room);
  for (const p of room.s.products) room.recomputePolicy(p.id, false);
  room.s.screen = 'shelf';
  room.s.focusProductId = null;
  const snapshot = room.snapshot();
  room.emit({ type: 'snapshot', snapshot });
  return snapshot;
}

/** Sets up the station: every zone and every part at once. Counts of parts that stay are kept, the rest start again. */
export function setBoard(room: RoomCore, body: BoardBody): Snapshot {
  clearDemo(room);
  const now = room.iso();
  const before = new Map(room.s.products.map((p) => [p.id, p]));
  room.s.zones = body.zones;
  room.x.board = {};
  room.s.products = body.products.map((p) => {
    const zone = body.zones.find((z) => z.productId === p.id);
    const pockets = zone && zone.kind === 'pockets' && zone.rows != null && zone.cols != null ? zone.rows * zone.cols : null;
    const fixed = pockets ?? p.capacity ?? null;
    room.x.board[p.id] = { learn: fixed == null };
    const was = before.get(p.id);
    // A ledge part that was already on the board keeps what it had learned, as long as it is still on the same ledge.
    const learned = fixed == null && was && was.zoneId === (zone?.id ?? null) ? was.capacity : null;
    return { id: p.id, name: p.name, unit: p.unit, sku: p.sku, zoneId: zone?.id ?? null, capacity: fixed ?? learned, searchPhrase: p.searchPhrase, imageUrl: p.imageUrl ?? null, createdAt: was?.createdAt ?? now };
  });
  const home = new Map(room.s.products.map((p) => [p.id, p.zoneId]));
  const zoneIds = new Set(body.zones.map((z) => z.id));
  room.s.counts = room.s.counts.filter((c) => home.get(c.productId) === c.zoneId);
  room.s.policies = [];
  room.s.quotes = room.s.quotes.filter((q) => home.has(q.productId));
  for (const id of Object.keys(room.x.usage)) if (!home.has(id)) delete room.x.usage[id];
  for (const id of Object.keys(room.x.leadDays)) if (!home.has(id)) delete room.x.leadDays[id];
  for (const kept of [room.x.eyeCounts, room.x.nodeCounts]) {
    for (const [zoneId, c] of Object.entries(kept)) if (!zoneIds.has(zoneId) || home.get(c.productId) !== zoneId) delete kept[zoneId];
  }
  room.x.recentPicks = [];
  const today = room.today();
  for (const byDay of Object.values(room.x.usage)) delete byDay[today];
  for (const p of room.s.products) {
    const count = room.count(p.id)?.count;
    if (count != null) learnStock(room, p, count, true);
  }
  applySampleHistory(room);
  for (const p of room.s.products) room.recomputePolicy(p.id, false);
  room.s.screen = 'shelf';
  room.s.focusProductId = null;
  room.activity('info', `Board set: ${room.s.products.map((p) => p.name).join(', ') || 'no parts'}.`);
  const snapshot = room.snapshot();
  room.emit({ type: 'snapshot', snapshot });
  return snapshot;
}

export function setScreen(room: RoomCore, body: ScreenBody): void {
  room.x.screenOverride = body.screen ? { screen: body.screen, focusProductId: body.focusProductId } : null;
  room.refreshScreen();
}

export function setReplay(room: RoomCore, body: ReplayBody): void {
  room.x.replay[body.kind] = body.on;
}

export function putZones(room: RoomCore, body: ZonesBody): void {
  room.s.zones = body.zones;
  for (const p of room.s.products) {
    const zone = body.zones.find((z) => z.productId === p.id);
    p.zoneId = zone?.id ?? null;
    if (zone && zone.kind === 'pockets' && zone.rows != null && zone.cols != null) p.capacity = zone.rows * zone.cols;
  }
  room.emit({ type: 'zones', zones: room.s.zones });
  for (const p of room.s.products) {
    room.emit({ type: 'product', product: p });
    room.recomputePolicy(p.id);
  }
}
