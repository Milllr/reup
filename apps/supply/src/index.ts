// Offcut Supply's Worker. A plain web store: server rendered pages, D1, and a webhook to reup's hub.
import { configFrom } from './lib/config';
import { Shop } from './lib/shop';
import { d1 } from './lib/sql';
import { Shipper, type Env } from './shipper-do';
import { createStore } from './store';
import { sendWebhook } from './webhook';

export { Shipper };

let cached: { db: D1Database; shop: Shop } | null = null;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = configFrom(env);
    if (!cached || cached.db !== env.DB) cached = { db: env.DB, shop: new Shop(d1(env.DB), config) };
    const app = createStore(cached.shop, {
      notify: (body) => ctx.waitUntil(sendWebhook(config, body)),
      schedule: (confirmation) => ctx.waitUntil(env.SHIPPER.get(env.SHIPPER.idFromName('main')).schedule(confirmation, config.SHIP_DELAY_MS)),
    });
    return app.fetch(request);
  },
} satisfies ExportedHandler<Env>;
