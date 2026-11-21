/** The whole store as one Hono app, with no Cloudflare in it, so tests can drive it in Node. */
import { Hono } from 'hono';
import { page, withSession, type Hooks, type StoreEnv } from './lib/app';
import type { Shop } from './lib/shop';
import { account } from './routes/account';
import { admin } from './routes/admin';
import { cart } from './routes/cart';
import { catalog } from './routes/catalog';
import { checkout } from './routes/checkout';

export function createStore(shop: Shop, hooks: Hooks): Hono<StoreEnv> {
  const app = new Hono<StoreEnv>();
  app.use('*', withSession(shop, hooks));
  app.route('/', catalog);
  app.route('/', account);
  app.route('/', cart);
  app.route('/', checkout);
  app.route('/', admin);
  app.notFound((c) => page(c, 'Not found', <><h1>Page not found</h1><p><a href="/">Back to the store</a>.</p></>, { status: 404 }));
  app.onError((err, c) => {
    console.error('store error', err);
    return page(c, 'Something went wrong', <><h1>Something went wrong</h1><p>Please try again. <a href="/">Back to the store</a>.</p></>, { status: 400 });
  });
  return app;
}
