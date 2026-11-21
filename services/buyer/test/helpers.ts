import type { Job, Run, Supplier } from '@reup/contracts';
import type { Agent, AgentEvent, AgentParams, Outcome } from '../src/agent';
import { configFrom, type Config } from '../src/config';
import { memoryRecordings } from '../src/recordings';
import type { Deps } from '../src/runner';

export const offcut: Supplier = { id: 's-offcut', name: 'Offcut Supply', kind: 'account', baseUrl: 'https://offcut.test', searchUrl: 'https://offcut.test/search?q={q}', country: 'CA' };
export const retailerA: Supplier = { id: 's-market-a', name: 'Retailer A', kind: 'market', baseUrl: 'https://a.test', searchUrl: 'https://a.test/search?q={q}', country: 'CA' };
export const retailerB: Supplier = { id: 's-market-b', name: 'Retailer B', kind: 'market', baseUrl: 'https://b.test', searchUrl: 'https://b.test/s?k={q}', country: 'CA' };

export const marketJob: Extract<Job, { kind: 'market' }> = { id: 'j-1', kind: 'market', productId: 'p-screws', searchPhrase: '#8 x 1-1/4 wood screws box of 100', supplierIds: ['s-market-a', 's-market-b'] };
export const cartJob: Extract<Job, { kind: 'cart' }> = { id: 'j-2', kind: 'cart', orderId: 'o-1', productId: 'p-screws', supplierId: 's-offcut', sku: 'OC-1008-114', searchPhrase: '#8 x 1-1/4 wood screws box of 100', units: 8 };
export const placeJob: Extract<Job, { kind: 'place' }> = { id: 'j-3', kind: 'place', orderId: 'o-1', supplierId: 's-offcut', poNumber: 'RU-1042' };

export type Script = (params: AgentParams, emit: (e: AgentEvent) => void) => Promise<Outcome> | Outcome;

export function fakeAgent(script: Script): Agent & { calls: AgentParams[] } {
  const calls: AgentParams[] = [];
  return { engine: 'tinyfish', calls, run: async (params, onEvent) => { calls.push(params); return script(params, onEvent); } };
}

export const completed = (result: Record<string, unknown> | null): Outcome => ({ runId: 'tf-1', status: 'COMPLETED', result, error: null });

export function deps(agent: Agent) {
  const clock = { now: Date.parse('2026-11-21T14:14:00Z') };
  const mirrored: Run[] = [];
  const slept: number[] = [];
  let n = 0;
  const recordings = memoryRecordings();
  const d: Deps = {
    agent, recordings,
    mirror: async (run) => void mirrored.push(structuredClone(run)),
    now: () => new Date(clock.now),
    iso: (date) => date.toISOString().replace(/\.\d+Z$/, 'Z'),
    sleep: async (ms) => { slept.push(ms); clock.now += ms; },
    id: () => String(++n),
  };
  return { d, clock, mirrored, slept, recordings };
}

export const config = (env: Record<string, string> = {}): Config => configFrom(env, '/tmp/reup-recordings-test');
