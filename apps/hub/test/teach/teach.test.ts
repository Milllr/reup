import { Product, TeachState, type CatalogItem } from '@reup/contracts';
import { describe, expect, it, vi } from 'vitest';
import catalogMock from '../../../../contracts/mocks/catalog.json';
import { buildPrompt, GeminiNamer, parseAnswer, type Namer } from '../../src/teach/gemini';
import { APPROVE, DEVICE, OPS, rig } from '../helpers';

const items = catalogMock.items as CatalogItem[];
const catalogFetch = (async () => new Response(JSON.stringify(catalogMock))) as unknown as typeof fetch;
const namer = (result: Awaited<ReturnType<Namer['name']>> | (() => Promise<never>)): Namer => ({ name: typeof result === 'function' ? result : async () => result });
const body = { jpegBase64: btoa('not really a jpeg'), zoneId: 'z-teach' };

describe('naming a new part', () => {
  it('lists every catalog item with its SKU in the prompt', () => {
    const prompt = buildPrompt(items);
    for (const item of items) expect(prompt).toContain(`${item.sku} | ${item.name}`);
  });

  it('reads an answer wrapped in a code fence and refuses an empty one', () => {
    expect(parseAnswer('```json\n{"sku":"OC-1008-200","name":"x","unit":"box of 100","confidence":"fairly_sure"}\n```')).toMatchObject({ sku: 'OC-1008-200', confidence: 'fairly_sure' });
    expect(parseAnswer('{"sku":null,"name":"Blue tape","unit":"","confidence":"??"}')).toEqual({ sku: null, name: 'Blue tape', unit: 'each', confidence: 'not_sure' });
    expect(() => parseAnswer('no idea')).toThrow();
  });

  it('asks Gemini with the documented shape and falls back to the older one on a 400', async () => {
    const calls: { url: string; body: { generationConfig: Record<string, unknown> }; key: string | null }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('x-goog-api-key') });
      if (calls.length === 1) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"sku":"OC-2202","name":"b","unit":"bag of 4","confidence":"sure"}' }] } }] }));
    }) as unknown as typeof fetch;
    const result = await new GeminiNamer('k', 'gemini-3.8-flash', fake).name('abc', items, new AbortController().signal);
    expect(result.sku).toBe('OC-2202');
    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(calls[0]?.key).toBe('k');
    expect(calls[0]?.body.generationConfig).toHaveProperty('responseFormat');
    expect(calls[1]?.body.generationConfig).toHaveProperty('responseMimeType', 'application/json');
  });

  it('stores the crop, names it from the catalog and waits for a person', async () => {
    const r = await rig({}, { fetch: catalogFetch, namer: namer({ sku: 'OC-1008-200', name: 'whatever', unit: 'x', confidence: 'fairly_sure' }) });
    const res = await r.call('POST', '/api/teach', body, DEVICE);
    const naming = TeachState.parse(await res.json());
    expect(naming).toMatchObject({ status: 'naming', zoneId: 'z-teach' });
    await r.room.idle();
    expect(r.room.s.teach).toMatchObject({ status: 'needs_confirm', suggestion: { name: '#8 x 2 in Wood Screws, Robertson', unit: 'box of 100', sku: 'OC-1008-200', confidence: 'fairly_sure' } });
    expect(r.of('teach').map((m) => m.teach?.status)).toEqual(['naming', 'needs_confirm']);
    const crop = await r.call('GET', naming.cropUrl ?? '');
    expect(crop.headers.get('Content-Type')).toBe('image/jpeg');
    expect(await crop.text()).toBe('not really a jpeg');
  });

  it('treats a SKU that is not in the catalog as no match', async () => {
    const r = await rig({}, { fetch: catalogFetch, namer: namer({ sku: 'OC-0000', name: 'Mystery bolts', unit: 'bag of 10', confidence: 'sure' }) });
    await r.call('POST', '/api/teach', body, DEVICE);
    await r.room.idle();
    expect(r.room.s.teach?.suggestion).toEqual({ name: 'Mystery bolts', unit: 'bag of 10', sku: null, searchPhrase: 'Mystery bolts', confidence: 'not_sure' });
  });

  it('confirm creates the product on the zone with a policy, and clears the teach', async () => {
    const r = await rig({}, { fetch: catalogFetch, namer: namer({ sku: 'OC-1008-200', name: '', unit: '', confidence: 'sure' }) });
    await r.call('POST', '/api/teach', body, DEVICE);
    await r.room.idle();
    const id = r.room.s.teach?.id;
    const confirm = { name: 'Wood screws #8 x 2 in', unit: 'box of 100', sku: 'OC-1008-200', searchPhrase: '#8 x 2 wood screws', zoneId: 'z-teach' };
    expect((await r.call('POST', `/api/teach/${id}/confirm`, confirm, DEVICE)).status).toBe(401);
    const res = await r.call('POST', `/api/teach/${id}/confirm`, confirm, APPROVE);
    const product = Product.parse(await res.json());
    expect(product).toMatchObject({ id: 'p-wood-screws-8-x-2-in', zoneId: 'z-teach', sku: 'OC-1008-200' });
    expect(r.room.zone('z-teach')?.productId).toBe(product.id);
    expect(r.room.policy(product.id)).toMatchObject({ sampleHistory: true, leadDays: 1 });
    // A new part has no use yet: it is counted, never low, and taking it off the spot does not start an order.
    expect(r.room.policy(product.id)).toMatchObject({ ratePerDay: 0, reorderPoint: 0 });
    expect(r.room.count(product.id)?.count).toBe(1);
    expect(r.room.s.teach).toBeNull();
    expect(r.room.s.orders).toHaveLength(0);

    expect(r.room.s.activity.at(-1)?.text).toBe('Wood screws #8 x 2 in added. Counting it now.');
    await r.call('POST', '/ingest/counts', { counts: [{ productId: product.id, zoneId: 'z-teach', count: 0, level: null, pockets: null, source: 'eye', ts: r.room.iso() }] }, DEVICE);
    expect(r.room.count(product.id)?.count).toBe(0);
    expect(r.room.s.orders).toHaveLength(0);
    expect(r.room.s.activity.at(-1)?.text).toBe('1 box of wood screws #8 x 2 in taken. 0 left.');
  });

  it('fails plainly when naming throws or takes over 12 seconds, and a person can still confirm', async () => {
    vi.useFakeTimers();
    try {
      const r = await rig({}, { fetch: catalogFetch, namer: namer(() => new Promise<never>(() => {})) });
      await r.call('POST', '/api/teach', body, DEVICE);
      await vi.advanceTimersByTimeAsync(12_500);
      await r.room.idle();
      expect(r.room.s.teach).toMatchObject({ status: 'failed', error: 'Could not name it. Type a name to add it.' });
      const id = r.room.s.teach?.id;
      const res = await r.call('POST', `/api/teach/${id}/confirm`, { name: 'Blue tape', unit: 'roll', sku: null, searchPhrase: 'blue tape', zoneId: 'z-teach' }, OPS);
      expect(res.status).toBe(200);
      expect(r.room.product('p-blue-tape')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when naming is not set up, and cancel clears it', async () => {
    const r = await rig({}, { fetch: catalogFetch });
    await r.call('POST', '/api/teach', body, DEVICE);
    await r.room.idle();
    expect(r.room.s.teach).toMatchObject({ status: 'failed', error: 'Naming is not set up. Type a name to add it.' });
    const id = r.room.s.teach?.id;
    expect((await r.call('POST', `/api/teach/${id}/cancel`, undefined, APPROVE)).status).toBe(200);
    expect(r.room.s.teach).toBeNull();
    expect((await r.call('POST', `/api/teach/${id}/cancel`, undefined, APPROVE)).status).toBe(404);
  });

  it('a card nobody names comes down by itself, so it never holds the screens', async () => {
    const r = await rig({}, { fetch: catalogFetch });
    const teach = TeachState.parse(await (await r.call('POST', '/api/teach', body, DEVICE)).json());
    await r.room.idle();
    expect(r.room.s.teach).toMatchObject({ status: 'failed', error: 'Naming is not set up. Type a name to add it.' });
    expect(r.room.nextDeadline()).toBe(r.clock.now + 90_001);
    r.advance(89_000);
    expect(r.room.s.teach?.id).toBe(teach.id);
    r.advance(1_500);
    expect(r.room.s.teach).toBeNull();
    expect(r.of('teach').at(-1)).toEqual({ type: 'teach', teach: null });
    expect(r.room.s.activity.at(-1)?.text).toBe('The new part was not named. It was not added.');
    await r.room.idle();
    expect((await r.call('GET', teach.cropUrl ?? '')).status).toBe(404);
    expect(r.room.s.products).toHaveLength(4);
    expect(r.room.nextDeadline()).toBeNull();
  });

  it('a suggestion waits three minutes for a yes, and a yes in time stops the clock', async () => {
    const named = namer({ sku: 'OC-1008-200', name: 'x', unit: 'x', confidence: 'sure' });
    const r = await rig({}, { fetch: catalogFetch, namer: named });
    await r.call('POST', '/api/teach', body, DEVICE);
    await r.room.idle();
    r.advance(179_000);
    expect(r.room.s.teach?.status).toBe('needs_confirm');
    r.advance(1_500);
    expect(r.room.s.teach).toBeNull();
    expect(r.room.s.activity.at(-1)?.text).toBe('Nobody confirmed the new part. It was not added.');
    // The next one is confirmed in time: it is added and nothing comes down later.
    const again = TeachState.parse(await (await r.call('POST', '/api/teach', body, DEVICE)).json());
    await r.room.idle();
    r.advance(60_000);
    expect((await r.call('POST', `/api/teach/${again.id}/confirm`, { name: 'Wood screws 2 in', unit: 'box of 100', sku: 'OC-1008-200', searchPhrase: 'wood screws', zoneId: 'z-teach' }, APPROVE)).status).toBe(200);
    expect(r.room.x.teachUntil).toBeNull();
    r.advance(600_000);
    expect(r.room.s.products.some((p) => p.name === 'Wood screws 2 in')).toBe(true);
  });

  it('the eye may take the card down when the part is lifted off the teach spot', async () => {
    const r = await rig({}, { fetch: catalogFetch });
    const teach = TeachState.parse(await (await r.call('POST', '/api/teach', body, DEVICE)).json());
    await r.room.idle();
    expect((await r.call('POST', `/api/teach/${teach.id}/cancel`, undefined, 'wrong')).status).toBe(401);
    expect((await r.call('POST', `/api/teach/${teach.id}/cancel`, undefined, DEVICE)).status).toBe(200);
    expect(r.room.s.teach).toBeNull();
    expect(r.room.x.teachUntil).toBeNull();
  });
});
