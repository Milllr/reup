// How one message from the hub changes what the screens show. Pure, so it is easy to test.
import type { PickEvent, ServerMessage, Snapshot } from '@reup/contracts';

export interface LiveState {
  snapshot: Snapshot | null;
  /** True while the socket is open. */
  connected: boolean;
  /** When the last message arrived, for "Showing the last counts from 9:14". */
  syncedAt: string | null;
  /** zoneId to true while a hand is over it. '*' when the node does not know the zone. */
  reaching: Record<string, boolean>;
  lastPick: PickEvent | null;
  /** A part was just taught: show "Counting" until this time (ms). */
  countingUntil: number;
  taughtProductId: string | null;
  mock: boolean;
}

export const initial: LiveState = { snapshot: null, connected: false, syncedAt: null, reaching: {}, lastPick: null, countingUntil: 0, taughtProductId: null, mock: false };

function upsert<T>(list: readonly T[], item: T, same: (a: T) => boolean): T[] {
  const i = list.findIndex(same);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function apply(state: LiveState, msg: ServerMessage, now = Date.now()): LiveState {
  if (msg.type === 'snapshot') return { ...state, snapshot: msg.snapshot, syncedAt: msg.snapshot.now, reaching: {} };
  const s = state.snapshot;
  if (!s || msg.type === 'pong' || msg.type === 'job') return state;
  const set = (patch: Partial<Snapshot>, extra: Partial<LiveState> = {}): LiveState => ({ ...state, ...extra, snapshot: { ...s, ...patch } });
  switch (msg.type) {
    case 'count':
      return set({ counts: upsert(s.counts, msg.count, (c) => c.productId === msg.count.productId) }, { syncedAt: msg.count.ts });
    case 'pick':
      return { ...state, lastPick: msg.pick };
    case 'reach':
      return { ...state, reaching: { ...state.reaching, [msg.reach.zoneId ?? '*']: msg.reach.state === 'start' } };
    case 'policy':
      return set({ policies: upsert(s.policies, msg.policy, (p) => p.productId === msg.policy.productId) });
    case 'product':
      return set({ products: upsert(s.products, msg.product, (p) => p.id === msg.product.id) }, s.teach ? { taughtProductId: msg.product.id } : {});
    case 'zones':
      return set({ zones: msg.zones });
    case 'quote':
      return set({ quotes: upsert(s.quotes, msg.quote, (q) => q.productId === msg.quote.productId && q.supplierId === msg.quote.supplierId) });
    case 'run':
      return set({ runs: upsert(s.runs, msg.run, (r) => r.id === msg.run.id) });
    case 'order':
      return set({ orders: upsert(s.orders, msg.order, (o) => o.id === msg.order.id) });
    case 'node':
      return set({ node: msg.node });
    case 'cameras':
      return set({ cameras: msg.cameras });
    case 'buyer':
      return set({ buyerOnline: msg.online });
    case 'screen':
      return set({ screen: msg.screen, focusProductId: msg.focusProductId });
    case 'teach':
      // A teach that ends right after its product arrived was confirmed: say "Counting" for 3 seconds.
      if (msg.teach === null && s.teach && state.taughtProductId) return set({ teach: null }, { countingUntil: now + 3000 });
      return set({ teach: msg.teach }, msg.teach === null ? {} : { taughtProductId: null });
    case 'season':
      return set({ season: msg.season });
    case 'checks':
      return set({ checks: msg.checks });
    case 'activity':
      return set({ activity: [...s.activity, msg.activity].slice(-20) }, { syncedAt: msg.activity.ts });
  }
}
