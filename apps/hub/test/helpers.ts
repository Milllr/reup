import type { Count, Job, ServerMessage } from '@reup/contracts';
import { createApp } from '../src/app';
import { DEFAULTS, type Config } from '../src/config';
import { RoomCore, type Audience, type Deps, type Store } from '../src/core/room';
import { noHistory } from '../src/history';

export const START = Date.parse('2026-11-21T14:14:00Z'); // 9:14 AM in Toronto

export function memoryStore(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string) => (data.has(key) ? (structuredClone(data.get(key)) as T) : undefined),
    put: async (key, value) => void data.set(key, structuredClone(value)),
    delete: async (key) => void data.delete(key),
  };
}

export interface Rig {
  room: RoomCore;
  sent: { msg: ServerMessage; to: Audience }[];
  store: ReturnType<typeof memoryStore>;
  clock: { now: number };
  advance(ms: number): void;
  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[];
  jobs(): Job[];
  app: ReturnType<typeof createApp>;
  call(method: string, path: string, body?: unknown, token?: string, headers?: Record<string, string>): Promise<Response>;
}

export async function rig(config: Partial<Config> = {}, deps: Partial<Deps> = {}, store = memoryStore(), clock = { now: START }): Promise<Rig> {
  const sent: Rig['sent'] = [];
  const room = new RoomCore({ ...DEFAULTS, ...config }, { store, history: noHistory, send: (msg, to) => sent.push({ msg: structuredClone(msg), to }), now: () => clock.now, ...deps });
  await room.load();
  const app = createApp(room, { after: () => room.save() });
  return {
    room, sent, store, clock, app,
    advance(ms) {
      clock.now += ms;
      room.tick();
    },
    of: (type) => sent.filter((m) => m.msg.type === type).map((m) => m.msg) as never,
    jobs: () => sent.filter((m) => m.msg.type === 'job').map((m) => (m.msg as { job: Job }).job),
    call: async (method, path, body, token, headers = {}) =>
      app.request(path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
  };
}

export const DEVICE = DEFAULTS.DEVICE_TOKEN;
export const OPS = DEFAULTS.OPS_TOKEN;
export const APPROVE = DEFAULTS.APPROVE_KEY;

export function count(r: Rig, zoneId: string, n: number, source: Count['source'] = 'eye'): Count {
  const zone = r.room.zone(zoneId);
  const total = zone?.rows != null && zone.cols != null ? zone.rows * zone.cols : null;
  return { productId: zone?.productId ?? 'unknown', zoneId, count: n, level: null, pockets: total != null ? Array.from({ length: total }, (_, i) => i < n) : null, source, ts: r.room.iso() };
}

export function nodeOnline(r: Rig, level = 2): void {
  r.room.x.lastHeartbeat = r.clock.now;
  r.room.s.node = { online: true, level, lastSeen: r.room.iso(), queued: 0, visionRestarts: 0, offlineSince: null };
}

/** Drives an order to the cart being ready. Returns the order id. */
export async function toAwaiting(r: Rig, total = 67.71): Promise<string> {
  await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
  const order = r.room.s.orders.at(-1);
  if (!order) throw new Error('no order opened');
  r.advance(2600); // the Shelf keeps the screen for a moment first
  const cart = r.jobs().find((j) => j.kind === 'cart');
  await r.call('POST', '/ingest/cart', { jobId: cart?.id ?? 'j', orderId: order.id, ok: true, packSize: 1, packs: 8, unitPrice: 7.49, total, deliveryDays: 2, error: null }, DEVICE);
  return order.id;
}
