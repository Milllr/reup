// Ask reup: a plain question about use, stock and orders, answered by Gemini from the hub's own fact sheet.
// With no key, a failed call, a slow call or too many questions at once, the hub answers by itself from the same facts.
import type { AskBody, AskResult } from '@reup/contracts';
import type { RoomCore } from '../core/room';
import { and, factSheet, groupText, STATE_WORDS, weekGroups, type FactSheet, type ProductFacts } from './facts';

export const ASK_TIMEOUT_MS = 10_000;
/** The route takes no token, so Gemini is asked at most this many times a minute. Past it, the hub answers by itself. */
export const ASK_PER_MINUTE = 20;

const recent = new WeakMap<RoomCore, number[]>();

function underLimit(room: RoomCore): boolean {
  const now = room.nowMs();
  const times = (recent.get(room) ?? []).filter((t) => now - t < 60_000);
  if (times.length >= ASK_PER_MINUTE) {
    recent.set(room, times);
    return false;
  }
  times.push(now);
  recent.set(room, times);
  return true;
}

/** House style on whatever the model wrote: no exclamation marks, no dashes, no markdown, a sane length. */
export function tidy(text: string): string {
  let out = text
    .replace(/[*_`#]/g, '')
    .replace(/\s*[\u2013\u2014]\s*/g, ', ')
    .replace(/!+/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > 320) {
    const cut = out.slice(0, 320);
    const end = cut.lastIndexOf('. ');
    out = end > 80 ? cut.slice(0, end + 1) : `${cut.trimEnd()}.`;
  }
  return out;
}

const lineFor = (sheet: FactSheet, p: ProductFacts) => sheet.lines.find((l) => l.text.startsWith(`${p.name} (unit:`))?.text;

/** The hub's own answer, for when Gemini cannot give one. It picks a reading by a few plain words in the question. */
export function fallbackAnswer(question: string, sheet: FactSheet): Pick<AskResult, 'answer' | 'facts'> {
  const q = question.toLowerCase();
  const products = sheet.products;
  if (products.length === 0) return { answer: 'There are no parts on the board yet.', facts: [] };

  const covered = products.filter((p) => p.daysOfCover != null).sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0));
  const ranking = sheet.lines.find((l) => l.text.startsWith('Most used this week') || l.text === 'Nothing was used this week.')?.text;

  const most = () => {
    const [first, second] = weekGroups(products);
    if (!first) return { answer: 'Nothing was used this week.', facts: ranking ? [ranking] : [] };
    const lead = first.names.length > 1 ? `${and(first.names)} tie for most used this week, ${first.used} each.` : `${first.names[0]} was used most this week, ${first.used}.`;
    const answer = second ? `${lead} Next: ${groupText(second)}.` : lead;
    const top = products.filter((p) => first.names.includes(p.name)).slice(0, 3);
    return { answer, facts: [ranking, ...top.map((p) => lineFor(sheet, p))].filter((t): t is string => t != null) };
  };
  const held = () => {
    const lines = sheet.lines.filter((l) => l.text.startsWith('Count check on ')).map((l) => l.text);
    const [check] = sheet.checks;
    if (!check) return null;
    return { answer: sheet.checks.length === 1 ? check.text : `${sheet.checks.length} count checks are waiting for a person. ${check.text}`, facts: lines };
  };
  const lowest = () => {
    const p = covered[0];
    if (!p) return { answer: 'No part has any use yet, so none is close to running out.', facts: [] };
    return { answer: `${p.name} runs out first: ${p.count} on the board, ${p.daysOfCover} days of cover, reorder at ${p.reorderPoint ?? 0}.`, facts: [lineFor(sheet, p)].filter((t): t is string => t != null) };
  };
  const orders = () => {
    const lines = sheet.lines.filter((l) => l.text.startsWith('Order ') || l.text.startsWith('Placed orders'));
    const latest = sheet.orders[0];
    if (!latest) return { answer: 'There are no orders yet.', facts: [] };
    const placed = sheet.orders.filter((o) => ['placed', 'shipped', 'received'].includes(o.state) && o.total != null);
    const total = placed.reduce((a, o) => a + (o.total ?? 0), 0);
    const name = products.find((p) => p.id === latest.productId)?.name ?? latest.productId;
    const answer = `${placed.length} ${placed.length === 1 ? 'order' : 'orders'} placed, together $${total.toFixed(2)} CAD. The latest is ${latest.poNumber}, ${latest.units} of ${name}, ${STATE_WORDS[latest.state]}.`;
    return { answer, facts: lines.slice(0, 3).map((l) => l.text) };
  };

  if (/\b(why|check|checks|held|hold|holding|miscount|wrong)\b/.test(q) || /\b(not|n't|no)\b.*\border/.test(q) || /didn.t|hasn.t|isn.t/.test(q)) {
    const h = held();
    if (h) return h;
  }
  if (/\b(order|orders|ordered|spend|spent|cost|total|bought|buy|paid|price)\b/.test(q)) return orders();
  if (/\b(low|lowest|run out|running out|runs out|empty|cover|soon|reorder|left)\b/.test(q)) return lowest();
  if (/\b(most|top|busiest|popular|used|use|usage)\b/.test(q)) return most();
  const a = most();
  const b = lowest();
  return { answer: `${a.answer} ${b.answer}`, facts: [...new Set([...a.facts, ...b.facts])] };
}

export async function ask(room: RoomCore, body: AskBody, timeoutMs = ASK_TIMEOUT_MS): Promise<AskResult> {
  const question = body.question.trim();
  const sheet = factSheet(room);
  const fallback = (): AskResult => ({ ...fallbackAnswer(question, sheet), source: 'fallback' });
  const asker = room.deps.asker;
  if (!asker || !underLimit(room)) return fallback();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Gemini took longer than 10 seconds.'));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([asker.ask(question, sheet.lines, controller.signal), timeout]);
    const answer = tidy(result.answer);
    if (!/[\p{L}\p{N}]/u.test(answer)) return fallback();
    const byId = new Map(sheet.lines.map((l) => [l.id, l.text]));
    // Only ids that are really on the sheet: the screen never shows a fact the hub did not give.
    const facts = [...new Set(result.facts.map((id) => id.trim().toUpperCase()))].map((id) => byId.get(id)).filter((t): t is string => t != null);
    return { answer, source: 'gemini', facts };
  } catch (err) {
    console.error('ask failed', err);
    return fallback();
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}
