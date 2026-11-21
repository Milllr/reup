// The hub's Worker. API, ingest, webhook and socket requests go to the one Room. Everything else is the web app.
import { Room, type Env } from './room-do';

export { Room };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (/^\/(api|ingest|hooks|live)(\/|$)/.test(url.pathname)) {
      return env.ROOM.get(env.ROOM.idFromName('main')).fetch(request);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('reup hub. The web app is not built yet: run npm run build -w apps/web.', { status: 200 });
  },
} satisfies ExportedHandler<Env>;
