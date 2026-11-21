// Telling reup's hub what happened to an order. Never blocks a page: callers hand the promise to waitUntil.
import type { SupplyWebhookBody } from '@reup/contracts';
import type { Config } from '../lib/config';
import { etaIso } from '../lib/money';
import type { Shop, StoreOrder } from '../lib/shop';

export const RETRY_DELAYS_MS = [500, 1500, 3000];

export function webhookBody(event: SupplyWebhookBody['event'], order: StoreOrder, timeZone: string): SupplyWebhookBody {
  return { event, confirmation: order.confirmation, poNumber: order.poNumber, eta: etaIso(order.eta, timeZone) };
}

/** Posts once and retries 3 times on a network error, a 5xx or a 429. A 4xx means the hub does not want it. */
export async function sendWebhook(config: Config, body: SupplyWebhookBody, fetcher: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 0);
    try {
      const res = await fetcher(`${config.HUB_URL}/hooks/supply`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Offcut-Secret': config.SUPPLY_WEBHOOK_SECRET }, body: JSON.stringify(body) });
      if (res.ok) return true;
      if (res.status < 500 && res.status !== 429) return false;
    } catch (err) {
      console.error('webhook attempt failed', attempt + 1, err);
    }
  }
  return false;
}

export interface Shipment {
  confirmation: string;
  dueAt: number;
}

/** Ships every order whose time has come and tells the hub. Returns what is still waiting. */
export async function shipDue(shop: Shop, pending: readonly Shipment[], nowMs: number, notify: (body: SupplyWebhookBody) => Promise<unknown>): Promise<Shipment[]> {
  const waiting: Shipment[] = [];
  for (const shipment of pending) {
    if (shipment.dueAt > nowMs) {
      waiting.push(shipment);
      continue;
    }
    const order = await shop.setStatus(shipment.confirmation, 'Shipped');
    if (order) await notify(webhookBody('order.shipped', order, shop.config.TIME_ZONE));
  }
  return waiting;
}
