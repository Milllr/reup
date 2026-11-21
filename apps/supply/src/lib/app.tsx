/** Shared by every route file: the Hono types, the session middleware and the page helper. */
import type { SupplyWebhookBody } from '@reup/contracts';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Child } from 'hono/jsx';
import { Page } from './layout';
import type { Session, Shop } from './shop';

export interface Hooks {
  /** Tell the hub. Must not block the page. */
  notify(body: SupplyWebhookBody): void;
  /** Ship this order a little later and tell the hub then. */
  schedule(confirmation: string): void;
}

export type StoreEnv = { Variables: { shop: Shop; hooks: Hooks; session: Session; cartCount: number; cookiesOk: boolean } };
export type Ctx = Context<StoreEnv>;

const WEEK = 7 * 24 * 60 * 60;

export function withSession(shop: Shop, hooks: Hooks): MiddlewareHandler<StoreEnv> {
  return async (c, next) => {
    await shop.init();
    const session = await shop.session(getCookie(c, 'oc_session'));
    setCookie(c, 'oc_session', session.id, { path: '/', maxAge: WEEK, httpOnly: true, sameSite: 'Lax', secure: new URL(c.req.url).protocol === 'https:' });
    c.set('shop', shop);
    c.set('hooks', hooks);
    c.set('session', session);
    c.set('cartCount', await shop.cartCount(session.id));
    c.set('cookiesOk', getCookie(c, 'oc_cookies') === '1');
    await next();
  };
}

export function page(c: Ctx, title: string, children: Child, options: { status?: 200 | 400 | 401 | 404; query?: string } = {}) {
  const url = new URL(c.req.url);
  return c.html(
    <Page title={title} session={c.get('session')} cartCount={c.get('cartCount')} cookiesOk={c.get('cookiesOk')} path={url.pathname + url.search} query={options.query}>
      {children}
    </Page>,
    options.status ?? 200,
  );
}

/** A form field as text, trimmed. Missing fields and files read as the empty string. */
export async function form(c: Ctx): Promise<(name: string) => string> {
  const data = await c.req.parseBody();
  return (name) => (typeof data[name] === 'string' ? (data[name] as string).trim() : '');
}

/** Only ever redirect inside the store. */
export const safeNext = (next: string, fallback: string) => (/^\/(?!\/)/.test(next) ? next : fallback);
