// Talking to the hub: where it is, the tokens this browser holds, and one small fetch helper.
const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);

export const param = (name: string) => query.get(name);

/** '' means the hub is this page's own origin, which is how it is deployed. */
export const HUB = (param('hub') ?? (import.meta.env?.VITE_HUB_URL as string | undefined) ?? '').replace(/\/$/, '');

export function liveUrl(role: 'screen' | 'ops'): string {
  const base = HUB !== '' ? HUB.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  return `${base}/live?role=${role}`;
}

/** A path on the hub, for images such as a teach crop. */
export const hubUrl = (path: string) => (/^https?:/.test(path) ? path : `${HUB}${path}`);

/** A token given once in the address (?ops= or ?k=) is kept for the session and used after that. */
export function token(kind: 'ops' | 'k'): string | null {
  const key = `reup.${kind}`;
  try {
    const given = param(kind);
    if (given) sessionStorage.setItem(key, given);
    return sessionStorage.getItem(key);
  } catch {
    return param(kind);
  }
}

export function setToken(kind: 'ops' | 'k', value: string): void {
  try {
    sessionStorage.setItem(`reup.${kind}`, value);
  } catch {
    // private mode: the token lasts for this page only
  }
}

export interface Reply<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** The hub's plain message when it said no. */
  message: string | null;
}

export async function call<T = unknown>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, bearer?: string | null, fetcher: typeof fetch = fetch): Promise<Reply<T>> {
  try {
    const res = await fetcher(`${HUB}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
    return { ok: res.ok, status: res.status, data: res.ok ? data : null, message: res.ok ? null : (data?.message ?? `The hub answered ${res.status}.`) };
  } catch {
    return { ok: false, status: 0, data: null, message: 'Hub unreachable.' };
  }
}
