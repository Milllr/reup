// Ships each new order a little after it is placed, the way a real store's warehouse would, and tells the hub.
// A Durable Object alarm does the waiting, so it works with nobody on the site.
import { DurableObject } from 'cloudflare:workers';
import { configFrom } from './lib/config';
import { Shop } from './lib/shop';
import { d1 } from './lib/sql';
import { sendWebhook, shipDue, type Shipment } from './webhook';

export interface Env {
  DB: D1Database;
  SHIPPER: DurableObjectNamespace<Shipper>;
  [key: string]: unknown;
}

export class Shipper extends DurableObject<Env> {
  async schedule(confirmation: string, delayMs: number): Promise<void> {
    const pending = (await this.ctx.storage.get<Shipment[]>('pending')) ?? [];
    pending.push({ confirmation, dueAt: Date.now() + delayMs });
    await this.ctx.storage.put('pending', pending);
    const earliest = Math.min(...pending.map((p) => p.dueAt));
    await this.ctx.storage.setAlarm(earliest);
  }

  override async alarm(): Promise<void> {
    const config = configFrom(this.env);
    const shop = new Shop(d1(this.env.DB), config);
    await shop.init();
    const pending = (await this.ctx.storage.get<Shipment[]>('pending')) ?? [];
    const waiting = await shipDue(shop, pending, Date.now(), (body) => sendWebhook(config, body));
    await this.ctx.storage.put('pending', waiting);
    if (waiting.length > 0) await this.ctx.storage.setAlarm(Math.min(...waiting.map((p) => p.dueAt)));
  }
}
