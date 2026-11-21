// One agent run, start to finish: mirror it to the hub so the screens can watch, save it when it is good,
// and fall back to the last good recording when the live web says no. The screen always says Replay for a recording.
import type { Run, RunKind, Supplier } from '@reup/contracts';
import type { Agent, AgentParams } from './agent';
import type { Recordings } from './recordings';

export interface Deps {
  agent: Agent;
  recordings: Recordings;
  /** POST /ingest/runs. Must never throw: a hub that is down does not stop a run. */
  mirror(run: Run): Promise<void>;
  now(): Date;
  iso(d: Date): string;
  sleep(ms: number): Promise<void>;
  id(): string;
}

export interface RunSpec {
  kind: RunKind;
  supplier: Supplier;
  productId: string | null;
  orderId: string | null;
  params: AgentParams;
  /** The operator asked for the recording in place of a live run. */
  replay: boolean;
  /** May a failed live run be answered with a recording? Never for placing an order. */
  fallback: boolean;
  /** Looks at a completed run's result and returns a plain error when it is not a real answer (no price, a block page). */
  check(result: Record<string, unknown> | null): string | null;
}

export interface RunResult {
  ok: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  replayed: boolean;
  run: Run;
}

function freshRun(deps: Deps, spec: RunSpec, replay: boolean): Run {
  return {
    id: `r-${deps.id()}`, tinyfishRunId: null, kind: spec.kind, supplierId: spec.supplier.id, productId: spec.productId, orderId: spec.orderId,
    status: 'running', streamingUrl: null, steps: [], replay, error: null, startedAt: deps.iso(deps.now()), finishedAt: null, engine: deps.agent.engine,
  };
}

async function playRecording(deps: Deps, spec: RunSpec): Promise<RunResult | null> {
  const recording = await deps.recordings.load(spec.kind, spec.supplier.id);
  if (!recording) return null;
  const run = freshRun(deps, spec, true);
  await deps.mirror(run);
  let at = 0;
  for (const step of recording.steps) {
    await deps.sleep(Math.max(0, step.offsetMs - at));
    at = step.offsetMs;
    run.steps = [...run.steps, { ts: deps.iso(deps.now()), purpose: step.purpose }];
    await deps.mirror(run);
  }
  await deps.sleep(Math.max(0, recording.durationMs - at));
  run.status = 'completed';
  run.finishedAt = deps.iso(deps.now());
  await deps.mirror(run);
  return { ok: true, result: recording.result, error: null, replayed: true, run };
}

export async function runAgent(deps: Deps, spec: RunSpec): Promise<RunResult> {
  if (spec.replay) {
    const played = await playRecording(deps, spec);
    if (played) return played;
    console.log(`Replay is on for ${spec.kind} at ${spec.supplier.name} but there is no recording yet. Running it live.`);
  }

  const run = freshRun(deps, spec, false);
  const started = deps.now().getTime();
  const steps: { offsetMs: number; purpose: string }[] = [];
  await deps.mirror(run);
  // Events are mirrored in order, one at a time, so the hub never sees an older copy after a newer one.
  let chain: Promise<void> = Promise.resolve();
  const push = () => {
    const copy = { ...run, steps: [...run.steps] };
    chain = chain.then(() => deps.mirror(copy));
  };

  const outcome = await deps.agent.run(spec.params, (event) => {
    if (event.type === 'started') run.tinyfishRunId = event.runId;
    else if (event.type === 'streaming_url') run.streamingUrl = event.url;
    else {
      run.steps = [...run.steps, { ts: deps.iso(deps.now()), purpose: event.purpose }];
      steps.push({ offsetMs: deps.now().getTime() - started, purpose: event.purpose });
    }
    push();
  });
  await chain;

  // COMPLETED only means the agent stopped. Whether it got an answer is for the job to say.
  let error: string | null = null;
  if (outcome.status !== 'COMPLETED') error = outcome.error ?? (outcome.status === 'CANCELLED' ? 'The run was cancelled.' : 'The run failed.');
  else error = spec.check(outcome.result);

  run.tinyfishRunId = outcome.runId ?? run.tinyfishRunId;
  run.status = error ? 'failed' : 'completed';
  run.error = error;
  run.finishedAt = deps.iso(deps.now());
  await deps.mirror(run);

  if (!error) {
    await deps.recordings.save({ kind: spec.kind, supplierId: spec.supplier.id, savedAt: run.finishedAt, durationMs: deps.now().getTime() - started, steps, result: outcome.result }).catch((err) => console.error('Could not save the recording.', err));
    return { ok: true, result: outcome.result, error: null, replayed: false, run };
  }
  if (spec.fallback) {
    const played = await playRecording(deps, spec);
    if (played) return played;
  }
  return { ok: false, result: outcome.result, error, replayed: false, run };
}
