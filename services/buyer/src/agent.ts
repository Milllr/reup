// The one seam between the buyer and whatever drives a browser. TinyFish in real use, a fake in tests,
// and a local stand in for development. Nothing else in the buyer knows the SDK.
import { TinyFish } from '@tiny-fish/sdk';

/** What a development stand in needs to do the same job without reading the goal text. TinyFish ignores it. */
export type Task =
  | { kind: 'market'; supplierId: string; sku: string | null; phrase: string }
  | { kind: 'cart'; sku: string | null; phrase: string; units: number; packIndex: number | null }
  | { kind: 'place'; poNumber: string; sku: string | null; units: number; packIndex: number | null }
  | { kind: 'track'; confirmation: string };

export interface AgentParams {
  url: string;
  goal: string;
  outputSchema: Record<string, unknown>;
  browserProfile: 'lite' | 'stealth';
  /** ISO country for the proxy, or null for no proxy. */
  proxyCountry: string | null;
  maxDurationSeconds: number;
  /** A saved signed in browser profile, when there is one. */
  profileId: string | null;
  task: Task;
}

export type AgentEvent =
  | { type: 'started'; runId: string }
  | { type: 'streaming_url'; url: string }
  | { type: 'progress'; purpose: string };

export interface Outcome {
  runId: string | null;
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface Agent {
  readonly engine: 'tinyfish' | 'local';
  run(params: AgentParams, onEvent: (e: AgentEvent) => void): Promise<Outcome>;
}

/** The little of the SDK the buyer uses, so a test can pass a fake client. */
export interface TinyFishClient {
  agent: { stream(params: Record<string, unknown>): Promise<AsyncIterable<Record<string, unknown>>> };
  runs: { get(runId: string): Promise<{ status: string; result: Record<string, unknown> | null; error: { code?: string; message: string; category?: string } | null }> };
}

const FINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

// TinyFish accepts a subset of JSON Schema for output_schema and answers 400 to anything else, before the run starts.
// The list is from docs.tinyfish.ai/key-concepts/structured-output (read Nov 21). Note: no description, no additionalProperties.
const SCHEMA_KEYWORDS = new Set(['type', 'anyOf', 'nullable', 'properties', 'required', 'propertyOrdering', 'items', 'minItems', 'maxItems', 'enum', 'format', 'minimum', 'maximum']);

/** The keywords in a schema that TinyFish would refuse, as paths. Empty means the schema is safe to send. */
export function schemaProblems(schema: unknown, path = '#'): string[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [`${path} is not a schema object`];
  const out: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) out.push(`${path}/${key}`);
    else if (key === 'type' && typeof value !== 'string') out.push(`${path}/type must be one string`);
    else if (key === 'properties') for (const [name, child] of Object.entries(value as object)) out.push(...schemaProblems(child, `${path}/properties/${name}`));
    else if (key === 'items') out.push(...schemaProblems(value, `${path}/items`));
    else if (key === 'anyOf') (value as unknown[]).forEach((child, i) => out.push(...schemaProblems(child, `${path}/anyOf/${i}`)));
  }
  return out;
}

/** What a failed run says, in plain words for the screen. */
export function plainError(error: { code?: string; message?: string; category?: string } | null | undefined): string | null {
  if (!error) return null;
  if (error.code === 'SITE_BLOCKED') return 'The site blocked the browser.';
  if (error.code === 'TIMEOUT') return 'The run took too long.';
  if (error.code === 'MAX_STEPS_EXCEEDED') return 'The run took too many steps.';
  if (error.code === 'BILLING_REJECTED' || error.category === 'BILLING_FAILURE') return 'TinyFish refused the run: the account is out of credits.';
  return error.message ?? 'The run failed.';
}

export function toRequest(p: AgentParams): Record<string, unknown> {
  return {
    url: p.url,
    goal: p.goal,
    output_schema: p.outputSchema,
    browser_profile: p.browserProfile,
    ...(p.proxyCountry ? { proxy_config: { enabled: true, country_code: p.proxyCountry } } : {}),
    agent_config: { max_duration_seconds: p.maxDurationSeconds },
    ...(p.profileId ? { use_profile: true, profile_id: p.profileId } : {}),
  };
}

export class TinyFishAgent implements Agent {
  readonly engine = 'tinyfish' as const;

  constructor(private client: TinyFishClient, private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), private pollMs = 3000) {}

  static fromKey(apiKey: string): TinyFishAgent {
    return new TinyFishAgent(new TinyFish({ apiKey }) as unknown as TinyFishClient);
  }

  async run(params: AgentParams, onEvent: (e: AgentEvent) => void): Promise<Outcome> {
    let runId: string | null = null;
    try {
      const stream = await this.client.agent.stream(toRequest(params));
      for await (const event of stream) {
        if (event.type === 'STARTED' && typeof event.run_id === 'string') {
          runId = event.run_id;
          onEvent({ type: 'started', runId });
        } else if (event.type === 'STREAMING_URL' && typeof event.streaming_url === 'string') {
          onEvent({ type: 'streaming_url', url: event.streaming_url });
        } else if (event.type === 'PROGRESS' && typeof event.purpose === 'string') {
          onEvent({ type: 'progress', purpose: event.purpose });
        } else if (event.type === 'COMPLETE') {
          const error = event.error as { code?: string; message?: string; category?: string } | null;
          const status = FINAL.has(String(event.status)) ? (event.status as Outcome['status']) : 'FAILED';
          return { runId: (event.run_id as string) ?? runId, status, result: (event.result as Record<string, unknown> | null) ?? null, error: plainError(error) };
        }
      }
    } catch (err) {
      if (!runId) return { runId: null, status: 'FAILED', result: null, error: `TinyFish could not start the run: ${err instanceof Error ? err.message : String(err)}` };
      console.error('The event stream dropped. Polling the run instead.', err);
    }
    // The stream ended without COMPLETE. The run may still be going: ask for it until it is final.
    if (!runId) return { runId: null, status: 'FAILED', result: null, error: 'TinyFish ended the stream before the run started.' };
    const deadline = (params.maxDurationSeconds + 60) * 1000;
    for (let waited = 0; waited <= deadline; waited += this.pollMs) {
      try {
        const run = await this.client.runs.get(runId);
        if (FINAL.has(run.status)) return { runId, status: run.status as Outcome['status'], result: run.result, error: plainError(run.error) };
      } catch (err) {
        console.error('Polling the run failed. Trying again.', err);
      }
      await this.sleep(this.pollMs);
    }
    return { runId, status: 'FAILED', result: null, error: 'The run did not finish in time.' };
  }
}
