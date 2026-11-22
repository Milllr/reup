// Market check: read one price from each live retailer. Prices only. Never a cart, never a sign in.
import type { Job, Quote, Supplier } from '@reup/contracts';
import type { AgentParams } from '../agent';
import type { RunSpec } from '../runner';

export const MARKET_SCHEMA = {
  type: 'object',
  properties: {
    listing_name: { type: 'string', nullable: true },
    pack_size: { type: 'integer', nullable: true, minimum: 1 },
    price: { type: 'number', nullable: true, minimum: 0 },
    currency: { type: 'string', nullable: true },
    in_stock: { type: 'boolean', nullable: true },
    delivery_days: { type: 'number', nullable: true, minimum: 0 },
    product_url: { type: 'string', nullable: true },
  },
  required: ['listing_name', 'pack_size', 'price', 'currency', 'in_stock', 'delivery_days', 'product_url'],
};

export function marketGoal(phrase: string): string {
  return [
    `You are on a store's search results for "${phrase}". Find the going price for it.`,
    '1. If a cookie notice or a pop up covers the page, close it.',
    '2. Look at the first 5 listings only. Skip any marked sponsored or ad, and skip bundles and assortment kits.',
    `3. Of the listings that match "${phrase}" in size and count, choose the one with the lowest price before tax and shipping.`,
    '4. Return these fields for that listing:',
    '   listing_name: the name exactly as the site shows it.',
    '   pack_size: how many boxes, bags or packs the listing contains. 1 for a single box.',
    '   price: the price before tax and shipping, as a number with no currency sign.',
    '   currency: the ISO code, for example CAD.',
    '   in_stock: true or false. delivery_days: days until delivery if the page says, else null. product_url: its URL.',
    'Rules: never add anything to a cart. Never sign in or create an account. Never open more than one product page. If the site shows a captcha, a block page or asks you to verify you are human, stop at once and return every field as null.',
    'When you have the answer, stop.',
  ].join('\n');
}

export function marketParams(supplier: Supplier, job: Extract<Job, { kind: 'market' }>): AgentParams {
  return {
    url: supplier.searchUrl.replace('{q}', encodeURIComponent(job.searchPhrase)),
    goal: marketGoal(job.searchPhrase),
    outputSchema: MARKET_SCHEMA,
    browserProfile: 'stealth',
    proxyCountry: supplier.country,
    maxDurationSeconds: 180,
    profileId: null,
    task: { kind: 'market', supplierId: supplier.id, sku: null, phrase: job.searchPhrase },
  };
}

const BLOCKED = /captcha|verify (that )?you are (a )?human|access denied|blocked|unusual traffic|robot/i;

/** A completed run with no price, or one that talks about a captcha or a block, is not a quote. */
export function marketCheck(result: Record<string, unknown> | null): string | null {
  if (!result) return 'The site gave no answer.';
  if (BLOCKED.test(JSON.stringify(result)) && typeof result.price !== 'number') return 'The site showed a challenge page.';
  if (typeof result.price !== 'number' || !(result.price > 0)) return 'No price on the page.';
  return null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export function toQuote(id: string, job: Extract<Job, { kind: 'market' }>, supplier: Supplier, runId: string | null, ok: boolean, result: Record<string, unknown> | null, fetchedAt: string): Quote {
  if (!ok || !result) return { id, productId: job.productId, supplierId: supplier.id, listingName: null, packSize: null, price: null, currency: null, unitPrice: null, inStock: null, deliveryDays: null, url: null, runId, ok: false, fetchedAt };
  const price = num(result.price);
  const packSize = Math.max(1, Math.round(num(result.pack_size) ?? 1));
  return {
    id, productId: job.productId, supplierId: supplier.id, listingName: text(result.listing_name), packSize, price, currency: text(result.currency) ?? 'CAD',
    unitPrice: price != null ? Math.round((price / packSize) * 100) / 100 : null,
    inStock: typeof result.in_stock === 'boolean' ? result.in_stock : null, deliveryDays: num(result.delivery_days), url: text(result.product_url), runId, ok: price != null, fetchedAt,
  };
}

export function marketSpec(supplier: Supplier, job: Extract<Job, { kind: 'market' }>): RunSpec {
  return { kind: 'market', supplier, productId: job.productId, orderId: null, subject: job.productId, params: marketParams(supplier, job), replay: job.replay === true, fallback: true, check: marketCheck };
}
