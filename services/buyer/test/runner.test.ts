/// <reference types="node" />
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Run } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import { plainError, schemaProblems, TinyFishAgent, toRequest, type TinyFishClient } from '../src/agent';
import { CART_SCHEMA, cartSpec, planCart } from '../src/cart';
import { startupLines } from '../src/config';
import { MARKET_SCHEMA, marketSpec } from '../src/market';
import { PLACE_SCHEMA, placeSpec, TRACK_SCHEMA } from '../src/place';
import { fileRecordings } from '../src/recordings';
import { REPLAY_MAX_MS, runAgent } from '../src/runner';
import { cartJob, completed, config, deps, fakeAgent, marketJob, offcut, placeJob, retailerA } from './helpers';

const good = { listing_name: 'Wood Screws', pack_size: 1, price: 8.69, currency: 'CAD', in_stock: true, delivery_days: 3, product_url: 'https://a.test/p/1' };

describe('the run mirror', () => {
  it('mirrors a run on start, on the streaming URL, on every step and on completion', async () => {
    const agent = fakeAgent(async (_p, emit) => {
      emit({ type: 'started', runId: 'tf-9' });
      emit({ type: 'streaming_url', url: 'https://tf.example.com/live/9' });
      emit({ type: 'progress', purpose: 'Closing the cookie notice' });
      emit({ type: 'progress', purpose: 'Reading the first 5 listings' });
      return completed(good);
    });
    const { d, mirrored } = deps(agent);
    const out = await runAgent(d, marketSpec(retailerA, marketJob));
    expect(out).toMatchObject({ ok: true, replayed: false, result: good });
    for (const run of mirrored) expect(() => Run.parse(run)).not.toThrow();
    expect(mirrored.map((r) => [r.status, r.tinyfishRunId, r.streamingUrl, r.steps.length])).toEqual([
      ['running', null, null, 0],
      ['running', 'tf-9', null, 0],
      ['running', 'tf-9', 'https://tf.example.com/live/9', 0],
      ['running', 'tf-9', 'https://tf.example.com/live/9', 1],
      ['running', 'tf-9', 'https://tf.example.com/live/9', 2],
      ['completed', 'tf-1', 'https://tf.example.com/live/9', 2],
    ]);
    expect(mirrored.at(-1)).toMatchObject({ kind: 'market', supplierId: 's-market-a', productId: 'p-screws', replay: false, error: null, engine: 'tinyfish' });
    expect(mirrored.at(-1)?.finishedAt).not.toBeNull();
  });

  it('marks a completed run failed when its result is not a real answer', async () => {
    const { d, mirrored } = deps(fakeAgent(() => completed({ ...good, price: null })));
    const out = await runAgent(d, marketSpec(retailerA, marketJob));
    expect(out).toMatchObject({ ok: false, error: 'No price on the page.' });
    expect(mirrored.at(-1)).toMatchObject({ status: 'failed', error: 'No price on the page.' });
  });

  it('saves a good run and replays it in step order, at its pace, marked replay, with no live picture', async () => {
    const agent = fakeAgent(async (_p, emit) => {
      emit({ type: 'streaming_url', url: 'https://tf.example.com/live/1' });
      emit({ type: 'progress', purpose: 'one' });
      emit({ type: 'progress', purpose: 'two' });
      return completed(good);
    });
    const { d, mirrored, slept, recordings, clock } = deps(agent);
    const realMirror = d.mirror;
    d.mirror = async (run) => { clock.now += 1000; await realMirror(run); };
    await runAgent(d, marketSpec(retailerA, marketJob));
    const saved = recordings.all.get('market-s-market-a-p-screws');
    expect(saved?.steps.map((s) => s.purpose)).toEqual(['one', 'two']);
    expect(saved?.result).toEqual(good);

    mirrored.length = 0;
    const replayed = await runAgent(d, marketSpec(retailerA, { ...marketJob, replay: true }));
    expect(agent.calls).toHaveLength(1);
    expect(replayed).toMatchObject({ ok: true, replayed: true, result: good });
    expect(mirrored.every((r) => r.replay && r.streamingUrl === null)).toBe(true);
    expect(mirrored.at(-1)?.steps.map((s) => s.purpose)).toEqual(['one', 'two']);
    expect(mirrored.at(-1)?.status).toBe('completed');
    expect(slept.reduce((a, b) => a + b, 0)).toBe(saved?.durationMs);
  });

  it('never replays a recording made for another part, or for another quantity', async () => {
    const agent = fakeAgent(() => completed(good));
    const { d, recordings } = deps(agent);
    await runAgent(d, marketSpec(retailerA, marketJob));
    expect([...recordings.all.keys()]).toEqual(['market-s-market-a-p-screws']);
    // Replay is asked for glue, and only screws were recorded: it runs live.
    const glue = await runAgent(d, marketSpec(retailerA, { ...marketJob, productId: 'p-glue', replay: true }));
    expect(glue.replayed).toBe(false);
    expect(agent.calls).toHaveLength(2);
    // A live price check for glue fails: there is nothing true to fall back on, so it fails.
    d.agent = fakeAgent(() => ({ runId: 'tf-3', status: 'FAILED', result: null, error: 'The site timed out.' }));
    await recordings.all.delete('market-s-market-a-p-glue');
    const failed = await runAgent(d, marketSpec(retailerA, { ...marketJob, productId: 'p-glue' }));
    expect(failed).toMatchObject({ ok: false, replayed: false, error: 'The site timed out.' });
    // A cart recording is for one part and one quantity.
    const plan = planCart(cartJob, []);
    const signIn = { profile: true, email: '', password: '' };
    d.agent = fakeAgent(() => completed({ cart_ok: true, reason: null, pack_label: null, pack_size: 1, packs: 8, unit_price: 7.49, total: 67.71, delivery_days: 2, delivery_date: null }));
    await runAgent(d, cartSpec(offcut, cartJob, plan, signIn, 'prof'));
    expect([...recordings.all.keys()]).toContain('cart-s-offcut-p-screws-x8');
    d.agent = fakeAgent(() => ({ runId: 'tf-4', status: 'FAILED', result: null, error: 'The run took too long.' }));
    const other = await runAgent(d, cartSpec(offcut, { ...cartJob, units: 2 }, planCart({ ...cartJob, units: 2 }, []), signIn, 'prof'));
    expect(other).toMatchObject({ ok: false, replayed: false });
    const same = await runAgent(d, cartSpec(offcut, cartJob, plan, signIn, 'prof'));
    expect(same).toMatchObject({ ok: true, replayed: true });
  });

  it('squeezes the replay of a long run into 20 seconds, steps in order', async () => {
    const { d, slept, recordings, mirrored } = deps(fakeAgent(() => completed(good)));
    await recordings.save({ kind: 'market', supplierId: 's-market-a', subject: 'p-screws', savedAt: '2026-11-21T21:43:29-05:00', durationMs: 276_000, steps: [{ offsetMs: 69_000, purpose: 'one' }, { offsetMs: 207_000, purpose: 'two' }], result: good });
    const out = await runAgent(d, marketSpec(retailerA, { ...marketJob, replay: true }));
    expect(out.replayed).toBe(true);
    expect(slept).toEqual([5000, 10_000, 5000]);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(REPLAY_MAX_MS);
    expect(mirrored.at(-1)?.steps.map((s) => s.purpose)).toEqual(['one', 'two']);
  });

  it('falls back to a recording when a live run fails and one exists, but never for placing an order', async () => {
    let fail = false;
    const agent = fakeAgent(() => (fail ? { runId: 'tf-2', status: 'FAILED', result: null, error: 'The site timed out.' } : completed(good)));
    const { d, mirrored } = deps(agent);
    await runAgent(d, marketSpec(retailerA, marketJob));
    fail = true;
    mirrored.length = 0;
    const out = await runAgent(d, marketSpec(retailerA, marketJob));
    expect(out).toMatchObject({ ok: true, replayed: true });
    expect(mirrored.filter((r) => r.status === 'failed')).toHaveLength(1);
    expect(mirrored.at(-1)).toMatchObject({ replay: true, status: 'completed' });

    const p = deps(fakeAgent(() => completed({ confirmation: 'OC-58213', delivery_date: 'Tuesday, Nov 24', reason: null })));
    await runAgent(p.d, placeSpec(offcut, placeJob, null, { profile: true, email: '', password: '' }, 'prof'));
    p.d.agent = fakeAgent(() => completed({ confirmation: null, delivery_date: null, reason: null }));
    const failed = await runAgent(p.d, placeSpec(offcut, placeJob, null, { profile: true, email: '', password: '' }, 'prof'));
    expect(failed).toMatchObject({ ok: false, replayed: false, error: 'The store showed no confirmation number.' });
  });

  it('runs live when replay is on but nothing has been recorded yet', async () => {
    const agent = fakeAgent(() => completed(good));
    const out = await runAgent(deps(agent).d, marketSpec(retailerA, { ...marketJob, replay: true }));
    expect(out.replayed).toBe(false);
    expect(agent.calls).toHaveLength(1);
  });

  it('round trips a recording through a file', async () => {
    const store = fileRecordings(mkdtempSync(join(tmpdir(), 'reup-rec-')));
    const rec = { kind: 'cart', supplierId: 's-offcut', subject: 'p-screws-x8', savedAt: '2026-11-21T09:14:00-05:00', durationMs: 4200, steps: [{ offsetMs: 100, purpose: 'a' }, { offsetMs: 900, purpose: 'b' }], result: { total: 67.71 } };
    await store.save(rec);
    expect(await store.load('cart', 's-offcut', 'p-screws-x8')).toEqual(rec);
    expect(await store.load('cart', 's-offcut', 'p-screws-x2')).toBeNull();
    expect(await store.load('place', 's-offcut', 'any')).toBeNull();
  });
});

describe('the TinyFish agent', () => {
  const params = marketSpec(retailerA, marketJob).params;
  async function* events(list: Record<string, unknown>[], thenThrow = false) {
    for (const e of list) yield e;
    if (thenThrow) throw new Error('socket hang up');
  }

  it('builds the request the API expects', () => {
    expect(toRequest(params)).toEqual({ url: 'https://a.test/search?q=%238%20x%201-1%2F4%20wood%20screws%20box%20of%20100', goal: params.goal, output_schema: params.outputSchema, browser_profile: 'stealth', proxy_config: { enabled: true, country_code: 'CA' }, agent_config: { max_duration_seconds: 180 } });
    expect(toRequest({ ...params, proxyCountry: null, profileId: 'prof-1' })).toMatchObject({ use_profile: true, profile_id: 'prof-1' });
    expect(toRequest({ ...params, proxyCountry: null })).not.toHaveProperty('proxy_config');
  });

  it('maps each event and returns the result from COMPLETE', async () => {
    const client: TinyFishClient = {
      agent: { stream: async () => events([{ type: 'STARTED', run_id: 'tf-1' }, { type: 'STREAMING_URL', run_id: 'tf-1', streaming_url: 'https://tf/live' }, { type: 'HEARTBEAT' }, { type: 'PROGRESS', run_id: 'tf-1', purpose: 'Reading' }, { type: 'COMPLETE', run_id: 'tf-1', status: 'COMPLETED', result: good, error: null }]) },
      runs: { get: async () => { throw new Error('should not poll'); } },
    };
    const seen: unknown[] = [];
    const out = await new TinyFishAgent(client).run(params, (e) => seen.push(e));
    expect(seen).toEqual([{ type: 'started', runId: 'tf-1' }, { type: 'streaming_url', url: 'https://tf/live' }, { type: 'progress', purpose: 'Reading' }]);
    expect(out).toEqual({ runId: 'tf-1', status: 'COMPLETED', result: good, error: null });
  });

  it('polls the run by id when the stream ends early, until it is final', async () => {
    let polls = 0;
    const client: TinyFishClient = {
      agent: { stream: async () => events([{ type: 'STARTED', run_id: 'tf-7' }, { type: 'PROGRESS', run_id: 'tf-7', purpose: 'Reading' }], true) },
      runs: { get: async (id) => { polls += 1; return polls < 3 ? { status: 'RUNNING', result: null, error: null } : { status: 'COMPLETED', result: { ...good, id }, error: null }; } },
    };
    const out = await new TinyFishAgent(client, async () => {}, 10).run(params, () => {});
    expect(polls).toBe(3);
    expect(out).toMatchObject({ runId: 'tf-7', status: 'COMPLETED', result: { id: 'tf-7' } });
  });

  it('sends only schema keywords TinyFish accepts, so a run is never refused before it starts', () => {
    for (const schema of [MARKET_SCHEMA, CART_SCHEMA, PLACE_SCHEMA, TRACK_SCHEMA]) expect(schemaProblems(schema)).toEqual([]);
    expect(schemaProblems({ type: 'object', additionalProperties: false, properties: { a: { type: ['string', 'null'] }, b: { type: 'string', description: 'x' }, c: { type: 'array', items: { type: 'string', example: 'y' } } } })).toEqual(['#/additionalProperties', '#/properties/a/type must be one string', '#/properties/b/description', '#/properties/c/items/example']);
  });

  it('turns run failures into plain words', async () => {
    expect(plainError({ code: 'SITE_BLOCKED', message: 'x', category: 'AGENT_FAILURE' })).toBe('The site blocked the browser.');
    expect(plainError({ message: 'Insufficient credits', category: 'BILLING_FAILURE' })).toBe('TinyFish refused the run: the account is out of credits.');
    expect(plainError({ message: 'Element not found' })).toBe('Element not found');
    const client: TinyFishClient = { agent: { stream: async () => events([{ type: 'STARTED', run_id: 'tf-3' }, { type: 'COMPLETE', run_id: 'tf-3', status: 'FAILED', result: null, error: { code: 'TIMEOUT', message: 'Run exceeded max duration', category: 'AGENT_FAILURE' } }]) }, runs: { get: async () => ({ status: 'FAILED', result: null, error: null }) } };
    expect(await new TinyFishAgent(client).run(params, () => {})).toEqual({ runId: 'tf-3', status: 'FAILED', result: null, error: 'The run took too long.' });
  });

  it('fails plainly when the run never starts', async () => {
    const client: TinyFishClient = { agent: { stream: async () => { throw new Error('401'); } }, runs: { get: async () => ({ status: 'FAILED', result: null, error: null }) } };
    expect(await new TinyFishAgent(client).run(params, () => {})).toMatchObject({ status: 'FAILED', error: 'TinyFish could not start the run: 401' });
  });
});

describe('startup', () => {
  it('says whether the secrets are set and never prints them', () => {
    const lines = startupLines(config({ TINYFISH_API_KEY: 'sk-secret-123', TINYFISH_PROFILE_ID: '', OFFCUT_PASSWORD: 'hunter2' })).join('\n');
    expect(lines).toContain('TINYFISH_API_KEY: set');
    expect(lines).toContain('TINYFISH_PROFILE_ID: not set');
    expect(lines).not.toContain('sk-secret-123');
    expect(lines).not.toContain('hunter2');
    expect(startupLines(config({ BUYER_ENGINE: 'local' })).join('\n')).toContain('local stand in');
  });
});
