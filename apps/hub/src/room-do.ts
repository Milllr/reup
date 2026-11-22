// The Durable Object: one Room for the whole demo space. It gives the logic in core/room.ts its sockets,
// its storage, its alarm and its D1 log. WebSockets use the hibernation API, so an idle Room costs nothing.
import type { ServerMessage } from '@reup/contracts';
import { DurableObject } from 'cloudflare:workers';
import type { Hono } from 'hono';
import { createApp } from './app';
import { configFrom } from './config';
import { RoomCore, type Audience, type Role } from './core/room';
import { D1History, noHistory } from './history';
import { GeminiAsker } from './ask/gemini';
import { GeminiNamer } from './teach/gemini';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  DB?: D1Database;
  ASSETS?: Fetcher;
  [key: string]: unknown;
}

export class Room extends DurableObject<Env> {
  private core: RoomCore;
  private app: Hono;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = configFrom(env);
    this.core = new RoomCore(config, {
      store: {
        get: (key) => ctx.storage.get(key),
        put: (key, value) => ctx.storage.put(key, value),
        delete: async (key) => {
          await ctx.storage.delete(key);
        },
      },
      history: env.DB ? new D1History(env.DB, (p) => ctx.waitUntil(p)) : noHistory,
      send: (msg, to) => this.broadcast(msg, to),
      waitUntil: (p) => ctx.waitUntil(p),
      namer: config.GEMINI_API_KEY ? new GeminiNamer(config.GEMINI_API_KEY, config.GEMINI_MODEL) : undefined,
      asker: config.GEMINI_API_KEY ? new GeminiAsker(config.GEMINI_API_KEY, config.GEMINI_MODEL) : undefined,
    });
    this.app = createApp(this.core, { after: () => this.settle() });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    void ctx.blockConcurrencyWhile(async () => {
      await this.core.load();
      this.core.s.buyerOnline = ctx.getWebSockets('buyer').length > 0;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/live') return this.live(request, url);
    return this.app.fetch(request);
  }

  private live(request: Request, url: URL): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
    let role = (url.searchParams.get('role') ?? 'screen') as Role;
    if (role !== 'ops' && role !== 'buyer') role = 'screen';
    // Only a buyer that knows the device token gets jobs.
    if (role === 'buyer' && url.searchParams.get('token') !== this.core.config.DEVICE_TOKEN) return new Response('Wrong token.', { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [role]);
    server.send(JSON.stringify({ type: 'snapshot', snapshot: this.core.snapshot() } satisfies ServerMessage));
    if (role === 'buyer') {
      this.core.setBuyerOnline(true);
      this.ctx.waitUntil(this.settle());
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === 'string' && message.includes('"ping"')) ws.send('{"type":"pong"}');
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }

  private async left(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      // already closed
    }
    const buyers = this.ctx.getWebSockets('buyer').filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
    if (buyers.length === 0 && this.core.s.buyerOnline) {
      this.core.setBuyerOnline(false);
      await this.settle();
    }
  }

  override async alarm(): Promise<void> {
    this.core.tick();
    await this.settle();
  }

  private broadcast(msg: ServerMessage, to: Audience): void {
    const data = JSON.stringify(msg);
    for (const ws of to === 'buyer' ? this.ctx.getWebSockets('buyer') : this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // a socket that went away is cleaned up by its close event
      }
    }
  }

  /** Save, and wake up when time next matters (node heartbeat, screen hold, disagreement). */
  private async settle(): Promise<void> {
    await this.core.save();
    const next = this.core.nextDeadline();
    if (next != null) await this.ctx.storage.setAlarm(next);
  }
}
