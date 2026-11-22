// Every mock must validate against its schema. A lane that builds against a mock is building against the contract.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as C from '../src/index';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mocks');
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8'));

const cases: Record<string, z.ZodType> = {
  snapshot: C.Snapshot,
  count: C.Count,
  pick: C.PickEvent,
  reach: C.Reach,
  'ingest-reaches': C.IngestReachesBody,
  policy: C.Policy,
  quote: C.Quote,
  run: C.Run,
  order: C.Order,
  'order-placed': C.Order,
  'node-status': C.NodeStatus,
  teach: C.TeachState,
  jobs: C.JobsResult,
  'server-messages': z.array(C.ServerMessage),
  history: C.HistoryResult,
  analytics: C.AnalyticsResult,
  catalog: C.Catalog,
  'ingest-counts': C.IngestCountsBody,
  'ingest-picks': C.IngestPicksBody,
  'ingest-node': C.IngestNodeBody,
  'ingest-node-result': C.IngestNodeResult,
  'ingest-reorder': C.IngestReorderBody,
  'ingest-cart': C.IngestCartBody,
  'ingest-placed': C.IngestPlacedBody,
  'supply-webhook': C.SupplyWebhookBody,
  'teach-confirm': C.TeachConfirmBody,
  'api-error': C.ApiError,
  'count-check': C.CountCheck,
  'check-answer': C.CheckAnswerBody,
  'product-add': C.ProductAddBody,
  'product-edit': C.ProductEditBody,
  'product-count': C.ProductCountBody,
  'zone-quad': C.ZoneQuadBody,
  board: C.BoardBody,
  ask: C.AskBody,
  'ask-result': C.AskResult,
};

describe('contract mocks', () => {
  for (const [name, schema] of Object.entries(cases)) {
    it(`${name}.json matches its schema`, () => {
      const result = schema.safeParse(load(name));
      expect(result.success ? '' : JSON.stringify(result.error.issues.slice(0, 3))).toBe('');
    });
  }

  it('every mock file has a schema', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    expect(files.filter((f) => !(f in cases))).toEqual([]);
  });

  it('the snapshot is consistent with itself', () => {
    const s = C.Snapshot.parse(load('snapshot'));
    const productIds = new Set(s.products.map((p) => p.id));
    const zoneIds = new Set(s.zones.map((z) => z.id));
    for (const c of s.counts) {
      expect(productIds.has(c.productId)).toBe(true);
      expect(zoneIds.has(c.zoneId)).toBe(true);
      if (c.pockets) expect(c.pockets.filter(Boolean).length).toBe(c.count);
    }
    for (const z of s.zones) if (z.kind === 'pockets') expect((z.rows ?? 0) * (z.cols ?? 0)).toBeGreaterThan(0);
    for (const o of s.orders) expect(o.packs).toBe(Math.ceil(o.units / o.packSize));
  });

  it('rejects a count below zero and a time without an offset', () => {
    const good = load('count') as Record<string, unknown>;
    expect(C.Count.safeParse({ ...good, count: -1 }).success).toBe(false);
    expect(C.Count.safeParse({ ...good, ts: '2026-11-21 09:14' }).success).toBe(false);
  });

  it('lets camera health be posted alone, but not an empty body', () => {
    const body = load('ingest-counts') as { counts: unknown[]; cameras: unknown[] };
    expect(C.IngestCountsBody.safeParse({ counts: [], cameras: body.cameras }).success).toBe(true);
    expect(C.IngestCountsBody.safeParse({ counts: body.counts }).success).toBe(true);
    expect(C.IngestCountsBody.safeParse({ counts: [] }).success).toBe(false);
    expect(C.IngestCountsBody.safeParse({ counts: [], cameras: [] }).success).toBe(false);
  });
});
