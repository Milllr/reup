// Place: only ever run when the hub sends the job, and the hub sends it only after a person said yes.
import type { IngestPlacedBody, Job, Supplier } from '@reup/contracts';
import type { AgentParams } from '../agent';
import { signInStep, type CartPlan, type SignIn } from '../cart';
import type { RunSpec } from '../runner';

export type PlaceJob = Extract<Job, { kind: 'place' }>;
export type TrackJob = Extract<Job, { kind: 'track' }>;

export const PLACE_SCHEMA = {
  type: 'object',
  properties: {
    confirmation: { type: 'string', nullable: true },
    delivery_date: { type: 'string', nullable: true },
    reason: { type: 'string', nullable: true },
  },
  required: ['confirmation', 'delivery_date', 'reason'],
};

/** What the cart should hold when the order is placed. Kept from the cart job, or rebuilt from the hub's state. */
export interface Basket {
  sku: string | null;
  phrase: string;
  units: number;
  plan: CartPlan;
}

export function placeGoal(job: PlaceJob, basket: Basket | null, signIn: SignIn): string {
  const want = basket ? `${basket.plan.packs} of ${basket.sku ? `SKU ${basket.sku}` : `"${basket.phrase}"`}${basket.plan.packLabel ? ` in the pack size "${basket.plan.packLabel}"` : ''}` : null;
  return [
    'Place an order that a person has already approved. The cart should be ready.',
    '1. If a cookie notice covers the page, accept it.',
    want
      ? `2. Open the cart. It must hold exactly ${want} and nothing else. If it does not, press "Empty cart", find that product, add it in that quantity, and open the cart again.`
      : '2. Open the cart. If it is empty, stop and return confirmation null with the reason "The cart was empty."',
    '3. Press "Checkout".',
    `4. ${signInStep(signIn).replace(/cart_ok false/g, 'confirmation null')}`,
    `5. On the page titled "Review your order", type ${job.poNumber} into the field labelled "PO number".`,
    '6. Payment must read "Bill to account". Never enter a card number. If the page asks for one, stop and return confirmation null with the reason.',
    '7. Press "Place order" once.',
    // The first real run read the page 3 seconds after the press, before the order page had loaded, and reported no number for an order the store had taken.
    '8. Wait for the next page to finish loading. It is headed "Order" and a number, and says "Thank you. Your order is placed." If the page still says "Review your order" and shows no error, wait 5 seconds and look again, up to 3 times. Do not press "Place order" again.',
    '9. From that page return confirmation (the number beside "Confirmation number", exactly as shown, for example OC-58213), delivery_date (the date beside "Delivery date", exactly as shown) and reason (null).',
    'Rules: press "Place order" only once. If after waiting no confirmation number appears, return confirmation null and the reason in one plain sentence. Never guess a number.',
  ].join('\n');
}

export function placeParams(supplier: Supplier, job: PlaceJob, basket: Basket | null, signIn: SignIn, profileId: string): AgentParams {
  return {
    url: `${supplier.baseUrl.replace(/\/$/, '')}/cart`,
    goal: placeGoal(job, basket, signIn),
    outputSchema: PLACE_SCHEMA,
    browserProfile: 'lite',
    proxyCountry: null,
    maxDurationSeconds: 240,
    profileId: profileId !== '' ? profileId : null,
    task: { kind: 'place', poNumber: job.poNumber, sku: basket?.sku ?? null, units: basket?.units ?? 0, packIndex: basket?.plan.packIndex ?? null },
  };
}

/** A run that ends without a confirmation number is a failure, never a guess. */
export function placeCheck(result: Record<string, unknown> | null): string | null {
  const c = result?.confirmation;
  if (typeof c === 'string' && /^[A-Z]{1,4}-?\d{3,}$/i.test(c.trim())) return null;
  return typeof result?.reason === 'string' && result.reason.trim() !== '' ? result.reason.trim() : 'The store showed no confirmation number.';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function offsetFor(day: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, timeZoneName: 'longOffset' }).formatToParts(new Date(`${day}T17:00:00Z`));
  return parts.find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00';
}

/** "Tuesday, Nov 24" or "2026-11-24" becomes noon local on that day, as ISO 8601 with the zone's offset. Null when it cannot be read. */
export function parseDeliveryDate(text: unknown, now: Date, timeZone: string): string | null {
  if (typeof text !== 'string') return null;
  let day: string | null = null;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) day = `${iso[1]}-${iso[2]}-${iso[3]}`;
  else {
    const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/.exec(text);
    const month = m ? MONTHS.indexOf((m[1] ?? '').toLowerCase()) : -1;
    if (m && month >= 0) {
      let year = m[3] ? Number(m[3]) : now.getUTCFullYear();
      // "Jan 4" read in December means next January.
      if (!m[3] && month < now.getUTCMonth() - 6) year += 1;
      day = `${year}-${String(month + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    }
  }
  if (!day || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) return null;
  return `${day}T12:00:00${offsetFor(day, timeZone)}`;
}

export function toPlacedBody(job: PlaceJob, ok: boolean, result: Record<string, unknown> | null, error: string | null, now: Date, timeZone: string): IngestPlacedBody {
  if (!ok || !result || typeof result.confirmation !== 'string') return { jobId: job.id, orderId: job.orderId, ok: false, confirmation: null, eta: null, error: error ?? 'The store showed no confirmation number.' };
  return { jobId: job.id, orderId: job.orderId, ok: true, confirmation: result.confirmation.trim().toUpperCase(), eta: parseDeliveryDate(result.delivery_date, now, timeZone), error: null };
}

export function placeSpec(supplier: Supplier, job: PlaceJob, basket: Basket | null, signIn: SignIn, profileId: string): RunSpec {
  // A failed place run is never answered with a recording by itself: only the operator's replay switch plays one.
  return { kind: 'place', supplier, productId: null, orderId: job.orderId, params: placeParams(supplier, job, basket, signIn, profileId), replay: job.replay === true, fallback: false, check: placeCheck };
}

export const TRACK_SCHEMA = { type: 'object', properties: { status: { type: 'string', nullable: true }, delivery_date: { type: 'string', nullable: true } }, required: ['status', 'delivery_date'] };

export function trackParams(supplier: Supplier, job: TrackJob, signIn: SignIn, profileId: string): AgentParams {
  return {
    url: `${supplier.baseUrl.replace(/\/$/, '')}/orders/${encodeURIComponent(job.confirmation)}`,
    goal: ['Read the status of one order.', `1. ${signInStep(signIn).replace(/cart_ok false with the reason .*$/, 'status null.')}`, `2. On the page for order ${job.confirmation}, read the status and the delivery date, return them, and stop.`].join('\n'),
    outputSchema: TRACK_SCHEMA, browserProfile: 'lite', proxyCountry: null, maxDurationSeconds: 120, profileId: profileId !== '' ? profileId : null,
    task: { kind: 'track', confirmation: job.confirmation },
  };
}
