// Ingest: counts, picks, reaches and heartbeats from the eye and the shelf node, and the count of record rule.
import { unitsText } from '@reup/brain';
import { TEACH_ZONE } from '../seed';
import type { Count, IngestCountsBody, IngestNodeBody, IngestNodeResult, IngestPicksBody, IngestPicksResult, IngestReachesBody, PickEvent, Zone } from '@reup/contracts';
import type { RoomCore } from '../core/room';
import { dayIn } from '../core/time';
import { deliveryExpected, afterCountChange } from '../orders';

/** For a pocket zone the node's count wins while the node is online at level 2 or more. Otherwise the eye's. */
export function nodeIsRecord(room: RoomCore, zone: Zone): boolean {
  return zone.kind === 'pockets' && room.s.node.online && room.s.node.level >= 2;
}

export function countOfRecord(room: RoomCore, zone: Zone): Count | null {
  const node = room.x.nodeCounts[zone.id];
  if (nodeIsRecord(room, zone) && node) return node;
  return room.x.eyeCounts[zone.id] ?? null;
}

function reachNear(room: RoomCore, zoneId: string, at: number): boolean {
  return room.x.recentReaches.some((r) => Math.abs(r.at - at) <= 2000 && (r.zoneId == null || r.zoneId === zoneId));
}

const same = (a: Count, b: Count) => a.count === b.count && a.level === b.level && JSON.stringify(a.pockets) === JSON.stringify(b.pockets) && a.source === b.source;

/** Parts that come back within this long of being taken were borrowed, not used. */
const PUT_BACK_MS = 10 * 60 * 1000;

/** Writes one pick: use for its local day, the log, the screens, one sentence. */
function recordPick(room: RoomCore, pick: PickEvent): void {
  const product = room.product(pick.productId);
  const zone = room.zone(pick.zoneId);
  const day = room.usageDay(pick.productId, dayIn(new Date(pick.ts), room.config.TIME_ZONE));
  const delivery = pick.delta > 0 && deliveryExpected(room, pick.productId);
  let putBack = 0;
  if (pick.delta < 0) day.used += -pick.delta;
  else if (delivery) day.restocked += pick.delta;
  else {
    // Parts put back soon after they were taken were never used, so they come off today's use.
    // Anything beyond that came from somewhere else and is a restock.
    const at = Date.parse(pick.ts);
    const recent = room.x.recentPicks.filter((r) => r.pick.productId === pick.productId && at >= r.at && at - r.at <= PUT_BACK_MS);
    const stillOut = Math.max(0, -recent.reduce((sum, r) => sum + r.pick.delta, 0));
    putBack = Math.min(pick.delta, stillOut, day.used);
    day.used -= putBack;
    day.restocked += pick.delta - putBack;
  }
  room.deps.history.pick(pick);
  room.emit({ type: 'pick', pick });
  room.x.recentPicks.push({ pick, at: Date.parse(pick.ts) });
  if (room.x.recentPicks.length > 20) room.x.recentPicks.shift();
  if (!product) return;
  // The zone's name is the short one ('Wood screws'). The teach spot is named for the spot, not the part, so there the part's own name is used.
  const named = zone && zone.id !== TEACH_ZONE ? zone.name : product.name;
  const what = `${unitsText(Math.abs(pick.delta), product.unit)} of ${named.toLowerCase()}`;
  if (pick.delta < 0) room.activity('info', `${what} taken. ${pick.countAfter} left.`);
  else room.activity('info', `${what} ${delivery ? 'arrived' : putBack === pick.delta ? 'put back' : 'added'}. ${pick.countAfter} on the board.`);
}

/** Makes a count the count of record. A change makes exactly one pick, then the policy and the orders follow. */
function applyRecord(room: RoomCore, zone: Zone, record: Count, sent: PickEvent | null): void {
  const product = room.product(zone.productId ?? record.productId);
  if (!product) return;
  const prev = room.count(product.id);
  const next: Count = { ...record, productId: product.id, zoneId: zone.id };
  if (prev && same(prev, next)) return;
  const i = room.s.counts.findIndex((c) => c.productId === product.id);
  if (i >= 0) room.s.counts[i] = next;
  else room.s.counts.push(next);
  room.emit({ type: 'count', count: next });
  const delta = prev ? next.count - prev.count : 0;
  if (delta !== 0) {
    const at = Date.parse(next.ts);
    const pick: PickEvent = sent ?? { id: room.id('pk'), productId: product.id, zoneId: zone.id, delta, countAfter: next.count, source: next.source, handSeen: reachNear(room, zone.id, at), ts: next.ts };
    recordPick(room, pick);
    room.x.recentChanges[zone.id] = { countAfter: next.count, at: room.nowMs(), pickId: pick.id };
  }
  room.recomputePolicy(product.id);
  if (delta !== 0) afterCountChange(room, product.id, prev?.count ?? next.count, next.count);
}

function trackDisagreement(room: RoomCore, zone: Zone): void {
  const eye = room.x.eyeCounts[zone.id];
  const node = room.x.nodeCounts[zone.id];
  if (zone.kind !== 'pockets' || !eye || !node || eye.count === node.count) {
    delete room.x.disagree[zone.id];
    return;
  }
  room.x.disagree[zone.id] ??= { since: room.nowMs(), raised: false };
}

export function ingestCounts(room: RoomCore, body: IngestCountsBody): void {
  if (body.cameras) {
    const byId = new Map(room.s.cameras.map((c) => [c.id, c]));
    for (const c of body.cameras) byId.set(c.id, c);
    room.s.cameras = [...byId.values()];
    room.emit({ type: 'cameras', cameras: room.s.cameras });
  }
  for (const c of body.counts) {
    const zone = room.zone(c.zoneId);
    if (!zone) continue;
    room.deps.history.count(c);
    if (c.source === 'eye') room.x.eyeCounts[zone.id] = c;
    else if (c.source === 'node') room.x.nodeCounts[zone.id] = c;
    trackDisagreement(room, zone);
    const record = c.source === 'manual' || c.source === 'seed' ? c : countOfRecord(room, zone);
    if (record) applyRecord(room, zone, record, null);
  }
  room.refreshScreen();
}

export function ingestPicks(room: RoomCore, body: IngestPicksBody): IngestPicksResult {
  let accepted = 0;
  let duplicates = 0;
  for (const p of body.picks) {
    if (!room.firstTime(`pick:${p.id}`)) {
      duplicates += 1;
      continue;
    }
    accepted += 1;
    const zone = room.zone(p.zoneId);
    const product = room.product(zone?.productId ?? p.productId);
    if (!zone || !product) continue;
    // The hub may already have made a pick for this same change from a count. One take is one pick.
    const recent = room.x.recentChanges[zone.id];
    if (recent && recent.countAfter === p.countAfter && room.nowMs() - recent.at < 5000) continue;
    const pick: PickEvent = { ...p, productId: product.id, handSeen: p.handSeen || reachNear(room, zone.id, Date.parse(p.ts)) };
    const prev = room.count(product.id);
    const isRecord = p.source !== 'node' || nodeIsRecord(room, zone);
    if (isRecord && prev && prev.count !== p.countAfter) {
      const total = zone.rows != null && zone.cols != null ? zone.rows * zone.cols : null;
      const record: Count = { productId: product.id, zoneId: zone.id, count: p.countAfter, level: null, pockets: zone.kind === 'pockets' && total != null ? Array.from({ length: total }, (_, i) => i < p.countAfter) : null, source: p.source, ts: p.ts };
      if (p.source === 'node') room.x.nodeCounts[zone.id] = record;
      if (p.source === 'eye') room.x.eyeCounts[zone.id] = record;
      applyRecord(room, zone, record, pick);
    } else {
      recordPick(room, pick);
      room.recomputePolicy(product.id);
    }
  }
  room.refreshScreen();
  return { ok: true, accepted, duplicates };
}

export function ingestReaches(room: RoomCore, body: IngestReachesBody): void {
  for (const reach of body.reaches) {
    if (!room.firstTime(`reach:${reach.id}:${reach.state}`)) continue;
    const at = Date.parse(reach.ts);
    room.x.recentReaches.push({ zoneId: reach.zoneId, at });
    if (room.x.recentReaches.length > 20) room.x.recentReaches.shift();
    room.emit({ type: 'reach', reach });
    // A pick that landed just before its reach was reported still gets marked.
    for (const recent of room.x.recentPicks) {
      if (recent.pick.handSeen || Math.abs(recent.at - at) > 2000) continue;
      if (reach.zoneId != null && reach.zoneId !== recent.pick.zoneId) continue;
      recent.pick = { ...recent.pick, handSeen: true };
      room.deps.history.pick(recent.pick);
      room.emit({ type: 'pick', pick: recent.pick });
    }
  }
}

export function ingestNode(room: RoomCore, body: IngestNodeBody): IngestNodeResult {
  const wasOnline = room.s.node.online;
  room.x.lastHeartbeat = room.nowMs();
  room.s.node = { ...body.status, online: true, lastSeen: room.iso() };
  room.emit({ type: 'node', node: room.s.node });
  if (!wasOnline) room.activity('info', 'Shelf node online.');
  return {
    ok: true,
    zones: room.s.zones,
    reorderPoints: room.s.zones.flatMap((z) => {
      const policy = z.productId ? room.policy(z.productId) : undefined;
      return z.productId && policy && policy.ratePerDay > 0 ? [{ productId: z.productId, zoneId: z.id, reorderPoint: policy.reorderPoint }] : [];
    }),
    awaitingApproval: room.s.orders.filter((o) => o.state === 'awaiting_approval').map((o) => o.id),
  };
}
