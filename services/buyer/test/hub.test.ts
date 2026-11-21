import { describe, expect, it } from 'vitest';
import jobsMock from '../../../contracts/mocks/jobs.json';
import snapshotMock from '../../../contracts/mocks/snapshot.json';
import { backoff, HubLink, type Socket } from '../src/hub';

class FakeSocket implements Socket {
  handlers: Record<string, ((data?: unknown) => void)[]> = {};
  sent: string[] = [];
  on(event: string, fn: (data?: unknown) => void) { (this.handlers[event] ??= []).push(fn); }
  emit(event: string, data?: unknown) { for (const fn of this.handlers[event] ?? []) fn(data); }
  send(data: string) { this.sent.push(data); }
  close() { this.emit('close'); }
}

function setup(fetcher: typeof fetch) {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const waits: number[] = [];
  const jobs: string[] = [];
  const link = new HubLink({
    hubUrl: 'https://hub.test', token: 'dev-device-token', fetch: fetcher,
    makeSocket: (url) => { urls.push(url); const s = new FakeSocket(); sockets.push(s); return s; },
    later: (fn, ms) => { waits.push(ms); fn(); },
    onJob: (job) => void jobs.push(job.id),
    log: () => {},
  });
  return { link, sockets, urls, waits, jobs };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the hub link', () => {
  it('connects as the buyer with the device token', () => {
    const { link, urls } = setup((async () => new Response('{}')) as unknown as typeof fetch);
    link.connect();
    expect(urls).toEqual(['wss://hub.test/live?role=buyer&token=dev-device-token']);
  });

  it('asks for missed jobs on every connect, and hands each job over once', async () => {
    const asked: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      asked.push(`${url} ${new Headers(init?.headers).get('Authorization')}`);
      return new Response(JSON.stringify(jobsMock));
    }) as unknown as typeof fetch;
    const { link, sockets, jobs, waits } = setup(fetcher);
    link.connect();
    sockets[0]?.emit('open');
    await tick();
    expect(asked).toEqual(['https://hub.test/api/jobs Bearer dev-device-token']);
    expect(jobs).toEqual(['j-1', 'j-2', 'j-3', 'j-4']);
    // The same job arriving over the socket, and again after a reconnect, is not run twice.
    sockets[0]?.emit('message', JSON.stringify({ type: 'job', job: jobsMock.jobs[0] }));
    sockets[0]?.emit('message', JSON.stringify({ type: 'job', job: { ...jobsMock.jobs[1], id: 'j-9' } }));
    sockets[0]?.emit('message', 'not json');
    sockets[0]?.close();
    sockets[1]?.emit('open');
    await tick();
    expect(asked).toHaveLength(2);
    expect(jobs).toEqual(['j-1', 'j-2', 'j-3', 'j-4', 'j-9']);
    expect(waits).toEqual([1000]);
  });

  it('backs off 1, 2, 4, 8 and then 10 seconds, and starts over after a good connect', () => {
    expect([0, 1, 2, 3, 4, 8].map(backoff)).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
    const { link, sockets, waits } = setup((async () => new Response(JSON.stringify({ ok: true, jobs: [] }))) as unknown as typeof fetch);
    link.connect();
    sockets[0]?.emit('error');
    sockets[0]?.emit('close');
    sockets[1]?.close();
    sockets[2]?.emit('open');
    sockets[2]?.close();
    expect(waits).toEqual([1000, 2000, 1000]);
  });

  it('learns the suppliers from the snapshot and posts results with the token', async () => {
    const posts: { url: string; auth: string | null; body: unknown }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      posts.push({ url, auth: new Headers(init?.headers).get('Authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;
    const { link, sockets } = setup(fetcher);
    link.connect();
    sockets[0]?.emit('message', JSON.stringify({ type: 'snapshot', snapshot: snapshotMock }));
    expect((await link.supplier('s-offcut'))?.kind).toBe('account');
    expect(await link.post('/ingest/quotes', { jobId: 'j-1', quotes: [] })).toBe(true);
    expect(posts.at(-1)).toEqual({ url: 'https://hub.test/ingest/quotes', auth: 'Bearer dev-device-token', body: { jobId: 'j-1', quotes: [] } });
  });
});
