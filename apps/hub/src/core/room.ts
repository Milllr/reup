// The Room's logic, with no Cloudflare in it: the live Snapshot, what is kept beside it, and the helpers
// every feature folder uses. The Durable Object in room-do.ts wraps this with sockets, storage and alarms,
// and the tests drive it directly with a fake clock.
import type { Activity, CatalogItem, Count, Job, Order, PickEvent, Policy, Product, Screen, ServerMessage, Snapshot, Zone } from '@reup/contracts';
import { policyFor } from '@reup/brain';
import type { Config } from '../config';
import type { History } from '../history';
import { applySampleHistory, seedSnapshot } from '../seed';
import type { Namer } from '../teach/gemini';
import { dayIn, daysBefore, isoIn } from './time';

export type Role = 'screen' | 'ops' | 'buyer';
export type Audience = 'all' | 'buyer';

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface UsageDay {
  used: number;
  restocked: number;
  sample: boolean;
}

/** State that never goes on the wire. */
export interface Internal {
  seq: number;
  poSeq: number;
  /** Ids of picks, reaches and reorder calls already taken, newest last. */
  seenIds: string[];
  eyeCounts: Record<string, Count>;
  nodeCounts: Record<string, Count>;
  disagree: Record<string, { since: number; raised: boolean }>;
  /** productId, then local day. */
  usage: Record<string, Record<string, UsageDay>>;
  leadDays: Record<string, number>;
  jobs: Job[];
  replay: { market: boolean; cart: boolean; place: boolean };
  screenOverride: { screen: Screen; focusProductId: string | null } | null;
  /** orderId to the time until which a finished order keeps the Order screen. */
  screenUntil: Record<string, number>;
  /** orderId to the time the Shop screen may take over. Until then the Shelf shows the count that crossed the line. */
  shopAfter: Record<string, number>;
  /** zoneId to the last change of its count of record, so one physical take is one pick. */
  recentChanges: Record<string, { countAfter: number; at: number; pickId: string }>;
  recentReaches: { zoneId: string | null; at: number }[];
  recentPicks: { pick: PickEvent; at: number }[];
  /** For each order that is on its way: the lowest count seen since it was placed. What has come in is measured from there. */
  deliveries: Record<string, { low: number }>;
  /** Parts set up with PUT /api/board. learn: the part has no fixed capacity, it holds what is stocked. */
  board: Record<string, { learn: boolean }>;
  /** When the new part card gives up waiting for a name or a yes, so the screens are never held by it for good. Null when no card is up. */
  teachUntil: number | null;
  /** orderId to the last time the buyer said anything about that order, or was handed work for it. */
  heard: Record<string, number>;
  /** Since when no buyer is connected. Null while one is. */
  buyerAwaySince: number | null;
  spend: { day: string; total: number };
  catalog: { at: number; items: CatalogItem[] } | null;
  lastHeartbeat: number;
}

export interface Deps {
  store: Store;
  history: History;
  send: (msg: ServerMessage, to: Audience) => void;
  now?: () => number;
  fetch?: typeof fetch;
  namer?: Namer;
  /** Keeps the Worker alive for work that outlives the request. */
  waitUntil?: (p: Promise<unknown>) => void;
}

/** How long a new part card waits: for its name while it is being named, for someone to type one, for someone to say yes. */
export const TEACH_WAIT_MS = { naming: 20_000, failed: 90_000, needs_confirm: 180_000 } as const;

/** How long the Shelf keeps the screen after a count crosses the reorder point: the judge sees the drop, then the shopping. */
export const REORDER_BEAT_MS = 2500;

/**
 * How long an order waits on the buyer before the hub gives it up, so the Shop and Order screens are never held for good.
 * away: no buyer is connected and none has said a word about the order. quiet: a buyer is connected and has gone silent.
 * One run of the buyer may take 5 minutes by its own limit, and it reports every step, so quiet sits above that.
 */
export const BUYER_WAIT_MS = { away: 45_000, quiet: 360_000 } as const;
const ON_THE_BUYER: ReadonlySet<Order['state']> = new Set(['pricing', 'carting', 'approved', 'placing']);

export const OPEN_STATES: ReadonlySet<Order['state']> = new Set(['pricing', 'carting', 'awaiting_approval', 'approved', 'placing', 'placed', 'shipped']);

export function freshInternal(): Internal {
  return {
    seq: 0, poSeq: 1041, seenIds: [], eyeCounts: {}, nodeCounts: {}, disagree: {}, usage: {}, leadDays: {}, jobs: [],
    replay: { market: false, cart: false, place: false }, screenOverride: null, screenUntil: {}, shopAfter: {}, recentChanges: {}, recentReaches: [], recentPicks: [], deliveries: {}, board: {}, teachUntil: null, heard: {}, buyerAwaySince: null,
    spend: { day: '', total: 0 }, catalog: null, lastHeartbeat: 0,
  };
}

export class RoomCore {
  s!: Snapshot;
  x!: Internal;
  private pending: Promise<unknown>[] = [];

  constructor(public readonly config: Config, public readonly deps: Deps) {}

  // ---------- life cycle ----------

  /** Reads the saved state, or starts from the seed when there is none. */
  async load(): Promise<void> {
    const saved = await this.deps.store.get<{ s: Snapshot; x: Internal }>('state');
    if (saved?.s && saved.x) {
      this.s = saved.s;
      this.x = { ...freshInternal(), ...saved.x };
      this.s.buyerOnline = false;
      return;
    }
    this.x = freshInternal();
    this.s = seedSnapshot(this.config, this.iso());
    applySampleHistory(this);
    for (const p of this.s.products) this.recomputePolicy(p.id, false);
    await this.save();
  }

  async save(): Promise<void> {
    await this.deps.store.put('state', { s: this.s, x: this.x });
  }

  /** Background work started by a request (naming a part). Tests await idle(). */
  later(p: Promise<unknown>): void {
    const guarded = p.catch((err) => console.error('background work failed', err));
    this.pending.push(guarded);
    this.deps.waitUntil?.(guarded);
  }

  async idle(): Promise<void> {
    while (this.pending.length > 0) await this.pending.shift();
  }

  // ---------- time and ids ----------

  nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  iso(ms = this.nowMs()): string {
    return isoIn(new Date(ms), this.config.TIME_ZONE);
  }

  today(): string {
    return dayIn(new Date(this.nowMs()), this.config.TIME_ZONE);
  }

  id(prefix: string): string {
    this.x.seq += 1;
    return `${prefix}-${this.x.seq}`;
  }

  /** True the first time an id is seen. Keeps the last 2000. */
  firstTime(id: string): boolean {
    if (this.x.seenIds.includes(id)) return false;
    this.x.seenIds.push(id);
    if (this.x.seenIds.length > 2000) this.x.seenIds.splice(0, this.x.seenIds.length - 2000);
    return true;
  }

  // ---------- sending ----------

  emit(msg: ServerMessage): void {
    this.deps.send(msg, 'all');
  }

  emitJob(job: Job): void {
    this.x.jobs.push(job);
    this.deps.send({ type: 'job', job }, 'buyer');
  }

  finishJob(jobId: string): void {
    this.x.jobs = this.x.jobs.filter((j) => j.id !== jobId);
  }

  activity(tone: Activity['tone'], text: string): void {
    const last = this.s.activity[this.s.activity.length - 1];
    if (last && last.text === text && last.tone === tone) return;
    const activity: Activity = { id: this.id('a'), ts: this.iso(), tone, text };
    this.s.activity.push(activity);
    if (this.s.activity.length > 20) this.s.activity.splice(0, this.s.activity.length - 20);
    this.emit({ type: 'activity', activity });
  }

  snapshot(): Snapshot {
    this.s.now = this.iso();
    return this.s;
  }

  // ---------- lookups ----------

  product(id: string | null | undefined): Product | undefined {
    return id ? this.s.products.find((p) => p.id === id) : undefined;
  }

  zone(id: string | null | undefined): Zone | undefined {
    return id ? this.s.zones.find((z) => z.id === id) : undefined;
  }

  count(productId: string): Count | undefined {
    return this.s.counts.find((c) => c.productId === productId);
  }

  policy(productId: string): Policy | undefined {
    return this.s.policies.find((p) => p.productId === productId);
  }

  order(id: string): Order | undefined {
    return this.s.orders.find((o) => o.id === id);
  }

  openOrderFor(productId: string): Order | undefined {
    return this.s.orders.find((o) => o.productId === productId && OPEN_STATES.has(o.state));
  }

  // ---------- usage and policy ----------

  usageDay(productId: string, day: string): UsageDay {
    const byDay = (this.x.usage[productId] ??= {});
    return (byDay[day] ??= { used: 0, restocked: 0, sample: false });
  }

  /** The last 30 completed local days, oldest first. Today is left out so a pick today does not move the rate today. */
  dailyUse(productId: string): { days: string[]; used: number[]; sample: boolean } {
    const days = daysBefore(this.today(), 30);
    const byDay = this.x.usage[productId] ?? {};
    return { days, used: days.map((d) => byDay[d]?.used ?? 0), sample: days.some((d) => byDay[d]?.sample === true) };
  }

  recomputePolicy(productId: string, announce = true): Policy | undefined {
    const product = this.product(productId);
    if (!product) return undefined;
    const use = this.dailyUse(productId);
    const policy = policyFor({
      productId,
      dailyUse: use.used,
      seasonFactor: this.s.season.factor,
      leadDays: this.x.leadDays[productId] ?? 2,
      capacity: product.capacity,
      count: this.count(productId)?.count ?? 0,
      sampleHistory: use.sample,
      now: this.iso(),
    });
    // A part set up on the board is ordered up to a full ledge: its sample use says when to order, the ledge says how many.
    if (this.x.board[productId] && product.capacity != null) policy.orderQty = Math.max(1, product.capacity - (this.count(productId)?.count ?? 0));
    const i = this.s.policies.findIndex((p) => p.productId === productId);
    if (i >= 0) this.s.policies[i] = policy;
    else this.s.policies.push(policy);
    if (announce) this.emit({ type: 'policy', policy });
    return policy;
  }

  // ---------- the screen ----------

  private wantedScreen(): { screen: Screen; focusProductId: string | null } {
    if (this.x.screenOverride) return this.x.screenOverride;
    const now = this.nowMs();
    const newestFirst = [...this.s.orders].reverse();
    const deciding = newestFirst.find((o) => o.state === 'awaiting_approval' || o.state === 'approved' || o.state === 'placing');
    if (deciding) return { screen: 'order', focusProductId: deciding.productId };
    const shopping = newestFirst.find((o) => (o.state === 'pricing' || o.state === 'carting') && (this.x.shopAfter[o.id] ?? 0) <= now);
    if (shopping) return { screen: 'shop', focusProductId: shopping.productId };
    const lingering = newestFirst.find((o) => (this.x.screenUntil[o.id] ?? 0) > now);
    if (lingering) return { screen: 'order', focusProductId: lingering.productId };
    return { screen: 'shelf', focusProductId: null };
  }

  refreshScreen(): void {
    const want = this.wantedScreen();
    if (want.screen === this.s.screen && want.focusProductId === this.s.focusProductId) return;
    this.s.screen = want.screen;
    this.s.focusProductId = want.focusProductId;
    this.emit({ type: 'screen', screen: want.screen, focusProductId: want.focusProductId });
  }

  /** Let the Shelf show the drop for a moment before the Shop screen takes over. */
  holdShelf(orderId: string, ms = REORDER_BEAT_MS): void {
    this.x.shopAfter[orderId] = this.nowMs() + ms;
  }

  /** Keep a finished order on the Order screen for 20 seconds. */
  holdScreen(orderId: string, ms = 20_000): void {
    this.x.screenUntil[orderId] = this.nowMs() + ms;
  }

  // ---------- sockets ----------

  setBuyerOnline(online: boolean): void {
    if (this.s.buyerOnline === online) return;
    this.s.buyerOnline = online;
    this.x.buyerAwaySince = online ? null : this.nowMs();
    this.emit({ type: 'buyer', online });
    if (!online && this.s.orders.some((o) => o.state === 'pricing' || o.state === 'carting')) this.activity('error', 'The buyer is offline.');
  }

  // ---------- time ----------

  /** Everything that happens because time passed. The Durable Object calls it from its alarm. */
  tick(): void {
    const now = this.nowMs();
    if (this.s.node.online && this.x.lastHeartbeat > 0 && now - this.x.lastHeartbeat > 15_000) {
      this.s.node = { ...this.s.node, online: false };
      this.emit({ type: 'node', node: this.s.node });
      this.activity('error', 'Shelf node offline. Using the eye for counts.');
    }
    for (const [zoneId, d] of Object.entries(this.x.disagree)) {
      if (d.raised || now - d.since <= 3000) continue;
      const eye = this.x.eyeCounts[zoneId];
      const node = this.x.nodeCounts[zoneId];
      if (!eye || !node || eye.count === node.count) continue;
      d.raised = true;
      this.activity('attention', `The eye and the shelf node disagree on ${this.zone(zoneId)?.name ?? zoneId}: ${eye.count} and ${node.count}.`);
    }
    this.expireTeach(now);
    this.expireOrders(now);
    for (const [orderId, until] of Object.entries(this.x.screenUntil)) if (until <= now) delete this.x.screenUntil[orderId];
    for (const [orderId, after] of Object.entries(this.x.shopAfter)) if (after <= now) delete this.x.shopAfter[orderId];
    this.refreshScreen();
  }

  /** Puts a new part card up, changes it or takes it down, and starts the clock on how long it may stay. */
  setTeach(teach: Snapshot['teach']): void {
    this.s.teach = teach;
    const wait = teach && teach.status in TEACH_WAIT_MS ? TEACH_WAIT_MS[teach.status as keyof typeof TEACH_WAIT_MS] : null;
    this.x.teachUntil = wait != null ? this.nowMs() + wait : null;
    this.emit({ type: 'teach', teach });
  }

  /** A new part card nobody finished comes down by itself. The part was never added, so nothing has to be undone. */
  private expireTeach(now: number): void {
    const teach = this.s.teach;
    if (!teach) return;
    if (this.x.teachUntil == null) {
      // A card from before the clock existed, or one put up some other way: its time starts now.
      const wait = teach.status in TEACH_WAIT_MS ? TEACH_WAIT_MS[teach.status as keyof typeof TEACH_WAIT_MS] : null;
      this.x.teachUntil = wait != null ? now + wait : null;
      return;
    }
    if (this.x.teachUntil > now) return;
    this.later(this.deps.store.delete(`crop:${teach.id}`));
    this.setTeach(null);
    this.activity('info', teach.status === 'needs_confirm' ? 'Nobody confirmed the new part. It was not added.' : 'The new part was not named. It was not added.');
  }

  /** The buyer said something about this order, or was just handed work for it: its wait starts again. */
  heardFrom(orderId: string): void {
    this.x.heard[orderId] = this.nowMs();
  }

  /** When the hub stops waiting on the buyer for this order, or null when the order is not waiting on the buyer. */
  private givenUpAt(order: Order): number | null {
    if (!ON_THE_BUYER.has(order.state)) return null;
    const heard = this.x.heard[order.id] ?? Date.parse(order.updatedAt);
    const quiet = heard + BUYER_WAIT_MS.quiet;
    if (this.s.buyerOnline) return quiet;
    return Math.min(quiet, Math.max(heard, this.x.buyerAwaySince ?? heard) + BUYER_WAIT_MS.away);
  }

  /**
   * An order the buyer never finishes fails by itself. Before the yes nothing was bought. After the yes the store may
   * have the order all the same, so the words say to check, and the store's webhook or a late report still marks it placed.
   */
  private expireOrders(now: number): void {
    for (const id of Object.keys(this.x.heard)) if (!this.s.orders.some((o) => o.id === id && ON_THE_BUYER.has(o.state))) delete this.x.heard[id];
    for (const order of this.s.orders) {
      const at = this.givenUpAt(order);
      if (at == null || at > now) continue;
      const who = this.s.buyerOnline ? 'The buyer stopped answering' : 'The buyer is offline';
      const error = order.state === 'approved' || order.state === 'placing' ? `${who} while the order was being placed. Check the store before ordering again.` : `${who}. Nothing was bought.`;
      order.state = 'failed';
      order.error = error;
      order.updatedAt = this.iso();
      this.x.jobs = this.x.jobs.filter((j) => !('orderId' in j) || j.orderId !== order.id);
      delete this.x.heard[order.id];
      delete this.x.shopAfter[order.id];
      this.holdScreen(order.id);
      this.deps.history.order(order);
      this.emit({ type: 'order', order });
      this.activity('error', error);
    }
  }

  /** When tick() next has something to do, or null. */
  nextDeadline(): number | null {
    const times: number[] = [];
    if (this.s.node.online && this.x.lastHeartbeat > 0) times.push(this.x.lastHeartbeat + 15_001);
    for (const d of Object.values(this.x.disagree)) if (!d.raised) times.push(d.since + 3001);
    if (this.s.teach && this.x.teachUntil != null) times.push(this.x.teachUntil + 1);
    for (const order of this.s.orders) {
      const at = this.givenUpAt(order);
      if (at != null) times.push(at + 1);
    }
    for (const until of Object.values(this.x.screenUntil)) times.push(until + 1);
    for (const after of Object.values(this.x.shopAfter)) times.push(after + 1);
    return times.length > 0 ? Math.min(...times) : null;
  }
}
