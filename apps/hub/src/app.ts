// Every hub route: check the token, check the body against the contract, call the Room, answer in the contract's shape.
import { ApproveBody, BoardBody, CheckAnswerBody, IngestCartBody, IngestCountsBody, IngestNodeBody, IngestPicksBody, IngestPlacedBody, IngestQuotesBody, IngestReachesBody, IngestReorderBody, IngestRunsBody, ManualOrderBody, ReplayBody, ScreenBody, Season, SupplyWebhookBody, TeachBody, TeachConfirmBody, ZonesBody, type ApiError } from '@reup/contracts';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { z } from 'zod';
import type { RoomCore } from './core/room';
import { putZones, reset, setBoard, setReplay, setScreen, setSeason } from './demo';
import { analyticsResult } from './analytics';
import { historyResult } from './history';
import { supplyWebhook } from './hooks';
import { ingestCounts, ingestNode, ingestPicks, ingestReaches } from './ingest';
import { answerCheck, approve, cancel, Conflict, ingestCart, ingestPlaced, ingestQuotes, ingestReorder, ingestRuns, NotFound, openOrder } from './orders';
import { cancelTeach, catalog, confirmTeach, cropKey, startTeach } from './teach';

class BadRequest extends Error {}
class Unauthorized extends Error {}

const err = (code: ApiError['code'], message: string): ApiError => ({ ok: false, code, message });
const OK = { ok: true } as const;

export interface AppOptions {
  /** Runs after every request that may have changed state: save, and set the next alarm. */
  after?: () => Promise<void>;
}

export function createApp(room: RoomCore, options: AppOptions = {}): Hono {
  const app = new Hono();
  const { DEVICE_TOKEN, OPS_TOKEN, APPROVE_KEY, SUPPLY_WEBHOOK_SECRET } = room.config;

  app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'] }));

  app.onError((e, c) => {
    if (e instanceof BadRequest) return c.json(err('bad_request', e.message), 400);
    if (e instanceof Unauthorized) return c.json(err('unauthorized', e.message), 401);
    if (e instanceof NotFound) return c.json(err('not_found', e.message), 404);
    if (e instanceof Conflict) return c.json(err('conflict', e.message), 409);
    console.error('hub error', e);
    return c.json(err('upstream_failed', 'Something went wrong in the hub.'), 500);
  });
  app.notFound((c) => c.json(err('not_found', `No route ${c.req.method} ${new URL(c.req.url).pathname}.`), 404));

  const allow = (c: Context, ...tokens: string[]) => {
    const sent = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (sent === '' || !tokens.includes(sent)) throw new Unauthorized('Missing or wrong token.');
  };

  async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new BadRequest('The body is not JSON.');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequest(`${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'not valid'}`);
    }
    return parsed.data;
  }

  const done = async () => {
    await options.after?.();
  };

  // ---------- reading: no token ----------
  app.get('/api/state', (c) => c.json(room.snapshot()));
  app.get('/api/health', (c) => c.json({ ok: true, now: room.iso() }));
  app.get('/api/products/:id/history', (c) => {
    const result = historyResult(room, c.req.param('id'));
    if (!result) throw new NotFound(`No product ${c.req.param('id')}.`);
    return c.json(result);
  });
  // The store's catalog gives a price to a part nobody has bought yet. It is cached, and a store that is down costs only the prices.
  app.get('/api/analytics', async (c) => c.json(analyticsResult(room, await catalog(room))));
  app.get('/api/teach/:id/crop.jpg', async (c) => {
    const data = await room.deps.store.get<string>(cropKey(c.req.param('id')));
    if (!data) throw new NotFound('No picture for that id.');
    const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' } });
  });

  // ---------- ingest: device token ----------
  app.get('/api/jobs', (c) => {
    allow(c, DEVICE_TOKEN);
    return c.json({ ok: true, jobs: room.x.jobs });
  });
  app.post('/ingest/counts', async (c) => {
    allow(c, DEVICE_TOKEN);
    ingestCounts(room, await body(c, IngestCountsBody));
    await done();
    return c.json(OK);
  });
  app.post('/ingest/picks', async (c) => {
    allow(c, DEVICE_TOKEN);
    const result = ingestPicks(room, await body(c, IngestPicksBody));
    await done();
    return c.json(result);
  });
  app.post('/ingest/reaches', async (c) => {
    allow(c, DEVICE_TOKEN);
    ingestReaches(room, await body(c, IngestReachesBody));
    await done();
    return c.json(OK);
  });
  app.post('/ingest/node', async (c) => {
    allow(c, DEVICE_TOKEN);
    const result = ingestNode(room, await body(c, IngestNodeBody));
    await done();
    return c.json(result);
  });
  app.post('/ingest/reorder', async (c) => {
    allow(c, DEVICE_TOKEN);
    ingestReorder(room, await body(c, IngestReorderBody));
    await done();
    return c.json(OK);
  });
  app.post('/ingest/runs', async (c) => {
    allow(c, DEVICE_TOKEN);
    ingestRuns(room, await body(c, IngestRunsBody));
    await done();
    return c.json(OK);
  });
  app.post('/ingest/quotes', async (c) => {
    allow(c, DEVICE_TOKEN);
    ingestQuotes(room, await body(c, IngestQuotesBody));
    await done();
    return c.json(OK);
  });
  app.post('/ingest/cart', async (c) => {
    allow(c, DEVICE_TOKEN);
    ingestCart(room, await body(c, IngestCartBody));
    await done();
    return c.json(OK);
  });
  app.post('/ingest/placed', async (c) => {
    allow(c, DEVICE_TOKEN);
    ingestPlaced(room, await body(c, IngestPlacedBody));
    await done();
    return c.json(OK);
  });

  // ---------- teaching ----------
  app.post('/api/teach', async (c) => {
    allow(c, DEVICE_TOKEN, OPS_TOKEN);
    const teach = await startTeach(room, await body(c, TeachBody));
    await done();
    return c.json(teach);
  });
  app.post('/api/teach/:id/confirm', async (c) => {
    allow(c, APPROVE_KEY, OPS_TOKEN);
    const product = confirmTeach(room, c.req.param('id'), await body(c, TeachConfirmBody));
    await done();
    return c.json(product);
  });
  app.post('/api/teach/:id/cancel', async (c) => {
    // The eye cancels too: it is the one that sees the part taken off the teach spot again.
    allow(c, APPROVE_KEY, OPS_TOKEN, DEVICE_TOKEN);
    await cancelTeach(room, c.req.param('id'));
    await done();
    return c.json(OK);
  });

  // ---------- orders ----------
  app.post('/api/orders', async (c) => {
    allow(c, OPS_TOKEN);
    const b = await body(c, ManualOrderBody);
    const order = openOrder(room, b.productId, 'manual', b.units);
    await done();
    return c.json(order);
  });
  app.post('/api/orders/:id/approve', async (c) => {
    allow(c, APPROVE_KEY, DEVICE_TOKEN, OPS_TOKEN);
    const b = await body(c, ApproveBody);
    const order = approve(room, c.req.param('id'), b.by);
    await done();
    return c.json(order);
  });
  app.post('/api/orders/:id/cancel', async (c) => {
    allow(c, OPS_TOKEN);
    const order = cancel(room, c.req.param('id'));
    await done();
    return c.json(order);
  });

  // ---------- count checks ----------
  app.post('/api/checks/:id', async (c) => {
    allow(c, APPROVE_KEY, OPS_TOKEN);
    const b = await body(c, CheckAnswerBody);
    answerCheck(room, c.req.param('id'), b.answer);
    await done();
    return c.json(OK);
  });

  // ---------- operator ----------
  app.put('/api/zones', async (c) => {
    allow(c, OPS_TOKEN);
    putZones(room, await body(c, ZonesBody));
    await done();
    return c.json(OK);
  });
  app.put('/api/board', async (c) => {
    allow(c, OPS_TOKEN);
    const snapshot = setBoard(room, await body(c, BoardBody));
    await done();
    return c.json(snapshot);
  });
  app.post('/api/demo/season', async (c) => {
    allow(c, OPS_TOKEN);
    setSeason(room, await body(c, Season));
    await done();
    return c.json(OK);
  });
  app.post('/api/demo/reset', async (c) => {
    allow(c, OPS_TOKEN);
    const snapshot = reset(room);
    await done();
    return c.json(snapshot);
  });
  app.post('/api/demo/screen', async (c) => {
    allow(c, OPS_TOKEN);
    setScreen(room, await body(c, ScreenBody));
    await done();
    return c.json(OK);
  });
  app.post('/api/demo/replay', async (c) => {
    allow(c, OPS_TOKEN);
    setReplay(room, await body(c, ReplayBody));
    await done();
    return c.json(OK);
  });

  // ---------- the store ----------
  app.post('/hooks/supply', async (c) => {
    if ((c.req.header('X-Offcut-Secret') ?? '') !== SUPPLY_WEBHOOK_SECRET) throw new Unauthorized('Missing or wrong store secret.');
    supplyWebhook(room, await body(c, SupplyWebhookBody));
    await done();
    return c.json(OK);
  });

  return app;
}
