// Operator tools: season, reset, the screen override, replay switches and the zone editor's save.
import type { ReplayBody, ScreenBody, Season, Snapshot, ZonesBody } from '@reup/contracts';
import type { RoomCore } from '../core/room';
import { TEACH_ZONE, applySampleHistory } from '../seed';

const TEN_MINUTES = 10 * 60 * 1000;

export function setSeason(room: RoomCore, season: Season): void {
  room.s.season = season;
  room.emit({ type: 'season', season });
  for (const p of room.s.products) room.recomputePolicy(p.id);
}

/** The same clean start for every judge. Zones, products and what the cameras count stay as they are. */
export function reset(room: RoomCore): Snapshot {
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
  room.s.season = { factor: 1, label: 'Normal' };
  room.x.jobs = [];
  room.x.deliveries = {};
  room.x.screenOverride = null;
  room.x.screenUntil = {};
  room.x.shopAfter = {};
  room.x.spend = { day: room.today(), total: 0 };
  room.x.disagree = {};
  room.x.recentChanges = {};
  // A part taught on the teach spot belongs to the last judge. It goes, and the spot is free again.
  for (const taught of room.s.products.filter((p) => p.zoneId === TEACH_ZONE)) {
    room.s.products = room.s.products.filter((p) => p.id !== taught.id);
    room.s.counts = room.s.counts.filter((c) => c.productId !== taught.id);
    room.s.policies = room.s.policies.filter((p) => p.productId !== taught.id);
    delete room.x.usage[taught.id];
    delete room.x.leadDays[taught.id];
  }
  const spot = room.zone(TEACH_ZONE);
  if (spot) {
    spot.productId = null;
    delete room.x.eyeCounts[TEACH_ZONE];
    delete room.x.nodeCounts[TEACH_ZONE];
  }
  const today = room.today();
  for (const byDay of Object.values(room.x.usage)) delete byDay[today];
  applySampleHistory(room);
  for (const p of room.s.products) room.recomputePolicy(p.id, false);
  room.s.screen = 'shelf';
  room.s.focusProductId = null;
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
