// The buyer. A plain Node process on the laptop: it holds one socket to the hub and runs TinyFish agents for the jobs it is sent.
// Start it with: infisical run -- npm run start -w services/buyer
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supplier } from '@reup/contracts';
import WebSocket from 'ws';
import { TinyFishAgent, type Agent } from './agent';
import { configFrom, startupLines } from './config';
import { LocalAgent } from './dev/local-agent';
import { HubLink, type Socket } from './hub';
import { Buyer } from './jobs';
import { fileRecordings } from './recordings';
import type { Deps } from './runner';

const here = dirname(fileURLToPath(import.meta.url));
const config = configFrom(process.env, join(here, '..', 'recordings'));
for (const line of startupLines(config)) console.log(line);

let agent: Agent;
if (config.ENGINE === 'local') {
  agent = new LocalAgent(config.SUPPLY_URL, config.OFFCUT_EMAIL, config.OFFCUT_PASSWORD || 'dev-shop-password');
} else if (config.TINYFISH_API_KEY === '') {
  console.error('TINYFISH_API_KEY is not set. Run the buyer through Infisical, or use npm run start:local -w services/buyer for the development stand in.');
  process.exit(1);
} else {
  agent = TinyFishAgent.fromKey(config.TINYFISH_API_KEY);
}

const iso = (d: Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${get('timeZoneName').replace('GMT', '') || '+00:00'}`;
};

// eslint-disable-next-line prefer-const
let buyer: Buyer;
const link = new HubLink({
  hubUrl: config.HUB_URL,
  token: config.DEVICE_TOKEN,
  makeSocket: (url) => new WebSocket(url) as unknown as Socket,
  fetch,
  later: (fn, ms) => setTimeout(fn, ms),
  onJob: (job) => void buyer.handle(job),
  log: (line) => console.log(line),
});
const deps: Deps = {
  agent,
  recordings: fileRecordings(config.RECORDINGS_DIR),
  mirror: async (run) => void (await link.post('/ingest/runs', { run })),
  now: () => new Date(),
  iso,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  id: () => randomUUID().slice(0, 8),
};
// The enabled retailers in suppliers.json. The hub seeds its own list from the same file.
const listed = (JSON.parse(readFileSync(join(here, '..', 'suppliers.json'), 'utf8')) as { enabled?: boolean }[]).filter((s) => s.enabled).map((s) => Supplier.parse(s));
console.log(`Price checks: ${listed.map((s) => s.name).join(', ') || 'no retailer is enabled in suppliers.json'}`);
buyer = new Buyer(config, link, deps, fetch, console.log, listed);
link.connect();
setInterval(() => link.ping(), 20_000);
process.on('SIGINT', () => {
  link.stop();
  process.exit(0);
});
