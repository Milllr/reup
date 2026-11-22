// Mock mode (?mock=1): the app runs from contracts/mocks with no hub. ?at=<name> picks one prepared moment, for checking a screen.
import { ServerMessage, Snapshot, type Order, type Run } from '@reup/contracts';
import messages from '../../../../contracts/mocks/server-messages.json';
import snapshotJson from '../../../../contracts/mocks/snapshot.json';

const base = (): Snapshot => Snapshot.parse(structuredClone(snapshotJson));
const pockets = (full: number, total: number) => Array.from({ length: total }, (_, i) => i < full);

export const MOMENTS = ['shop', 'shelf', 'low', 'ontheway', 'order', 'placing', 'placed', 'failed', 'cancelled', 'why', 'naming', 'teach', 'empty'] as const;
export type MomentName = (typeof MOMENTS)[number];

export function mockSnapshot(at: string | null): Snapshot {
  const s = base();
  const order = s.orders[0] as Order;
  const screws = (n: number) => {
    s.counts = s.counts.map((c) => (c.productId === 'p-screws' ? { ...c, count: n, pockets: pockets(n, 12) } : c));
    s.policies = s.policies.map((p) => (p.productId === 'p-screws' ? { ...p, daysOfCover: n / 0.56 } : p));
  };
  const priced: Order = { ...order, state: 'awaiting_approval', total: 67.71, eta: '2026-11-24T17:00:00-05:00' };
  const placeRun: Run = { id: 'r-9', tinyfishRunId: null, kind: 'place', supplierId: 's-offcut', productId: 'p-screws', orderId: order.id, status: 'running', streamingUrl: null, steps: [{ ts: s.now, purpose: 'Entering PO number RU-1042' }], replay: false, error: null, startedAt: s.now, finishedAt: null };
  switch (at) {
    case 'shelf':
      screws(6);
      return { ...s, screen: 'shelf', focusProductId: null, orders: [], runs: [], activity: [] };
    case 'low':
      return { ...s, screen: 'shelf', focusProductId: null, orders: [], runs: [], activity: s.activity.slice(0, 1) };
    case 'ontheway':
      return { ...s, screen: 'shelf', focusProductId: null, orders: [{ ...priced, state: 'placed', confirmation: 'OC-58213', approvedBy: 'button' }], runs: [] };
    case 'order':
      return { ...s, screen: 'order', orders: [priced] };
    case 'placing':
      return { ...s, screen: 'order', orders: [{ ...priced, state: 'placing', approvedBy: 'button' }], runs: [...s.runs, placeRun] };
    case 'placed':
      return { ...s, screen: 'order', orders: [{ ...priced, state: 'placed', confirmation: 'OC-58213', approvedBy: 'button' }] };
    case 'failed':
      return { ...s, screen: 'order', orders: [{ ...priced, state: 'failed', error: 'Could not fill the cart: the item is out of stock. Nothing was bought.' }] };
    case 'cancelled':
      return { ...s, screen: 'order', orders: [{ ...priced, state: 'cancelled' }] };
    case 'why':
      screws(4);
      return { ...s, screen: 'why', focusProductId: 'p-screws' };
    case 'naming':
      return { ...s, screen: 'shelf', orders: [], runs: [], teach: { id: 't-1', status: 'naming', cropUrl: null, suggestion: null, zoneId: 'z-screws', error: null, ts: s.now } };
    case 'teach':
      return { ...s, screen: 'shelf', orders: [], runs: [], teach: { id: 't-1', status: 'needs_confirm', cropUrl: null, suggestion: { name: 'Wood screws #8 x 2 in', unit: 'box of 100', sku: 'OC-1008-200', searchPhrase: '#8 x 2 wood screws', confidence: 'fairly_sure' }, zoneId: 'z-screws', error: null, ts: s.now } };
    case 'empty':
      return { ...s, screen: 'shelf', focusProductId: null, products: [], counts: [], policies: [], orders: [], runs: [], zones: [], activity: [] };
    default:
      return s;
  }
}

/** One sample of every message type, in the order the mock file lists them. */
export const mockMessages = (): ServerMessage[] => (messages as unknown[]).flatMap((m) => {
  const parsed = ServerMessage.safeParse(m);
  return parsed.success && parsed.data.type !== 'snapshot' ? [parsed.data] : [];
});

export { default as mockHistory } from '../../../../contracts/mocks/history.json';
export { default as mockAnalytics } from '../../../../contracts/mocks/analytics.json';
export { default as mockAsk } from '../../../../contracts/mocks/ask-result.json';
export { default as mockCatalog } from '../../../../contracts/mocks/catalog.json';
