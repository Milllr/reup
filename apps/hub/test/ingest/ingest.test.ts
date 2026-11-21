import { IngestNodeResult, IngestPicksResult } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import { count, DEVICE, nodeOnline, rig } from '../helpers';

const post = (r: Awaited<ReturnType<typeof rig>>, path: string, body: unknown) => r.call('POST', path, body, DEVICE);

describe('the count of record', () => {
  it('uses the eye for a pocket zone while the node is offline or below level 2', async () => {
    const r = await rig();
    await post(r, '/ingest/counts', { counts: [count(r, 'z-screws', 5, 'node')] });
    expect(r.room.count('p-screws')?.count).toBe(6);
    await post(r, '/ingest/counts', { counts: [count(r, 'z-screws', 5, 'eye')] });
    expect(r.room.count('p-screws')).toMatchObject({ count: 5, source: 'eye' });
    nodeOnline(r, 1);
    await post(r, '/ingest/counts', { counts: [count(r, 'z-screws', 3, 'node')] });
    expect(r.room.count('p-screws')?.count).toBe(5);
  });

  it('uses the node for a pocket zone when it is online at level 2', async () => {
    const r = await rig();
    nodeOnline(r, 2);
    await post(r, '/ingest/counts', { counts: [count(r, 'z-screws', 5, 'node')] });
    expect(r.room.count('p-screws')).toMatchObject({ count: 5, source: 'node' });
    await post(r, '/ingest/counts', { counts: [count(r, 'z-screws', 6, 'eye')] });
    expect(r.room.count('p-screws')?.count).toBe(5);
  });

  it('always uses the eye for an open zone', async () => {
    const r = await rig();
    nodeOnline(r, 4);
    await post(r, '/ingest/counts', { counts: [count(r, 'z-glue', 1, 'node')] });
    expect(r.room.count('p-glue')?.count).toBe(3);
    await post(r, '/ingest/counts', { counts: [count(r, 'z-glue', 2, 'eye')] });
    expect(r.room.count('p-glue')?.count).toBe(2);
  });
});

describe('picks', () => {
  it('a change in the count makes one pick, a policy and a sentence; the same count again makes none', async () => {
    const r = await rig();
    await post(r, '/ingest/counts', { counts: [count(r, 'z-screws', 5)] });
    await post(r, '/ingest/counts', { counts: [count(r, 'z-screws', 5)] });
    const picks = r.of('pick');
    expect(picks).toHaveLength(1);
    expect(picks[0]?.pick).toMatchObject({ productId: 'p-screws', delta: -1, countAfter: 5, source: 'eye' });
    expect(r.of('count')).toHaveLength(1);
    expect(r.of('policy').length).toBeGreaterThanOrEqual(1);
    expect(r.room.s.activity.at(-1)?.text).toBe('1 box of wood screws taken. 5 left.');
  });

  it('skips pick ids it has already seen', async () => {
    const r = await rig();
    nodeOnline(r);
    const pick = { id: 'n-1', productId: 'p-screws', zoneId: 'z-screws', delta: -1, countAfter: 5, source: 'node', handSeen: true, ts: r.room.iso() };
    const first = IngestPicksResult.parse(await (await post(r, '/ingest/picks', { picks: [pick] })).json());
    const second = IngestPicksResult.parse(await (await post(r, '/ingest/picks', { picks: [pick, { ...pick, id: 'n-2', countAfter: 4 }] })).json());
    expect(first).toEqual({ ok: true, accepted: 1, duplicates: 0 });
    expect(second).toEqual({ ok: true, accepted: 1, duplicates: 1 });
    expect(r.room.count('p-screws')?.count).toBe(4);
    expect(r.room.x.usage['p-screws']?.[r.room.today()]?.used).toBe(2);
  });

  it('counts one take once when the count and the pick for it both arrive', async () => {
    const r = await rig();
    nodeOnline(r);
    await post(r, '/ingest/counts', { counts: [count(r, 'z-screws', 4, 'node')] });
    await post(r, '/ingest/picks', { picks: [{ id: 'n-9', productId: 'p-screws', zoneId: 'z-screws', delta: -2, countAfter: 4, source: 'node', handSeen: true, ts: r.room.iso() }] });
    expect(r.of('pick')).toHaveLength(1);
    expect(r.room.x.usage['p-screws']?.[r.room.today()]?.used).toBe(2);
  });

  it('marks picks within 2 seconds of a reach as handSeen, before or after', async () => {
    const r = await rig();
    await post(r, '/ingest/reaches', { reaches: [{ id: 'rc-1', zoneId: 'z-screws', state: 'start', ts: r.room.iso() }] });
    r.clock.now += 1200;
    await post(r, '/ingest/counts', { counts: [count(r, 'z-screws', 5)] });
    expect(r.of('pick').at(-1)?.pick.handSeen).toBe(true);

    r.clock.now += 60_000;
    await post(r, '/ingest/counts', { counts: [count(r, 'z-brackets', 4)] });
    expect(r.of('pick').at(-1)?.pick.handSeen).toBe(false);
    r.clock.now += 900;
    await post(r, '/ingest/reaches', { reaches: [{ id: 'rc-2', zoneId: 'z-brackets', state: 'end', ts: r.room.iso() }] });
    expect(r.of('pick').at(-1)?.pick).toMatchObject({ zoneId: 'z-brackets', handSeen: true });
    expect(r.of('reach')).toHaveLength(2);
    await post(r, '/ingest/reaches', { reaches: [{ id: 'rc-2', zoneId: 'z-brackets', state: 'end', ts: r.room.iso() }] });
    expect(r.of('reach')).toHaveLength(2);
  });
});

describe('the node', () => {
  const status = { online: true, level: 2, lastSeen: null, queued: 0, visionRestarts: 0, offlineSince: null };

  it('gets zones, reorder points and orders waiting for the button with each heartbeat', async () => {
    const r = await rig();
    const res = IngestNodeResult.parse(await (await post(r, '/ingest/node', { status })).json());
    expect(res.zones).toHaveLength(5);
    expect(res.reorderPoints).toContainEqual({ productId: 'p-screws', zoneId: 'z-screws', reorderPoint: 4 });
    expect(res.awaitingApproval).toEqual([]);
    expect(r.room.s.node).toMatchObject({ online: true, level: 2 });
  });

  it('is marked offline after 15 seconds without a heartbeat', async () => {
    const r = await rig();
    await post(r, '/ingest/node', { status });
    expect(r.room.nextDeadline()).toBe(r.clock.now + 15_001);
    r.advance(14_000);
    expect(r.room.s.node.online).toBe(true);
    r.advance(1_500);
    expect(r.room.s.node.online).toBe(false);
    expect(r.of('node').at(-1)?.node.online).toBe(false);
  });

  it('raises a disagreement once when the eye and the node differ for more than 3 seconds', async () => {
    const r = await rig();
    nodeOnline(r);
    await post(r, '/ingest/counts', { counts: [count(r, 'z-brackets', 5, 'node'), count(r, 'z-brackets', 4, 'eye')] });
    r.advance(2000);
    const said = () => r.room.s.activity.filter((a) => a.tone === 'attention' && a.text.includes('disagree'));
    expect(said()).toHaveLength(0);
    r.advance(1500);
    r.advance(1000);
    r.advance(5000);
    expect(said()).toHaveLength(1);
    expect(said()[0]?.text).toBe('The eye and the shelf node disagree on Corner brackets: 4 and 5.');
    await post(r, '/ingest/counts', { counts: [count(r, 'z-brackets', 5, 'eye')] });
    expect(r.room.x.disagree['z-brackets']).toBeUndefined();
  });
});
