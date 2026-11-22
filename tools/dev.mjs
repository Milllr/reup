// The whole loop on one laptop: the hub (with the built web app), Offcut Supply and the buyer.
// Usage: node tools/dev.mjs            local stand in for TinyFish, nothing leaves the laptop
//        infisical run -- node tools/dev.mjs                the same, and the hub names new parts with Gemini
//        infisical run -- node tools/dev.mjs --tinyfish     the real buyer, on the live web
// Flags: --no-build skips the web build, --no-buyer leaves the buyer off, --ship-ms=5000 sets the store's shipping delay.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const flag = (name, fallback) => [...args].find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;

function portFromEnvLocal() {
  const file = join(root, '.env.local');
  if (!existsSync(file)) return null;
  const m = /^PORT=(\d+)/m.exec(readFileSync(file, 'utf8'));
  return m ? Number(m[1]) : null;
}
const hubPort = Number(process.env.PORT ?? portFromEnvLocal() ?? 3000);
const storePort = hubPort + 1;
const hubUrl = `http://localhost:${hubPort}`;
const storeUrl = `http://localhost:${storePort}`;

function once(label, command, cwd) {
  console.log(`[${label}] ${command}`);
  const r = spawnSync(command, { cwd, shell: true, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[${label}] failed. Stopping.`);
    process.exit(r.status ?? 1);
  }
}

const children = [];
function keep(label, command, cwd, env = {}) {
  const child = spawn(command, { cwd, shell: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const print = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim() !== '') console.log(`[${label}] ${line}`);
  };
  child.stdout.on('data', print);
  child.stderr.on('data', print);
  child.on('exit', (code) => console.log(`[${label}] stopped${code ? ` with code ${code}` : ''}.`));
  children.push(child);
}
function stop() {
  for (const child of children) child.kill();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function up(url, label) {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`[${label}] did not answer at ${url} within 90 seconds.`);
  stop();
}

if (!args.has('--no-build')) once('web', 'npm run build -w apps/web', root);
once('hub', 'npx wrangler d1 migrations apply reup-hub --local', join(root, 'apps', 'hub'));
once('store', 'npx wrangler d1 migrations apply offcut-supply --local', join(root, 'apps', 'supply'));

// Each wrangler gets its own inspector port. Two on the default port is an 'address already in use' error.
// Under infisical run the hub gets the Gemini key, so a new part is named on a laptop too. Without it a typed name works.
const gemini = /^[\w-]+$/.test(process.env.GEMINI_API_KEY ?? '') ? ` --var GEMINI_API_KEY:${process.env.GEMINI_API_KEY}` : '';
keep('hub', `npx wrangler dev --port ${hubPort} --inspector-port ${hubPort + 6229} --var SUPPLY_URL:${storeUrl}${gemini}`, join(root, 'apps', 'hub'));
keep('store', `npx wrangler dev --port ${storePort} --inspector-port ${storePort + 6229} --var HUB_URL:${hubUrl} --var SHIP_DELAY_MS:${flag('ship-ms', '20000')}`, join(root, 'apps', 'supply'));
await Promise.all([up(`${hubUrl}/api/health`, 'hub'), up(`${storeUrl}/catalog.json`, 'store')]);

if (!args.has('--no-buyer')) {
  const real = args.has('--tinyfish');
  keep('buyer', 'npx tsx src/index.ts', join(root, 'services', 'buyer'), { HUB_URL: hubUrl, SUPPLY_URL: storeUrl, BUYER_ENGINE: real ? 'tinyfish' : 'local' });
}

console.log('');
console.log(`TV:        ${hubUrl}/`);
console.log(`Phone:     ${hubUrl}/m`);
console.log(`Operator:  ${hubUrl}/ops   (token: dev-ops-token)`);
console.log(`Store:     ${storeUrl}/`);
console.log('Walk the loop with: node tools/smoke.mjs');
console.log('Stop with Ctrl C.');
