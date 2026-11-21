/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1History, type Db } from '../../src/history';
import { count, DEVICE, rig, toAwaiting } from '../helpers';

/** D1 speaks SQLite, so the real migration and the real statements run here against node:sqlite. */
function sqlite(): { db: Db; raw: DatabaseSync; done: () => Promise<void> } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const writes: Promise<unknown>[] = [];
  const db: Db = { prepare: (sql) => ({ bind: (...values) => ({ run: async () => raw.prepare(sql).run(...(values as never[])) }) }) };
  return { db, raw, done: async () => void (await Promise.all(writes.splice(0))) };
}

describe('the D1 log', () => {
  it('writes counts, picks, order changes, runs and quotes', async () => {
    const { db, raw } = sqlite();
    const pending: Promise<unknown>[] = [];
    const r = await rig({}, { history: new D1History(db, (p) => pending.push(p)) });
    const id = await toAwaiting(r);
    const run = { id: 'r-1', tinyfishRunId: null, kind: 'cart', supplierId: 's-offcut', productId: 'p-screws', orderId: id, status: 'running', streamingUrl: null, steps: [], replay: false, error: null, startedAt: r.room.iso(), finishedAt: null };
    await r.call('POST', '/ingest/runs', { run }, DEVICE);
    await r.call('POST', '/ingest/runs', { run: { ...run, status: 'completed', finishedAt: r.room.iso() } }, DEVICE);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-glue', 2)] }, DEVICE);
    await Promise.all(pending);
    const n = (table: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(n('counts')).toBe(2);
    expect(n('picks')).toBe(2);
    expect(n('runs')).toBe(1);
    expect(n('quotes')).toBe(1);
    expect((raw.prepare('SELECT state FROM order_events ORDER BY id').all() as { state: string }[]).map((row) => row.state)).toEqual(['pricing', 'awaiting_approval']);
    expect((raw.prepare('SELECT status FROM runs').get() as { status: string }).status).toBe('completed');
    expect(raw.prepare('SELECT delta, count_after, hand_seen FROM picks ORDER BY ts LIMIT 1').get()).toEqual({ delta: -2, count_after: 4, hand_seen: 0 });
  });

  it('never fails a request when the log is down', async () => {
    const broken: Db = { prepare: () => ({ bind: () => ({ run: async () => Promise.reject(new Error('D1 is down')) }) }) };
    const r = await rig({}, { history: new D1History(broken) });
    const res = await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 5)] }, DEVICE);
    expect(res.status).toBe(200);
    expect(r.room.count('p-screws')?.count).toBe(5);
  });
});
