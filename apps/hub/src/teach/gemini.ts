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

/** How long one model gets before the next one is asked. A good answer takes 1 to 7 seconds. */
export const ATTEMPT_MS = 7000;

/** "a, b , c" as a list. GEMINI_MODEL may name several models: the first that answers names the part. */
export const modelList = (models: string) => models.split(',').map((m) => m.trim()).filter((m) => m !== '');

export class GeminiNamer implements Namer {
  private models: string[];

  /**
   * models is one model or several with commas between, in the order to ask them. A model that is overloaded, slow
   * or gone is skipped: on Sat Nov 21 2026 the newest Flash answered 503 or took two minutes while the others took 2 seconds.
   */
  constructor(private apiKey: string, models: string, private fetcher: typeof fetch = fetch, private attemptMs = ATTEMPT_MS, private log: (line: string) => void = (line) => console.error(line)) {
    this.models = modelList(models);
  }

  private async call(model: string, body: unknown, signal: AbortSignal): Promise<Response> {
    return this.fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
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

  async name(jpegBase64: string, catalog: readonly CatalogItem[], signal: AbortSignal): Promise<NameResult> {
    const contents = [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpegBase64 } }, { text: buildPrompt(catalog) }] }];
    let last: unknown = new Error('No Gemini model is set.');
    for (const model of this.models) {
      if (signal.aborted) break;
      // Each model has its own clock, and the caller's signal still stops everything.
      const attempt = new AbortController();
      const stop = () => attempt.abort();
      signal.addEventListener('abort', stop);
      const timer = setTimeout(stop, this.attemptMs);
      try {
        return await this.ask(model, contents, attempt.signal);
      } catch (err) {
        last = attempt.signal.aborted && !signal.aborted ? new Error(`${model} took longer than ${Math.round(this.attemptMs / 1000)} seconds.`) : err;
        this.log(`naming with ${model} failed: ${last instanceof Error ? last.message : String(last)}`);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      }
    }
    throw last;
  }
}
