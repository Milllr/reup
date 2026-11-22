import { AskResult, Order, type CountCheck } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import orderMock from '../../../../contracts/mocks/order-placed.json';
import { ask, ASK_PER_MINUTE, ASK_TIMEOUT_MS, fallbackAnswer, tidy } from '../../src/ask';
import { factSheet, rankingLine, type ProductFacts } from '../../src/ask/facts';
import { buildAskPrompt, GeminiAsker, parseAskAnswer, type Asker } from '../../src/ask/gemini';
import { daysBefore } from '../../src/core/time';
import { rig, type Rig } from '../helpers';

const QUESTION = 'What did we use most this week?';
const CHECK: CountCheck = {
  id: 'c-1', productId: 'p-screws', zoneId: 'z-screws', before: 11, after: 2, usualPerDay: 0.6,
  text: '9 boxes of wood screws gone at once. Usually about 0.6 a day. Holding the order until someone looks.',
  ts: '2026-11-21T09:10:00-05:00',
};

/** Discs used 9 this week, screws 3 of them today: discs lead, then screws. */
function busyWeek(r: Rig): void {
  const days = daysBefore(r.room.today(), 7);
  for (const d of days) {
    r.room.usageDay('p-screws', d).used = 0;
    r.room.usageDay('p-discs', d).used = 0;
    r.room.usageDay('p-brackets', d).used = 0;
    r.room.usageDay('p-glue', d).used = 0;
  }
  r.room.usageDay('p-discs', days[6]!).used = 9;
  r.room.usageDay('p-screws', r.room.today()).used = 3;
}

const asker = (answer: Awaited<ReturnType<Asker['ask']>> | (() => Promise<never>)): Asker & { questions: string[] } => {
  const questions: string[] = [];
  return { questions, ask: async (q) => (questions.push(q), typeof answer === 'function' ? answer() : answer) };
};

describe('the fact sheet', () => {
  it('has the date, the season, one line per part and the orders with their totals', async () => {
    const r = await rig();
    busyWeek(r);
    r.room.s.orders.push(Order.parse(orderMock));
    const sheet = factSheet(r.room);
    const text = sheet.lines.map((l) => l.text);
    expect(sheet.lines[0]).toMatchObject({ id: 'F1' });
    expect(text[0]).toContain('2026-11-21');
    expect(text.find((t) => t.startsWith('Sanding discs'))).toContain('9 used in the 7 days before today');
    expect(text.find((t) => t.startsWith('Sanding discs'))).toContain('9 used this week (0 of them today)');
    expect(text.find((t) => t.startsWith('Wood screws'))).toContain('3 used this week (3 of them today)');
    expect(text).toContain('Most used this week, in units of each part: Sanding discs 120 grit 9, then Wood screws #8 x 1-1/4 in 3. 2 parts were not used this week.');
    expect(text.some((t) => t.startsWith('Order RU-1042') && t.includes('total $67.71 CAD') && t.includes('Offcut Supply'))).toBe(true);
    expect(text.at(-1)).toBe('Placed orders: 1, together $67.71 CAD.');
    for (const t of text) expect(t).not.toMatch(/[\u2013\u2014!]/);
  });

  it('ranks this week with ties named as ties', () => {
    const p = (name: string, usedWeek: number) => ({ name, usedWeek }) as ProductFacts;
    expect(rankingLine([p('Flat washers', 1), p('Hex bolts', 1), p('MWAX', 1), p('9V batteries', 1)])).toBe('Most used this week, in units of each part: Flat washers, Hex bolts, MWAX and 9V batteries 1 each.');
    expect(rankingLine([p('A', 2), p('B', 5), p('C', 2), p('D', 0)])).toBe('Most used this week, in units of each part: B 5, then A and C 2 each. 1 part was not used this week.');
    expect(rankingLine([p('A', 5), p('B', 4), p('C', 3), p('D', 2), p('E', 1)])).toBe('Most used this week, in units of each part: A 5, then B 4, then C 3, then D 2, and less for the rest.');
    expect(rankingLine([p('A', 0)])).toBe('Nothing was used this week.');
  });

  it('has a line for each count check that is holding an order', async () => {
    const r = await rig();
    r.room.s.checks = [CHECK];
    const text = factSheet(r.room).lines.map((l) => l.text);
    expect(text).toContain(`Count check on Wood screws #8 x 1-1/4 in, waiting for a person since 09:10: the count went from 11 to 2 at once. ${CHECK.text}`);
  });
});

describe('the prompt and the answer', () => {
  it('keeps the model to the facts and asks for JSON with fact ids', () => {
    const prompt = buildAskPrompt(QUESTION, [{ id: 'F1', text: 'Wood glue: 3 on the board.' }]);
    expect(prompt).toContain('Use only the facts below');
    expect(prompt).toContain('one or two short plain sentences');
    expect(prompt).toContain('No exclamation marks');
    expect(prompt).toContain('The data here does not answer that.');
    expect(prompt).toContain('say they tie');
    expect(prompt).toContain('Do not add numbers up yourself');
    expect(prompt).toContain('count check is waiting');
    expect(prompt).toContain('{"F1":"Wood glue: 3 on the board."}');
    expect(prompt).toContain(JSON.stringify(QUESTION));
  });

  it('reads an answer in a code fence and refuses an empty one', () => {
    expect(parseAskAnswer('```json\n{"answer":"Glue, 3.","facts":["F2",4]}\n```')).toEqual({ answer: 'Glue, 3.', facts: ['F2'] });
    expect(() => parseAskAnswer('{"answer":"  ","facts":[]}')).toThrow();
    expect(() => parseAskAnswer('no json')).toThrow();
  });

  it('puts the answer in house style', () => {
    expect(tidy('**Discs** were used most \u2014 9 packs!')).toBe('Discs were used most, 9 packs.');
    expect(tidy(`${'Nine packs of discs were used. '.repeat(20)}`).length).toBeLessThanOrEqual(320);
  });

  it('asks Gemini with the documented shape and falls back to the older one on a 400', async () => {
    const calls: { url: string; body: { generationConfig: Record<string, unknown>; contents: { parts: { text: string }[] }[] }; key: string | null }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('x-goog-api-key') });
      if (calls.length === 1) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"answer":"Discs, 9 packs.","facts":["F3"]}' }] } }] }));
    }) as unknown as typeof fetch;
    const result = await new GeminiAsker('k', 'gemini-3.8-flash', fake, 4000, () => {}).ask(QUESTION, [{ id: 'F3', text: 'x' }], new AbortController().signal);
    expect(result).toEqual({ answer: 'Discs, 9 packs.', facts: ['F3'] });
    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(calls[0]?.key).toBe('k');
    expect(calls[0]?.body.generationConfig).toHaveProperty('responseFormat');
    expect(calls[0]?.body.contents[0]?.parts[0]?.text).toContain(QUESTION);
    expect(calls[1]?.body.generationConfig).toHaveProperty('responseMimeType', 'application/json');
  });

  it('throws on a non 400 error so the hub can fall back', async () => {
    const fake = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    await expect(new GeminiAsker('k', 'm', fake, 4000, () => {}).ask(QUESTION, [], new AbortController().signal)).rejects.toThrow('503');
  });

  const good = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"answer":"Discs, 9 packs.","facts":[]}' }] } }] }));

  it('calls fetch the way a Worker allows: as a plain function, with no object as its this', async () => {
    const strict = function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
      return Promise.resolve(good());
    } as unknown as typeof fetch;
    expect((await new GeminiAsker('k', 'steady-flash', strict, 4000, () => {}).ask(QUESTION, [], new AbortController().signal)).answer).toBe('Discs, 9 packs.');
  });

  it('asks each model in GEMINI_MODEL in turn and skips one that is overloaded', async () => {
    const asked: string[] = [];
    const logs: string[] = [];
    const fake = (async (url: string) => {
      const model = /models\/([^:]+):/.exec(url)?.[1] ?? '';
      asked.push(model);
      return model === 'busy-flash' ? new Response('{}', { status: 503 }) : good();
    }) as unknown as typeof fetch;
    const result = await new GeminiAsker('k', 'busy-flash, steady-flash', fake, 4000, (l) => logs.push(l)).ask(QUESTION, [], new AbortController().signal);
    expect(result.answer).toBe('Discs, 9 packs.');
    expect(asked).toEqual(['busy-flash', 'steady-flash']);
    expect(logs).toEqual(['asking busy-flash failed: Gemini answered 503.']);
  });

  it('gives a slow model its own short clock, then asks the next', async () => {
    const asked: string[] = [];
    const fake = ((url: string, init: RequestInit) => {
      const model = /models\/([^:]+):/.exec(url)?.[1] ?? '';
      asked.push(model);
      if (model === 'steady-flash') return Promise.resolve(good());
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }) as unknown as typeof fetch;
    const result = await new GeminiAsker('k', 'slow-flash,steady-flash', fake, 20, () => {}).ask(QUESTION, [], new AbortController().signal);
    expect(result.answer).toBe('Discs, 9 packs.');
    expect(asked).toEqual(['slow-flash', 'steady-flash']);
  });
});

describe('POST /api/ask', () => {
  it('answers from Gemini and shows only the facts that are on the sheet', async () => {
    const fake = asker({ answer: 'Sanding discs, 9 packs this week. Wood screws next at 3.', facts: ['F5', 'f5', 'F99'] });
    const r = await rig({}, { asker: fake });
    busyWeek(r);
    const res = await r.call('POST', '/api/ask', { question: `  ${QUESTION}  ` });
    expect(res.status).toBe(200);
    const result = AskResult.parse(await res.json());
    expect(result.source).toBe('gemini');
    expect(result.answer).toBe('Sanding discs, 9 packs this week. Wood screws next at 3.');
    expect(result.facts).toEqual([factSheet(r.room).lines.find((l) => l.id === 'F5')!.text]);
    expect(fake.questions).toEqual([QUESTION]);
  });

  it('needs no token and refuses an empty or very long question', async () => {
    const r = await rig();
    expect((await r.call('POST', '/api/ask', { question: '   ' })).status).toBe(400);
    expect((await r.call('POST', '/api/ask', { question: 'x'.repeat(201) })).status).toBe(400);
    expect((await r.call('POST', '/api/ask', {})).status).toBe(400);
  });

  it('answers by itself with no key, and says it did', async () => {
    const r = await rig();
    busyWeek(r);
    const result = AskResult.parse(await (await r.call('POST', '/api/ask', { question: QUESTION })).json());
    expect(result.source).toBe('fallback');
    expect(result.answer).toBe('Sanding discs 120 grit was used most this week, 9. Next: Wood screws #8 x 1-1/4 in 3.');
    expect(result.facts).toHaveLength(2);
  });

  it('answers by itself when Gemini fails or answers with nothing', async () => {
    const failing = await rig({}, { asker: asker(() => Promise.reject(new Error('down'))) });
    expect(AskResult.parse(await (await failing.call('POST', '/api/ask', { question: QUESTION })).json()).source).toBe('fallback');
    const blank = await rig({}, { asker: asker({ answer: '!!!', facts: [] }) });
    expect(AskResult.parse(await (await blank.call('POST', '/api/ask', { question: QUESTION })).json()).source).toBe('fallback');
  });

  it('gives up on a slow Gemini and answers by itself', async () => {
    expect(ASK_TIMEOUT_MS).toBe(10_000);
    let aborted = false;
    const slow: Asker = { ask: (_q, _f, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => ((aborted = true), reject(new Error('aborted'))))) };
    const r = await rig({}, { asker: slow });
    const result = await ask(r.room, { question: QUESTION }, 20);
    expect(result.source).toBe('fallback');
    expect(aborted).toBe(true);
  });

  it(`asks Gemini at most ${ASK_PER_MINUTE} times a minute, then answers by itself`, async () => {
    const fake = asker({ answer: 'Discs, 9.', facts: [] });
    const r = await rig({}, { asker: fake });
    const sources: string[] = [];
    for (let i = 0; i < ASK_PER_MINUTE + 1; i++) sources.push(AskResult.parse(await (await r.call('POST', '/api/ask', { question: QUESTION })).json()).source);
    expect(sources.filter((s) => s === 'gemini')).toHaveLength(ASK_PER_MINUTE);
    expect(sources.at(-1)).toBe('fallback');
    r.clock.now += 61_000;
    expect(AskResult.parse(await (await r.call('POST', '/api/ask', { question: QUESTION })).json()).source).toBe('gemini');
  });
});

describe('the fallback answer', () => {
  it('picks a reading by the words in the question', async () => {
    const r = await rig();
    busyWeek(r);
    const sheet = factSheet(r.room);
    expect(fallbackAnswer('Which part runs out first?', sheet).answer).toMatch(/runs out first: \d+ on the board, [\d.]+ days of cover, reorder at \d+\.$/);
    expect(fallbackAnswer('How much did we spend?', sheet)).toEqual({ answer: 'There are no orders yet.', facts: [] });
    r.room.s.orders.push(Order.parse(orderMock));
    expect(fallbackAnswer('How much did we spend?', factSheet(r.room)).answer).toBe('1 order placed, together $67.71 CAD. The latest is RU-1042, 8 of Wood screws #8 x 1-1/4 in, placed.');
  });

  it('says so when nothing was used', async () => {
    const r = await rig();
    for (const p of r.room.s.products) for (const d of [...daysBefore(r.room.today(), 7), r.room.today()]) r.room.usageDay(p.id, d).used = 0;
    expect(fallbackAnswer(QUESTION, factSheet(r.room))).toEqual({ answer: 'Nothing was used this week.', facts: ['Nothing was used this week.'] });
  });

  it('names a tie at the top as a tie', async () => {
    const r = await rig();
    for (const p of r.room.s.products) for (const d of [...daysBefore(r.room.today(), 7), r.room.today()]) r.room.usageDay(p.id, d).used = 0;
    r.room.usageDay('p-glue', r.room.today()).used = 1;
    r.room.usageDay('p-brackets', r.room.today()).used = 1;
    expect(fallbackAnswer(QUESTION, factSheet(r.room)).answer).toBe('Corner brackets 2 in and Wood glue 473 mL tie for most used this week, 1 each.');
  });

  it('says why an order is held when a count check is waiting', async () => {
    const r = await rig();
    r.room.s.checks = [CHECK];
    const sheet = factSheet(r.room);
    for (const q of ['Why did it not order wood screws?', "Why didn't we reorder screws?", 'Is anything held?']) {
      const result = fallbackAnswer(q, sheet);
      expect(result.answer).toBe(CHECK.text);
      expect(result.facts).toHaveLength(1);
    }
    expect(fallbackAnswer('How much did we spend?', sheet).answer).toBe('There are no orders yet.');
    r.room.s.checks = [];
    expect(fallbackAnswer('Why did it not order wood screws?', factSheet(r.room)).answer).toBe('There are no orders yet.');
  });
});
