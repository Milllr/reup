// Naming a new part. One image and the store's catalog as a closed list go in; a catalog item or a plain name comes out.
// Gemini names once and never counts. The request shape follows ai.google.dev/gemini-api/docs/generate-content/structured-output
// as read on Nov 21 2026: generationConfig.responseFormat.text with a JSON schema. The older responseMimeType shape is the fallback.
import type { CatalogItem } from '@reup/contracts';

export interface NameResult {
  /** A catalog SKU, or null when nothing in the catalog matches. */
  sku: string | null;
  name: string;
  unit: string;
  confidence: 'sure' | 'fairly_sure' | 'not_sure';
}

export interface Namer {
  name(jpegBase64: string, catalog: readonly CatalogItem[], signal: AbortSignal): Promise<NameResult>;
}

export function buildPrompt(catalog: readonly CatalogItem[]): string {
  const lines = catalog.map((item) => `${item.sku} | ${item.name} | ${item.unit} | ${item.category}`);
  return [
    'The photo shows one hardware or shop supply item on a table. Identify it.',
    'Here is the catalog of the store we buy from, one item per line as SKU | name | unit | category:',
    ...lines,
    'If one catalog item matches what is in the photo, answer with its SKU exactly as written. Read any label, size or count printed on the packaging to choose between similar items.',
    'If nothing in the catalog matches, answer with sku null and give your own short name and unit (for example "box of 100", "bag of 10", "each").',
    'confidence is "sure" when a printed label confirms it, "fairly_sure" when it matches by look, "not_sure" otherwise.',
    'Answer with JSON only: {"sku": string or null, "name": string, "unit": string, "confidence": "sure" | "fairly_sure" | "not_sure"}.',
  ].join('\n');
}

const SCHEMA = {
  type: 'object',
  properties: {
    sku: { type: ['string', 'null'] },
    name: { type: 'string' },
    unit: { type: 'string' },
    confidence: { type: 'string', enum: ['sure', 'fairly_sure', 'not_sure'] },
  },
  required: ['sku', 'name', 'unit', 'confidence'],
};

/** Reads the model's answer even when it wraps the JSON in a code fence. */
export function parseAnswer(text: string): NameResult {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error('The model did not answer with JSON.');
  const raw = JSON.parse(match[0]) as Record<string, unknown>;
  const confidence = raw.confidence === 'sure' || raw.confidence === 'fairly_sure' ? raw.confidence : 'not_sure';
  const sku = typeof raw.sku === 'string' && raw.sku.trim() !== '' && raw.sku !== 'null' ? raw.sku.trim() : null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (sku == null && name === '') throw new Error('The model gave no name.');
  return { sku, name, unit: typeof raw.unit === 'string' && raw.unit.trim() !== '' ? raw.unit.trim() : 'each', confidence };
}

/** How long one model gets to answer. A good answer takes 1 to 7 seconds. */
export const ATTEMPT_MS = 7000;
/** With no answer after this long the next model is asked as well, and the first good answer wins. A model that fails hands over at once. */
export const HEDGE_MS = 2500;

/** "a, b , c" as a list. GEMINI_MODEL may name several models: the first that answers names the part. */
export const modelList = (models: string) => models.split(',').map((m) => m.trim()).filter((m) => m !== '');

export class GeminiNamer implements Namer {
  private models: string[];

  /**
   * models is one model or several with commas between, in the order to ask them. A model that is overloaded, slow
   * or gone is skipped: on Sat Nov 21 2026 the newest Flash answered 503 or took two minutes while the others took 2 seconds.
   */
  constructor(private apiKey: string, models: string, private fetcher: typeof fetch = fetch, private attemptMs = ATTEMPT_MS, private log: (line: string) => void = (line) => console.error(line), private hedgeMs = HEDGE_MS) {
    this.models = modelList(models);
  }

  private async call(model: string, body: unknown, signal: AbortSignal): Promise<Response> {
    // Called as a plain function, never as this.fetcher(...): on Workers the global fetch refuses to run with an object
    // as its this ("Illegal invocation"), which is how naming failed on the deployed hub while every test in Node passed.
    const send = this.fetcher;
    return send(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
      signal,
    });
  }

  private async ask(model: string, contents: unknown, signal: AbortSignal): Promise<NameResult> {
    let res = await this.call(model, { contents, generationConfig: { temperature: 0, responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: SCHEMA } } } }, signal);
    if (res.status === 400) res = await this.call(model, { contents, generationConfig: { temperature: 0, responseMimeType: 'application/json' } }, signal);
    if (!res.ok) throw new Error(`Gemini answered ${res.status}.`);
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    return parseAnswer(text);
  }

  /**
   * Asks the first model. If it has not answered after hedgeMs the next is asked too, and so on down the list, and a
   * model that fails hands over to the next at once. The first good answer wins and the others are dropped. So one
   * slow or overloaded model costs a couple of seconds, not the part's name.
   */
  name(jpegBase64: string, catalog: readonly CatalogItem[], signal: AbortSignal): Promise<NameResult> {
    const contents = [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpegBase64 } }, { text: buildPrompt(catalog) }] }];
    const models = this.models;
    return new Promise<NameResult>((resolve, reject) => {
      if (models.length === 0) return reject(new Error('No Gemini model is set.'));
      if (signal.aborted) return reject(new Error('Naming was stopped.'));
      const running = new Set<AbortController>();
      let asked = 0;
      let failed = 0;
      let over = false;
      let hedge: ReturnType<typeof setTimeout> | null = null;
      let last: unknown = null;

      const finish = () => {
        over = true;
        if (hedge != null) clearTimeout(hedge);
        signal.removeEventListener('abort', stopAll);
        for (const attempt of running) attempt.abort();
      };
      const stopAll = () => {
        if (over) return;
        finish();
        reject(new Error('Naming was stopped.'));
      };
      const askNext = () => {
        if (over || asked >= models.length) return;
        const model = models[asked] as string;
        asked += 1;
        const attempt = new AbortController();
        running.add(attempt);
        let late = false;
        const clock = setTimeout(() => {
          late = true;
          attempt.abort();
        }, this.attemptMs);
        if (hedge != null) clearTimeout(hedge);
        hedge = asked < models.length ? setTimeout(askNext, this.hedgeMs) : null;
        this.ask(model, contents, attempt.signal).then(
          (result) => {
            clearTimeout(clock);
            running.delete(attempt);
            if (over) return;
            finish();
            resolve(result);
          },
          (err: unknown) => {
            clearTimeout(clock);
            running.delete(attempt);
            if (over) return;
            last = late ? new Error(`${model} took longer than ${Math.round(this.attemptMs / 1000)} seconds.`) : err;
            this.log(`naming with ${model} failed: ${last instanceof Error ? last.message : String(last)}`);
            failed += 1;
            if (failed >= models.length) {
              finish();
              reject(last);
            } else {
              askNext();
            }
          },
        );
      };
      signal.addEventListener('abort', stopAll);
      askNext();
    });
  }
}
