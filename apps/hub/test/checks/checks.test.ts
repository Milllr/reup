import { ApiError, CountCheck, ServerMessage } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import { APPROVE, count, DEVICE, OPS, rig, type Rig } from '../helpers';

async function bigDrop(r: Rig): Promise<string> {
  await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 12)] }, DEVICE);
  await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 3)] }, DEVICE);
  const check = r.room.s.checks?.[0];
  if (!check) throw new Error('no check raised');
  return check.id;
}

describe('count checks', () => {
  it('holds the order when a camera count drops far more than normal use', async () => {
    const r = await rig();
    await bigDrop(r);
    expect(r.room.s.orders).toHaveLength(0);
    expect(r.jobs()).toHaveLength(0);
    const check = CountCheck.parse(r.room.s.checks?.[0]);
    expect(check).toMatchObject({ productId: 'p-screws', zoneId: 'z-screws', before: 12, after: 3 });
    expect(check.text).toBe('9 boxes of wood screws gone at once. Usually about 0.6 a day. Holding the order until someone looks.');
    expect(r.room.s.activity.at(-1)).toMatchObject({ tone: 'attention', text: check.text });
    const msgs = r.of('checks');
    expect(ServerMessage.parse(msgs.at(-1)).type).toBe('checks');
    expect(r.room.s.screen).toBe('shelf');
  });

  it('shops at once for the normal demo take of two boxes', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    expect(r.room.s.checks ?? []).toHaveLength(0);
    expect(r.room.s.orders).toHaveLength(1);
  });

  it('never holds a manual count', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 12)] }, DEVICE);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 2, 'manual')] }, DEVICE);
    expect(r.room.s.checks ?? []).toHaveLength(0);
    expect(r.room.s.orders).toHaveLength(1);
  });

  it('opens the order when a person says the drop is right', async () => {
    const r = await rig();
    const id = await bigDrop(r);
    const res = await r.call('POST', `/api/checks/${id}`, { answer: 'right' }, APPROVE);
    expect(res.status).toBe(200);
    expect(r.room.s.checks).toEqual([]);
    expect(r.room.s.orders).toHaveLength(1);
    expect(r.room.s.orders[0]).toMatchObject({ state: 'pricing', trigger: 'hub' });
    expect(r.jobs().map((j) => j.kind)).toEqual(['market', 'cart']);
    expect(r.room.s.activity.map((a) => a.text)).toContain('Checked. The count of wood screws is right.');
  });

  it('buys nothing for a miscount', async () => {
    const r = await rig();
    const id = await bigDrop(r);
    await r.call('POST', `/api/checks/${id}`, { answer: 'miscount' }, OPS);
    expect(r.room.s.checks).toEqual([]);
    expect(r.room.s.orders).toHaveLength(0);
    expect(r.room.s.activity.at(-1)?.text).toBe('Marked as a miscount of wood screws. Nothing was bought.');
  });

  it('keeps holding while the check is open, even for a small take', async () => {
    const r = await rig();
    await bigDrop(r);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 2)] }, DEVICE);
    expect(r.room.s.orders).toHaveLength(0);
    expect(r.room.s.checks).toHaveLength(1);
  });

  it('clears itself when the count comes back above the reorder point', async () => {
    const r = await rig();
    await bigDrop(r);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 12)] }, DEVICE);
    expect(r.room.s.checks).toEqual([]);
    expect(r.room.s.orders).toHaveLength(0);
    expect(r.room.s.activity.at(-1)?.text).toBe('The count of wood screws came back. Nothing was bought.');
  });

  it('holds a reorder call from the node while a check is open', async () => {
    const r = await rig();
    await bigDrop(r);
    await r.call('POST', '/ingest/reorder', { id: 'rc-1', productId: 'p-screws', countAfter: 3, ts: r.room.iso() }, DEVICE);
    expect(r.room.s.orders).toHaveLength(0);
  });

  it('needs the approve key or the ops token, and a check that exists', async () => {
    const r = await rig();
    const id = await bigDrop(r);
    expect((await r.call('POST', `/api/checks/${id}`, { answer: 'right' }, DEVICE)).status).toBe(401);
    expect((await r.call('POST', `/api/checks/${id}`, { answer: 'maybe' }, OPS)).status).toBe(400);
    const missing = await r.call('POST', '/api/checks/ck-0', { answer: 'right' }, OPS);
    expect(missing.status).toBe(404);
    expect(ApiError.parse(await missing.json()).code).toBe('not_found');
  });

  it('reset clears every check', async () => {
    const r = await rig();
    await bigDrop(r);
    await r.call('POST', '/api/demo/reset', undefined, OPS);
    expect(r.room.s.checks).toEqual([]);
  });
});
