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

export function cartGoal(job: CartJob, plan: CartPlan, signIn: SignIn): string {
  const find = job.sku ? `Search the store for the SKU ${job.sku} and open that product.` : `Search the store for "${job.searchPhrase}" and open the product that matches best.`;
  const pack = plan.packLabel ? `Choose the pack size "${plan.packLabel}" and set the quantity to ${plan.packs}.` : `Choose the pack size that gives the lowest total for ${job.units} units, and set the quantity to match.`;
  return [
    'Fill a cart at this store and stop at the order review page. Do not place the order.',
    '1. If a cookie notice covers the page, accept it.',
    '2. Open the cart. If it has anything in it, press "Empty cart".',
    `3. ${find}`,
    '4. If the product page says "Out of stock", stop and return cart_ok false with the reason "The item is out of stock."',
    `5. ${pack}`,
    '6. Press "Add to cart".',
    '7. Open the cart and press "Checkout".',
    `8. ${signInStep(signIn)}`,
    '9. On the page titled "Review your order", read the pack, the quantity, the price, the total and the delivery date.',
    '10. Stop here. Do not type a PO number. Do not press "Place order". Return what you read with cart_ok true:',
    '   pack_label: the pack size as shown. pack_size: units in one pack, 1 for a single box. packs: the quantity in the cart.',
    '   unit_price: the price of one pack. total: the order total with tax and shipping, as a number.',
    '   delivery_date: the delivery date exactly as shown. delivery_days: business days until delivery if the page says, else null.',
    '   reason: null when cart_ok is true. When cart_ok is false, why, in one plain sentence.',
  ].join('\n');
}

export function cartParams(supplier: Supplier, job: CartJob, plan: CartPlan, signIn: SignIn, profileId: string): AgentParams {
  return {
    url: `${supplier.baseUrl.replace(/\/$/, '')}/cart`,
    goal: cartGoal(job, plan, signIn),
    outputSchema: CART_SCHEMA,
    browserProfile: 'lite',
    proxyCountry: null,
    maxDurationSeconds: 240,
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
