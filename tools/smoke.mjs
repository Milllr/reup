// Walks the demo loop against a running stack (node tools/dev.mjs) and checks each beat.
// Usage: node tools/smoke.mjs [hub url]     exits 1 if any beat fails
// It plays the part of the camera and the wooden button, so stop the eye first: two cameras would argue. The buyer does its own work.
import WebSocket from 'ws';

const hub = (process.argv[2] ?? process.env.HUB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const device = { Authorization: `Bearer ${process.env.DEVICE_TOKEN ?? 'dev-device-token'}`, 'Content-Type': 'application/json' };
const ops = { Authorization: `Bearer ${process.env.OPS_TOKEN ?? 'dev-ops-token'}`, 'Content-Type': 'application/json' };
const post = (path, body, headers = device) => fetch(hub + path, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const state = () => fetch(`${hub}/api/state`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)} s`;
let failed = false;
function check(name, ok, detail = '') {
  console.log(`${at()}  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed = true;
}
async function until(name, test, seconds) {
  const end = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < end) {
    last = await state();
    const hit = test(last);
    if (hit) {
      check(name, true, typeof hit === 'string' ? hit : '');
      return last;
    }
    await sleep(250);
  }
  const o = last?.orders.at(-1);
  check(name, false, `still screen ${last?.screen}, order ${o ? `${o.state}${o.failure ? `: ${o.failure}` : ''}` : 'none'} after ${seconds} s`);
  return last;
}
const count = (n) => ({ productId: 'p-screws', zoneId: 'z-screws', count: n, level: null, pockets: Array.from({ length: 12 }, (_, i) => i < n), source: 'eye', ts: new Date().toISOString() });

const health = await fetch(`${hub}/api/health`).then((r) => r.ok, () => false);
if (!health) {
  console.error(`No hub at ${hub}. Start the stack first: node tools/dev.mjs`);
  process.exit(1);
}

// A screen, to hear what the TV hears.
const heard = [];
const screen = new WebSocket(`${hub.replace(/^http/, 'ws')}/live?role=screen`);
screen.on('message', (m) => heard.push(JSON.parse(String(m))));
await new Promise((res, rej) => { screen.on('open', res); screen.on('error', rej); });

await post('/api/demo/reset', undefined, ops);
await post('/ingest/counts', { counts: [count(6)] });
let s = await state();
check('See: the board starts with 6 boxes of screws and the buyer is online', s.counts.find((c) => c.productId === 'p-screws')?.count === 6 && s.buyerOnline === true, `buyer ${s.buyerOnline ? 'online' : 'offline'}`);
const policy = s.policies.find((p) => p.productId === 'p-screws');
check('The reorder point for screws is 4', policy?.reorderPoint === 4, `rate ${policy?.ratePerDay}`);

await post('/ingest/counts', { counts: [count(4)] });
s = await state();
check('Take: two boxes gone, the count is 4 and the Shelf holds the screen', s.counts.find((c) => c.productId === 'p-screws')?.count === 4 && s.screen === 'shelf');
// The judge changes their mind and puts both boxes back before anyone says yes.
const first = s.orders.at(-1);
await sleep(1200);
await post('/ingest/counts', { counts: [count(6)] });
s = await state();
check('Put back: the count is 6 again, the order is cancelled and the Shelf is back', s.counts.find((c) => c.productId === 'p-screws')?.count === 6 && s.orders.find((o) => o.id === first?.id)?.state === 'cancelled' && s.screen === 'shelf', s.activity.at(-1)?.text ?? '');
check('Nothing was bought for the cancelled order', !heard.some((m) => m.type === 'order' && m.order.id === first?.id && ['approved', 'placing', 'placed'].includes(m.order.state)));
// Then they take them after all.
await sleep(1200);
await post('/ingest/counts', { counts: [count(4)] });
s = await until('Take again: a new order opens, and the Shop screen follows', (x) => x.screen === 'shop' && x.orders.at(-1)?.id !== first?.id, 8);
const order = s.orders.at(-1);
s = await until('Shop: one retailer answers with a price', (x) => x.quotes.some((q) => q.ok) && `$${x.quotes.find((q) => q.ok).unitPrice}`, 30);
s = await until('Decide: the cart is ready and the order waits for a yes', (x) => x.orders.at(-1)?.state === 'awaiting_approval' && `${x.orders.at(-1).units} units, $${x.orders.at(-1).total}`, 45);
const waiting = s.orders.at(-1);
check('The order is 8 boxes for $67.71 with a reason', waiting?.units === 8 && waiting?.total === 67.71 && typeof waiting?.reason === 'string' && waiting.reason.length > 0, waiting?.reason ?? '');
check('The screen shows the order card', s.screen === 'order');
check('Nothing was placed before a yes', !heard.some((m) => m.type === 'order' && m.order.id === order.id && ['placing', 'placed'].includes(m.order.state)));

const yes = await post(`/api/orders/${order.id}/approve`, { by: 'button' });
check('Approve: the wooden button is accepted', yes.status === 200, `state ${yes.json?.state ?? yes.json?.order?.state ?? yes.status}`);
s = await until('Place: the store gives a confirmation number', (x) => ['placed', 'shipped'].includes(x.orders.at(-1)?.state) && x.orders.at(-1).confirmation, 45);
const placed = s.orders.at(-1);
check('The confirmation looks like OC-12345 and there is a delivery day', /^OC-\d+$/.test(placed?.confirmation ?? '') && placed?.eta != null, `eta ${placed?.eta}`);
s = await until('Track: the store says it shipped', (x) => x.orders.at(-1)?.state === 'shipped', 40);

const runs = s.runs.filter((r) => r.orderId === order.id || r.productId === 'p-screws');
const kinds = (k) => runs.some((r) => r.kind === k && r.steps.length > 0);
check('The cart run and the place run were mirrored with their steps', kinds('cart') && kinds('place'), runs.map((r) => `${r.kind}:${r.status}${r.replay ? ':replay' : ''}`).join(' '));
// The hub skips the price check when every retailer quote is under 10 minutes old.
console.log(`${at()}        price check: ${kinds('market') ? 'run for this order' : 'reused, the quotes were under 10 minutes old'}`);
const engines = [...new Set(runs.map((r) => r.engine ?? 'tinyfish'))].join(', ');
console.log(`${at()}        engine: ${engines}${engines.includes('local') ? '  (the development stand in, not the live web)' : ''}`);

// The delivery goes onto the board a few boxes at a time.
await post('/ingest/counts', { counts: [count(7)] });
s = await state();
check('Restock: 3 of 8 are in and the order is still on its way', s.orders.at(-1)?.unitsReceived === 3 && ['placed', 'shipped'].includes(s.orders.at(-1)?.state), `${s.orders.at(-1)?.unitsReceived} of ${s.orders.at(-1)?.units} in`);
await sleep(600);
await post('/ingest/counts', { counts: [count(12)] });
s = await until('Receive: all 8 are in and the order is done', (x) => x.orders.at(-1)?.state === 'received' && x.orders.at(-1)?.unitsReceived === 8, 10);
const reset = await post('/api/demo/reset', undefined, ops);
s = await state();
check('Reset: one call puts the demo back', reset.status === 200 && s.orders.length === 0 && s.screen === 'shelf');

screen.close();
console.log(failed ? 'The loop is broken. See FAIL above.' : 'The loop works.');
process.exit(failed ? 1 : 0);
