import { ServerMessage, Snapshot } from '@reup/contracts';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../contracts/mocks/server-messages.json';
import snapshot from '../../../contracts/mocks/snapshot.json';
import { backoff, LiveStore, type SocketLike } from '../src/store/live';
import { mockSnapshot, MOMENTS } from '../src/store/mock';
import { apply, initial, type LiveState } from '../src/store/reduce';

const start = (): LiveState => ({ ...initial, snapshot: Snapshot.parse(structuredClone(snapshot)) });
const all = (messages as unknown[]).map((m) => ServerMessage.parse(m));
const one = <T extends ServerMessage['type']>(type: T) => all.find((m) => m.type === type) as Extract<ServerMessage, { type: T }>;

describe('the reducer', () => {
  it('applies every message type in the mock without losing a valid Snapshot', () => {
    let state: LiveState = initial;
    for (const msg of all) {
      state = apply(state, msg);
      if (state.snapshot) expect(() => Snapshot.parse(state.snapshot)).not.toThrow();
    }
    expect(state.snapshot).not.toBeNull();
  });

  it('ignores everything until the first snapshot', () => {
    expect(apply(initial, one('count')).snapshot).toBeNull();
    expect(apply(initial, one('snapshot')).snapshot?.products.length).toBeGreaterThan(0);
  });

  it('replaces a count, a policy, an order and a run by their ids, and adds new ones', () => {
    const s = start();
    const count = { ...one('count').count, productId: 'p-screws', count: 2 };
    expect(apply(s, { type: 'count', count }).snapshot?.counts.find((c) => c.productId === 'p-screws')?.count).toBe(2);
    expect(apply(s, { type: 'count', count }).snapshot?.counts).toHaveLength(s.snapshot?.counts.length ?? 0);
    const order = { ...(s.snapshot?.orders[0] as NonNullable<LiveState['snapshot']>['orders'][number]), state: 'placed' as const };
    expect(apply(s, { type: 'order', order }).snapshot?.orders).toEqual([order]);
    expect(apply(s, { type: 'order', order: { ...order, id: 'o-2' } }).snapshot?.orders).toHaveLength(2);
    const run = { ...(s.snapshot?.runs[0] as NonNullable<LiveState['snapshot']>['runs'][number]), id: 'r-new' };
    expect(apply(s, { type: 'run', run }).snapshot?.runs.at(-1)?.id).toBe('r-new');
  });

  it('follows the screen, the buyer, the node, the season and keeps 20 activity lines', () => {
    let s = start();
    s = apply(s, { type: 'screen', screen: 'order', focusProductId: 'p-glue' });
    s = apply(s, { type: 'buyer', online: false });
    s = apply(s, { type: 'season', season: { factor: 1.4, label: 'Busy week' } });
    expect(s.snapshot).toMatchObject({ screen: 'order', focusProductId: 'p-glue', buyerOnline: false, season: { factor: 1.4 } });
    for (let i = 0; i < 30; i++) s = apply(s, { type: 'activity', activity: { id: `a-x${i}`, ts: '2026-11-21T09:20:00-05:00', tone: 'info', text: `line ${i}` } });
    expect(s.snapshot?.activity).toHaveLength(20);
    expect(s.snapshot?.activity.at(-1)?.text).toBe('line 29');
  });

  it('tracks a hand over a zone from reach start to reach end', () => {
    let s = start();
    s = apply(s, { type: 'reach', reach: { id: 'rc', zoneId: 'z-screws', state: 'start', ts: '2026-11-21T09:14:00-05:00' } });
    expect(s.reaching['z-screws']).toBe(true);
    s = apply(s, { type: 'reach', reach: { id: 'rc', zoneId: 'z-screws', state: 'end', ts: '2026-11-21T09:14:02-05:00' } });
    expect(s.reaching['z-screws']).toBe(false);
  });

  it('says Counting for 3 seconds after a taught part is confirmed, and not after a cancel', () => {
    const teach = { id: 't-1', status: 'needs_confirm' as const, cropUrl: null, suggestion: null, zoneId: 'z-screws', error: null, ts: '2026-11-21T09:14:00-05:00' };
    let s = apply(start(), { type: 'teach', teach });
    s = apply(s, { type: 'product', product: { ...(s.snapshot as NonNullable<LiveState['snapshot']>).products[0]!, id: 'p-new', name: 'New' } });
    s = apply(s, { type: 'teach', teach: null }, 1000);
    expect(s.countingUntil).toBe(4000);
    let c = apply(start(), { type: 'teach', teach });
    c = apply(c, { type: 'teach', teach: null }, 1000);
    expect(c.countingUntil).toBe(0);
  });
});

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onclose: SocketLike['onclose'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.onclose?.({}); }
}

describe('the live store', () => {
  it('drops and logs a message that fails its schema, and applies a good one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new LiveStore();
    expect(store.receive('not json')).toBe(false);
    expect(store.receive({ type: 'count', count: { nope: true } })).toBe(false);
    expect(store.receive({ type: 'made_up' })).toBe(false);
    expect(store.getState().snapshot).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(store.receive(JSON.stringify(one('snapshot')))).toBe(true);
    expect(store.getState().snapshot?.screen).toBe('shop');
    warn.mockRestore();
  });

  it('backs off 1, 2, 4, 8 and then 10 seconds', () => {
    expect([0, 1, 2, 3, 4, 9].map(backoff)).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  it('reconnects after a close with a growing delay, and starts over once it is open again', () => {
    const sockets: FakeSocket[] = [];
    const waits: number[] = [];
    const store = new LiveStore(() => { const s = new FakeSocket(); sockets.push(s); return s; }, (fn, ms) => { waits.push(ms); fn(); return 0 as never; });
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.getState().connected));
    store.connect('ws://hub/live?role=screen');
    sockets[0]?.onopen?.({});
    expect(store.getState().connected).toBe(true);
    sockets[0]?.close();
    expect(store.getState().connected).toBe(false);
    expect(sockets).toHaveLength(2);
    sockets[1]?.close();
    sockets[2]?.close();
    expect(waits).toEqual([1000, 2000, 4000]);
    sockets[3]?.onopen?.({});
    sockets[3]?.close();
    expect(waits.at(-1)).toBe(1000);
    store.ping();
    expect(sockets.at(-1)?.sent).toEqual(['{"type":"ping"}']);
    store.stop();
  });
});

describe('mock mode', () => {
  it('has a valid Snapshot for every prepared moment', () => {
    for (const at of [null, ...MOMENTS]) expect(() => Snapshot.parse(mockSnapshot(at)), String(at)).not.toThrow();
    expect(mockSnapshot('shelf').screen).toBe('shelf');
    expect(mockSnapshot('order').orders[0]?.state).toBe('awaiting_approval');
  });
});
