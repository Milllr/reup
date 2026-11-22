// Sets up the station on a hub: every zone and every part, from one file.
// Usage: node tools/board.mjs [hub url] [board file]     the file defaults to contracts/mocks/board.json, the station as built
// It replaces the zones and the parts, cancels open orders and clears the demo. Counts come back from the eye within a few seconds.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hub = (process.argv[2] ?? process.env.HUB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const file = process.argv[3] ?? path.join(root, 'contracts', 'mocks', 'board.json');
const board = JSON.parse(readFileSync(file, 'utf8'));

const res = await fetch(`${hub}/api/board`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${process.env.OPS_TOKEN ?? 'dev-ops-token'}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(board),
}).catch((err) => ({ ok: false, status: 0, json: async () => ({ message: String(err.cause ?? err) }) }));
const body = await res.json().catch(() => null);
if (!res.ok) {
  console.error(`The hub at ${hub} did not take the board: ${res.status} ${body?.message ?? ''}`);
  process.exit(1);
}
console.log(`Board set on ${hub}.`);
for (const zone of body.zones) {
  const part = body.products.find((p) => p.id === zone.productId);
  console.log(`  ${zone.id.padEnd(12)} ${zone.camera.padEnd(6)} ${part ? `${part.name}, ${part.capacity == null ? 'holds what is stocked' : `holds ${part.capacity}`}` : 'no part yet'}`);
}
