// Cart: fill a cart at the account supplier and stop at the review page. Placing the order is a different job, after a yes.
import { packsFor } from '@reup/brain';
import type { CatalogItem, IngestCartBody, Job, Supplier } from '@reup/contracts';
import type { AgentParams } from '../agent';
import type { RunSpec } from '../runner';

export type CartJob = Extract<Job, { kind: 'cart' }>;

export const CART_SCHEMA = {
  type: 'object',
  properties: {
    cart_ok: { type: 'boolean' },
    reason: { type: 'string', nullable: true },
    pack_label: { type: 'string', nullable: true },
    pack_size: { type: 'integer', nullable: true, minimum: 1 },
    packs: { type: 'integer', nullable: true, minimum: 1 },
    unit_price: { type: 'number', nullable: true, minimum: 0 },
    total: { type: 'number', nullable: true, minimum: 0 },
    delivery_days: { type: 'number', nullable: true, minimum: 0 },
    delivery_date: { type: 'string', nullable: true },
  },
  required: ['cart_ok', 'reason', 'pack_label', 'pack_size', 'packs', 'unit_price', 'total', 'delivery_days', 'delivery_date'],
};

export interface CartPlan {
  /** The catalog item, when the SKU is known to the store. */
  item: CatalogItem | null;
  packIndex: number | null;
  packLabel: string | null;
  packSize: number;
  packs: number;
}

/** The pack that gives the lowest total for the units, worked out from the store's public catalog. */
export function planCart(job: CartJob, catalog: readonly CatalogItem[]): CartPlan {
  const item = job.sku ? (catalog.find((i) => i.sku.toLowerCase() === job.sku?.toLowerCase()) ?? null) : null;
  const choice = item ? packsFor(job.units, item.packs) : null;
  if (!item || !choice) return { item, packIndex: null, packLabel: null, packSize: 1, packs: job.units };
  return { item, packIndex: item.packs.indexOf(choice.pack), packLabel: choice.pack.label, packSize: choice.pack.size, packs: choice.packs };
}

export interface SignIn {
  /** A saved signed in session exists: the agent should already be signed in. */
  profile: boolean;
  email: string;
  password: string;
}

export function signInStep(s: SignIn): string {
  if (s.password !== '') return `If the store asks you to sign in, use the email ${s.email} and the password ${s.password}, then carry on.`;
  if (s.profile) return 'You should already be signed in. If the store still asks you to sign in, stop and return cart_ok false with the reason "The store asked for a sign in."';
  return 'If the store asks you to sign in, stop and return cart_ok false with the reason "The store asked for a sign in."';
}

/**
 * Where the cart run starts. When the store's catalog has the SKU it is the product's own page, with the pack and the
 * quantity in the link, so the agent does not search, choose or type. Otherwise it is the search results.
 */
export function cartStart(supplier: Supplier, job: CartJob, plan: CartPlan): string {
  const base = supplier.baseUrl.replace(/\/$/, '');
  if (plan.item && plan.packIndex != null) return `${base}/p/${encodeURIComponent(plan.item.sku)}?pack=${plan.packIndex}&qty=${plan.packs}`;
  return `${base}/search?q=${encodeURIComponent(job.sku ?? job.searchPhrase)}`;
}

/** A line every goal at the store carries: the notice is a bar, not an overlay, and accepting it costs a step. */
export const COOKIE_NOTE = 'A yellow cookie notice may sit at the top of the page. Leave it alone: it covers nothing.';

export function cartGoal(job: CartJob, plan: CartPlan, signIn: SignIn): string {
  const steps: string[] = [];
  // A saved profile is already signed in, and the account's cart may still hold what an earlier run left.
  // A fresh browser starts with an empty cart, and the cart it brings to the sign in replaces the saved one.
  if (signIn.profile) steps.push('Open the cart. If it has anything in it, press "Empty cart". Then go back to the page you started on.');
  if (plan.item && plan.packIndex != null && plan.packLabel) {
    steps.push(`You start on the product page for SKU ${plan.item.sku}. If it says "Out of stock", stop and return cart_ok false with the reason "The item is out of stock."`);
    steps.push(`The pack size "${plan.packLabel}" should already be chosen and the quantity should already read ${plan.packs}. Change them only if they are not.`);
  } else {
    steps.push(job.sku ? `You start on the search results for the SKU ${job.sku}. Open that product.` : `You start on the search results for "${job.searchPhrase}". Open the product that matches best.`);
    steps.push('If the product page says "Out of stock", stop and return cart_ok false with the reason "The item is out of stock."');
    steps.push(plan.packLabel ? `Choose the pack size "${plan.packLabel}" and set the quantity to ${plan.packs}.` : `Choose the pack size that gives the lowest total for ${job.units} units, and set the quantity to match.`);
  }
  steps.push('Press "Add to cart" once. The cart page opens with the item in it.');
  steps.push(`On the cart page press "Checkout".${signIn.profile ? '' : ' Never press "Empty cart".'}`);
  steps.push(`${signInStep(signIn)} The cart is kept through the sign in.`);
  steps.push('On the page titled "Review your order", read the pack, the quantity, the price, the total and the delivery date.');
  steps.push('Stop here. Do not type a PO number. Do not press "Place order". Return what you read with cart_ok true:');
  return [
    'Fill a cart at this store and stop at the order review page. Do not place the order.',
    COOKIE_NOTE,
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    '   pack_label: the pack size as shown. pack_size: units in one pack, 1 for a single box. packs: the quantity in the cart.',
    '   unit_price: the price of one pack. total: the order total with tax and shipping, as a number.',
    '   delivery_date: the delivery date exactly as shown. delivery_days: business days until delivery if the page says, else null.',
    '   reason: null when cart_ok is true. When cart_ok is false, why, in one plain sentence.',
  ].join('\n');
}

export function cartParams(supplier: Supplier, job: CartJob, plan: CartPlan, signIn: SignIn, profileId: string): AgentParams {
  return {
    url: cartStart(supplier, job, plan),
    goal: cartGoal(job, plan, signIn),
    outputSchema: CART_SCHEMA,
    browserProfile: 'lite',
    proxyCountry: null,
    // About 8 steps when the link carries the pack and the quantity. A run that is still going after this is lost, and the recording answers.
    maxDurationSeconds: 150,
    profileId: profileId !== '' ? profileId : null,
    task: { kind: 'cart', sku: job.sku, phrase: job.searchPhrase, units: job.units, packIndex: plan.packIndex },
  };
}

export function cartCheck(result: Record<string, unknown> | null): string | null {
  if (!result) return 'The store gave no answer.';
  if (result.cart_ok !== true) return typeof result.reason === 'string' && result.reason.trim() !== '' ? result.reason.trim() : 'The cart could not be filled.';
  if (typeof result.total !== 'number' || !(result.total > 0)) return 'The review page showed no total.';
  return null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function toCartBody(job: CartJob, plan: CartPlan, ok: boolean, result: Record<string, unknown> | null, error: string | null): IngestCartBody {
  if (!ok || !result) return { jobId: job.id, orderId: job.orderId, ok: false, packSize: null, packs: null, unitPrice: null, total: null, deliveryDays: null, error: error ?? 'The cart could not be filled.' };
  const packSize = Math.max(1, Math.round(num(result.pack_size) ?? plan.packSize));
  const packs = Math.max(1, Math.round(num(result.packs) ?? plan.packs));
  const packPrice = num(result.unit_price) ?? (plan.item && plan.packIndex != null ? (plan.item.packs[plan.packIndex]?.price ?? null) : null);
  return {
    jobId: job.id, orderId: job.orderId, ok: true, packSize, packs,
    // The hub's unit price is per unit on the board: the price of a pack, divided by what is in it.
    unitPrice: packPrice != null ? Math.round((packPrice / packSize) * 100) / 100 : null,
    total: num(result.total), deliveryDays: num(result.delivery_days) ?? plan.item?.leadDays ?? null, error: null,
  };
}

export function cartSpec(supplier: Supplier, job: CartJob, plan: CartPlan, signIn: SignIn, profileId: string): RunSpec {
  return { kind: 'cart', supplier, productId: job.productId, orderId: job.orderId, params: cartParams(supplier, job, plan, signIn, profileId), replay: job.replay === true, fallback: true, check: cartCheck };
}
