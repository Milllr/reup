import { Product, TeachState, type CatalogItem } from '@reup/contracts';
import { describe, expect, it, vi } from 'vitest';
import catalogMock from '../../../../contracts/mocks/catalog.json';
import { buildPrompt, GeminiNamer, parseAnswer, type Namer } from '../../src/teach/gemini';
import { boxName, inQuad } from '../../src/teach';
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

  describe('several models, asked in turn', () => {
    const good = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"sku":"OC-2202","name":"b","unit":"bag of 4","confidence":"sure"}' }] } }] }));
    const modelOf = (url: string) => /models\/([^:]+):/.exec(url)?.[1] ?? '';

    it('calls fetch the way a Worker allows: as a plain function, with no object as its this', async () => {
      // The Workers runtime throws "Illegal invocation" when its fetch is called as a method of something else.
      const strict = function (this: unknown) {
        if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
        return Promise.resolve(good());
      } as unknown as typeof fetch;
      expect((await new GeminiNamer('k', 'steady-flash', strict, 7000, () => {}).name('abc', items, new AbortController().signal)).sku).toBe('OC-2202');
    });

    it('skips a model that is overloaded and takes the next one', async () => {
      const asked: string[] = [];
      const logs: string[] = [];
      const fake = (async (url: string) => {
        asked.push(modelOf(url));
        return asked.length === 1 ? new Response('{"error":{"status":"UNAVAILABLE"}}', { status: 503 }) : good();
      }) as unknown as typeof fetch;
      const result = await new GeminiNamer('k', 'new-flash, steady-flash ,spare', fake, 7000, (l) => logs.push(l)).name('abc', items, new AbortController().signal);
      expect(result.sku).toBe('OC-2202');
      expect(asked).toEqual(['new-flash', 'steady-flash']);
      expect(logs).toEqual(['naming with new-flash failed: Gemini answered 503.']);
    });

    it('asks the next model too when the first has not answered in 2.5 seconds, takes the first answer and drops the rest', async () => {
      vi.useFakeTimers();
      try {
        const asked: string[] = [];
        const dropped: string[] = [];
        const logs: string[] = [];
        const fake = ((url: string, init: RequestInit) => {
          const model = modelOf(url);
          asked.push(model);
          if (model === 'fast') return Promise.resolve(good());
          // Never answers. It ends only when its own request is aborted.
          return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => {
            dropped.push(model);
            reject(new Error('aborted'));
          }));
        }) as unknown as typeof fetch;
        const naming = new GeminiNamer('k', 'slow,fast,spare', fake, 7000, (l) => logs.push(l), 2500).name('abc', items, new AbortController().signal);
        await vi.advanceTimersByTimeAsync(2400);
        expect(asked).toEqual(['slow']);
        await vi.advanceTimersByTimeAsync(200);
        expect((await naming).sku).toBe('OC-2202');
        expect(asked).toEqual(['slow', 'fast']);
        expect(dropped).toEqual(['slow']);
        // The slow one was dropped because another answered, not because it failed: nothing to log, and the spare is never asked.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(logs).toEqual([]);
        expect(asked).toEqual(['slow', 'fast']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives each model 7 seconds, and says so when that was the reason', async () => {
      vi.useFakeTimers();
      try {
        const asked: string[] = [];
        const logs: string[] = [];
        const fake = ((url: string, init: RequestInit) => {
          asked.push(modelOf(url));
          return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        }) as unknown as typeof fetch;
        const naming = new GeminiNamer('k', 'a,b', fake, 7000, (l) => logs.push(l), 2500).name('abc', items, new AbortController().signal);
        const failed = expect(naming).rejects.toThrow('b took longer than 7 seconds.');
        await vi.advanceTimersByTimeAsync(9600);
        await failed;
        expect(asked).toEqual(['a', 'b']);
        expect(logs).toEqual(['naming with a failed: a took longer than 7 seconds.', 'naming with b failed: b took longer than 7 seconds.']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('says what the last model said when none can name it, and stops at once when the caller gives up', async () => {
      const asked: string[] = [];
      const fake = (async (url: string) => {
        asked.push(modelOf(url));
        return new Response('{}', { status: asked.length === 1 ? 503 : 429 });
      }) as unknown as typeof fetch;
      await expect(new GeminiNamer('k', 'a,b', fake, 7000, () => {}).name('abc', items, new AbortController().signal)).rejects.toThrow('Gemini answered 429.');
      expect(asked).toEqual(['a', 'b']);
      const gone = new AbortController();
      gone.abort();
      await expect(new GeminiNamer('k', 'a,b', fake, 7000, () => {}).name('abc', items, gone.signal)).rejects.toThrow('Naming was stopped.');
      expect(asked).toEqual(['a', 'b']);
      // Stopped while a model is still thinking: its request is dropped and nothing more is asked.
      const hanging: string[] = [];
      const hang = ((url: string, init: RequestInit) => {
        hanging.push(modelOf(url));
        return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }) as unknown as typeof fetch;
      const stop = new AbortController();
      const naming = new GeminiNamer('k', 'a,b', hang, 7000, () => {}).name('abc', items, stop.signal);
      stop.abort();
      await expect(naming).rejects.toThrow('Naming was stopped.');
      expect(hanging).toEqual(['a']);
      await expect(new GeminiNamer('k', ' , ', fake, 7000, () => {}).name('abc', items, new AbortController().signal)).rejects.toThrow('No Gemini model is set.');
    });
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

  it('an empty teach spot is never offered as a part: the card comes down by itself and nothing is said', async () => {
    const r = await rig({}, { fetch: catalogFetch, namer: namer({ sku: null, name: '', unit: 'each', confidence: 'not_sure', empty: true }) });
    const lines = r.room.s.activity.length;
    const res = await r.call('POST', '/api/teach', body, DEVICE);
    const naming = TeachState.parse(await res.json());
    await r.room.idle();
    expect(r.room.s.teach).toBeNull();
    expect(r.room.x.teachUntil).toBeNull();
    expect(r.of('teach').map((m) => m.teach?.status ?? null)).toEqual(['naming', null]);
    expect(r.room.s.activity).toHaveLength(lines);
    expect(r.room.s.activity.some((a) => /teach spot|new part/i.test(a.text))).toBe(false);
    expect(r.room.s.products.some((p) => /empty|shelf/i.test(p.name))).toBe(false);
    expect((await r.call('GET', naming.cropUrl ?? '')).status).toBe(404);
    // The spot takes a real part afterwards as usual.
    const next = await rig({}, { fetch: catalogFetch, namer: namer({ sku: 'OC-1008-200', name: '', unit: '', confidence: 'sure' }) });
    await next.call('POST', '/api/teach', body, DEVICE);
    await next.room.idle();
    expect(next.room.s.teach?.status).toBe('needs_confirm');
  });

  it('reads the bare spot from the model\'s flag, and from a name that only describes the shelf', () => {
    expect(parseAnswer('{"sku":null,"name":"","unit":"","confidence":"not_sure","empty":true}')).toMatchObject({ empty: true, sku: null, name: '' });
    expect(parseAnswer('{"sku":null,"name":"Empty wooden cabinet or shelf","unit":"each","confidence":"not_sure"}')).toMatchObject({ empty: true });
    expect(parseAnswer('{"sku":null,"name":"Nothing on the ledge","unit":"each","confidence":"not_sure"}')).toMatchObject({ empty: true });
    expect(parseAnswer('{"sku":null,"name":"No item","unit":"each","confidence":"not_sure"}')).toMatchObject({ empty: true });
    // A real part is not taken for nothing: a store item always stands, and so does a name that only has such a word inside it.
    expect(parseAnswer('{"sku":"OC-1008-200","name":"Empty","unit":"box","confidence":"sure"}').empty).toBeUndefined();
    expect(parseAnswer('{"sku":null,"name":"Bare wooden ledge","unit":"each","confidence":"not_sure"}')).toMatchObject({ empty: true });
    expect(parseAnswer('{"sku":null,"name":"Blank keys, brass","unit":"each","confidence":"fairly_sure"}').empty).toBeUndefined();
    expect(parseAnswer('{"sku":null,"name":"Empty spray bottles 16 oz","unit":"each","confidence":"fairly_sure"}').empty).toBeUndefined();
    expect(parseAnswer('{"sku":null,"name":"Bare copper wire","unit":"roll","confidence":"fairly_sure"}').empty).toBeUndefined();
    expect(parseAnswer('{"sku":null,"name":"Wood screws, none plated","unit":"box","confidence":"fairly_sure"}').empty).toBeUndefined();
    expect(buildPrompt(items)).toContain('"empty": true');
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

  it('a box drawn for the part becomes its own zone, and the teach spot stays free for the next part', async () => {
    const r = await rig({}, { fetch: catalogFetch, namer: namer({ sku: null, name: '#8 x 2 in Wood Screws, Robertson', unit: 'box of 100', confidence: 'fairly_sure' }) });
    await r.call('POST', '/api/teach', body, DEVICE);
    await r.room.idle();
    const id = r.room.s.teach?.id;
    const zonesBefore = r.room.s.zones.length;
    // The box is drawn away from the teach spot (0.2 to 0.8 across on the seed board), so nothing is in it yet.
    const quad = [[0.02, 0.1], [0.12, 0.1], [0.12, 0.3], [0.02, 0.3]];
    const res = await r.call('POST', `/api/teach/${id}/confirm`, { name: '#8 x 2 in Wood Screws, Robertson', unit: 'box of 100', sku: null, searchPhrase: '#8 x 2 wood screws', zoneId: 'z-teach', quad }, APPROVE);
    const product = Product.parse(await res.json());
    expect(product.zoneId).toBe('z-8-x-2-in-wood-screws-robertson');
    const zone = r.room.zone(product.zoneId);
    expect(zone).toMatchObject({ name: 'Wood Screws', kind: 'open', camera: r.room.zone('z-teach')?.camera, quad, rows: null, cols: null, productId: product.id });
    expect(r.room.s.zones).toHaveLength(zonesBefore + 1);
    expect(r.room.zone('z-teach')?.productId).toBeNull();
    expect(r.room.count(product.id)).toMatchObject({ count: 0, zoneId: zone?.id });
    expect(r.of('zones').at(-1)?.zones.some((z) => z.id === zone?.id)).toBe(true);
    expect(r.room.s.orders).toHaveLength(0);
    // The eye counts the new box like any ledge, and the first unit set down in it is not a reorder.
    await r.call('POST', '/ingest/counts', { counts: [{ productId: product.id, zoneId: product.zoneId, count: 1, level: null, pockets: null, source: 'eye', ts: r.room.iso() }] }, DEVICE);
    expect(r.room.count(product.id)?.count).toBe(1);
    expect(r.room.s.activity.at(-1)?.text).toBe('1 box of wood screws added. 1 on the board.');
    expect(r.room.s.orders).toHaveLength(0);

    // The teach spot takes the next part, and a second box for a part of the same name gets its own id.
    await r.call('POST', '/api/teach', body, DEVICE);
    await r.room.idle();
    const again = Product.parse(await (await r.call('POST', `/api/teach/${r.room.s.teach?.id}/confirm`, { name: '#8 x 2 in Wood Screws, Robertson', unit: 'box of 100', sku: null, searchPhrase: '#8 x 2 wood screws', zoneId: 'z-teach', quad: [[0.2, 0.15], [0.8, 0.15], [0.8, 0.85], [0.2, 0.85]] }, APPROVE)).json());
    expect(again.zoneId).not.toBe(product.zoneId);
    expect(again.zoneId).toMatch(/^z-8-x-2-in-wood-screws-robertson-/);
    // This box holds the place the part was seen in, so one unit is counted from the start.
    expect(r.room.count(again.id)?.count).toBe(1);

    // Removing the part takes its own box off the board. Nothing says it was removed and nothing still names it.
    expect((await r.call('POST', `/api/products/${product.id}/remove`, undefined, APPROVE)).status).toBe(200);
    expect(r.room.zone(product.zoneId)).toBeUndefined();
    expect(r.room.s.products.some((p) => p.id === product.id)).toBe(false);
    expect(r.room.s.activity.some((a) => /removed/i.test(a.text))).toBe(false);
    // A reset between judges takes the other taught part and its box too. The station's own zones stay.
    await r.call('POST', '/api/demo/reset', undefined, OPS);
    expect(r.room.s.zones).toHaveLength(zonesBefore);
    expect(r.room.s.products.some((p) => p.id === again.id)).toBe(false);
    expect(r.room.x.madeZones).toEqual([]);
  });

  it('a box with no zone to stand on still works, and a confirm with neither is refused', async () => {
    const r = await rig({}, { fetch: catalogFetch });
    await r.call('POST', '/api/teach', { ...body, zoneId: null }, DEVICE);
    await r.room.idle();
    const id = r.room.s.teach?.id;
    const named = { name: 'Blue tape 1 in', unit: 'roll', sku: null, searchPhrase: 'blue tape' };
    expect((await r.call('POST', `/api/teach/${id}/confirm`, { ...named, zoneId: 'z-nowhere' }, APPROVE)).status).toBe(404);
    const res = await r.call('POST', `/api/teach/${id}/confirm`, { ...named, zoneId: 'z-nowhere', quad: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]] }, APPROVE);
    const product = Product.parse(await res.json());
    expect(r.room.zone(product.zoneId)).toMatchObject({ name: 'Blue tape', camera: 'board', productId: product.id });
    expect(r.room.count(product.id)?.count).toBe(0);
  });

  it('names a box in a few words and knows what is inside a box', () => {
    expect(boxName('#8 x 2 in Wood Screws, Robertson')).toBe('Wood Screws');
    expect(boxName('Flat washers 3/4 in')).toBe('Flat washers');
    expect(boxName('MWAX synthetic lubricant')).toBe('MWAX synthetic lubricant');
    expect(boxName('9V')).toBe('9V');
    const box = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]] as [number, number][];
    expect(inQuad(box, 0.4, 0.4)).toBe(true);
    expect(inQuad(box, 0.7, 0.4)).toBe(false);
    expect(inQuad([...box].reverse(), 0.4, 0.4)).toBe(true);
  });

  it('fails plainly when naming throws or takes over 18 seconds, and a person can still confirm', async () => {
    vi.useFakeTimers();
    try {
      const r = await rig({}, { fetch: catalogFetch, namer: namer(() => new Promise<never>(() => {})) });
      await r.call('POST', '/api/teach', body, DEVICE);
      await vi.advanceTimersByTimeAsync(17_000);
      expect(r.room.s.teach?.status).toBe('naming');
      await vi.advanceTimersByTimeAsync(1500);
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
    expect(r.room.s.activity.at(-1)?.text).toBe('A new part is on the teach spot. Naming it.');
    expect((await r.call('POST', `/api/teach/${id}/cancel`, undefined, APPROVE)).status).toBe(200);
    expect(r.room.s.teach).toBeNull();
    // The newest line is no longer "Naming it.": the Shelf shows the newest line for as long as nothing else happens.
    expect(r.room.s.activity.at(-1)).toMatchObject({ tone: 'info', text: 'The new part was not added.' });
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
