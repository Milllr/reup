/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import type { SupplyWebhookBody } from '@reup/contracts';
import { DEFAULTS, type Config } from '../src/lib/config';
import { Shop } from '../src/lib/shop';
import type { Sql } from '../src/lib/sql';
import { createStore } from '../src/store';

/** D1 speaks SQLite, so the store's real SQL runs here on node:sqlite. */
export function sqlite(): Sql {
  const db = new DatabaseSync(':memory:');
  return {
    run: async (sql, ...args) => void db.prepare(sql).run(...(args as never[])),
    all: async <T,>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as never[])) as T[],
    first: async <T,>(sql: string, ...args: unknown[]) => (db.prepare(sql).get(...(args as never[])) as T | undefined) ?? null,
  };
}

export interface Rig {
  shop: Shop;
  notified: SupplyWebhookBody[];
  scheduled: string[];
  clock: { now: Date };
  /** A browser: keeps cookies between requests. */
  browser(): Browser;
}

export interface Browser {
  get(path: string): Promise<{ status: number; text: string; location: string | null }>;
  post(path: string, fields?: Record<string, string>): Promise<{ status: number; text: string; location: string | null }>;
  /** Follows redirects from a post, like a person would see. */
  submit(path: string, fields?: Record<string, string>): Promise<{ status: number; text: string; path: string }>;
}

export function rig(config: Partial<Config> = {}, now = new Date('2026-11-21T14:14:00Z')): Rig {
  const clock = { now };
  let n = 0;
  const shop = new Shop(sqlite(), { ...DEFAULTS, ...config }, () => clock.now, () => ((n++ * 7919) % 90000) / 90000);
  const notified: SupplyWebhookBody[] = [];
  const scheduled: string[] = [];
  const app = createStore(shop, { notify: (body) => void notified.push(body), schedule: (c) => void scheduled.push(c) });
  const browser = (): Browser => {
    const jar = new Map<string, string>();
    const send = async (path: string, init: RequestInit) => {
      const res = await app.request(`http://offcut.test${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
      for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const [k, v] = (pair ?? '').split('=');
        if (k) jar.set(k, v ?? '');
      }
      return { status: res.status, text: await res.text(), location: res.headers.get('location') };
    };
    const get = (path: string) => send(path, { method: 'GET' });
    const post = (path: string, fields: Record<string, string> = {}) => send(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
    return {
      get, post,
      submit: async (path, fields) => {
        let res = await post(path, fields);
        let at = path;
        while (res.location && res.status >= 300 && res.status < 400) {
          at = res.location;
          res = await get(at);
        }
        return { status: res.status, text: res.text, path: at };
      },
    };
  };
  return { shop, notified, scheduled, clock, browser };
}

export async function signedIn(r: Rig): Promise<Browser> {
  const b = r.browser();
  await b.post('/signin', { email: DEFAULTS.ACCOUNT_EMAIL, password: DEFAULTS.ACCOUNT_PASSWORD, next: '/' });
  return b;
}
