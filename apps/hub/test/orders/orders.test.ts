import { ApiError, JobsResult, Order } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import { APPROVE, count, DEVICE, OPS, rig, toAwaiting } from '../helpers';

describe('orders', () => {
  it('opens one order at the reorder point, and not another while it is open', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 5)] }, DEVICE);
    expect(r.room.s.orders).toHaveLength(0);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 3)] }, DEVICE);
    expect(r.room.s.orders).toHaveLength(1);
    const order = Order.parse(r.room.s.orders[0]);
    expect(order).toMatchObject({ state: 'pricing', units: 8, poNumber: 'RU-1042', trigger: 'hub', reason: '8 boxes fills the board and arrives before it runs out.' });
    expect(r.jobs().map((j) => j.kind)).toEqual(['market', 'cart']);
    expect(r.jobs()[1]).toMatchObject({ kind: 'cart', orderId: order.id, sku: 'OC-1008-114', units: 8 });
    // The Shelf keeps the screen for a beat so the drop is seen, then Shop takes over.
    expect(r.room.s.screen).toBe('shelf');
    expect(r.room.nextDeadline()).toBe(r.clock.now + 2501);
    r.advance(2600);
    expect(r.room.s).toMatchObject({ screen: 'shop', focusProductId: 'p-screws' });
    expect(r.room.s.activity.map((a) => a.text)).toContain('Wood screws are at the reorder point.');
    expect(r.room.s.activity.map((a) => a.text)).toContain('Checking 2 retailers and filling a cart at Offcut Supply.');
  });

  it('skips the market job when every market quote is under 10 minutes old', async () => {
    const r = await rig();
    const q = (supplierId: string) => ({ id: `q-${supplierId}`, productId: 'p-screws', supplierId, listingName: 'x', packSize: 1, price: 8.69, currency: 'CAD', unitPrice: 8.69, inStock: true, deliveryDays: 3, url: null, runId: null, ok: true, fetchedAt: r.room.iso() });
    await r.call('POST', '/ingest/quotes', { jobId: 'j-0', quotes: [q('s-market-a'), q('s-market-b')] }, DEVICE);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    expect(r.jobs().map((j) => j.kind)).toEqual(['cart']);
  });

  it('walks the happy path through every state', async () => {
    const r = await rig();
    const id = await toAwaiting(r);
    const order = () => r.room.order(id);
    expect(r.of('order').map((m) => m.order.state)).toEqual(['pricing', 'awaiting_approval']);
    expect(order()).toMatchObject({ state: 'awaiting_approval', unitPrice: 7.49, total: 67.71, packs: 8 });
    expect(order()?.eta).toMatch(/^2026-11-24T/); // Saturday plus 2 business days is Tuesday
    expect(r.room.s.screen).toBe('order');

    const run = { id: 'r-9', tinyfishRunId: null, kind: 'place', supplierId: 's-offcut', productId: 'p-screws', orderId: id, status: 'running', streamingUrl: null, steps: [], replay: false, error: null, startedAt: r.room.iso(), finishedAt: null };
    const approved = await r.call('POST', `/api/orders/${id}/approve`, { by: 'button' }, DEVICE);
    expect(Order.parse(await approved.json())).toMatchObject({ state: 'approved', approvedBy: 'button' });
    const place = r.jobs().find((j) => j.kind === 'place');
    expect(place).toMatchObject({ orderId: id, poNumber: 'RU-1042' });
    await r.call('POST', '/ingest/runs', { run }, DEVICE);
    expect(order()?.state).toBe('placing');

    const jobs = JobsResult.parse(await (await r.call('GET', '/api/jobs', undefined, DEVICE)).json());
    expect(jobs.jobs.map((j) => j.kind)).toEqual(['market', 'place']);

    await r.call('POST', '/ingest/placed', { jobId: place?.id, orderId: id, ok: true, confirmation: 'OC-58213', eta: '2026-11-24T17:00:00-05:00', error: null }, DEVICE);
    expect(order()).toMatchObject({ state: 'placed', confirmation: 'OC-58213' });
    expect(r.room.s.activity.at(-1)?.text).toBe('Ordered. Confirmation OC-58213. Arrives Tuesday.');
    expect(r.room.x.jobs.map((j) => j.kind)).toEqual(['market']);

    // The delivery lands back on the board.
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 12)] }, DEVICE);
    expect(order()?.state).toBe('received');
    expect(r.room.s.activity.at(-1)?.text).toBe('8 boxes of wood screws #8 x 1-1/4 in arrived. Order RU-1042 is done.');
  });

  it('moves pricing to carting when the cart run starts, and writes the market note when a quote lands', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    const id = r.room.s.orders[0]?.id ?? '';
    const run = { id: 'r-1', tinyfishRunId: 'tf', kind: 'cart', supplierId: 's-offcut', productId: 'p-screws', orderId: id, status: 'running', streamingUrl: 'https://tf.example.com/live/1', steps: [], replay: false, error: null, startedAt: r.room.iso(), finishedAt: null };
    await r.call('POST', '/ingest/runs', { run }, DEVICE);
    expect(r.room.order(id)?.state).toBe('carting');
    expect(r.room.s.runs).toHaveLength(1);
    const cart = r.jobs().find((j) => j.kind === 'cart');
    await r.call('POST', '/ingest/cart', { jobId: cart?.id, orderId: id, ok: true, packSize: 1, packs: 8, unitPrice: 7.49, total: 67.71, deliveryDays: 2, error: null }, DEVICE);
    expect(r.room.order(id)?.marketNote).toBeNull();
    const quote = { id: 'q-a', productId: 'p-screws', supplierId: 's-market-a', listingName: 'x', packSize: 1, price: 8.69, currency: 'CAD', unitPrice: 8.69, inStock: true, deliveryDays: 3, url: null, runId: 'r-2', ok: true, fetchedAt: r.room.iso() };
    await r.call('POST', '/ingest/quotes', { jobId: r.jobs()[0]?.id, quotes: [quote] }, DEVICE);
    expect(r.room.order(id)?.marketNote).toBe('Home Hardware is $1.20 more per box.');
  });

  it('answers 409 when approving in the wrong state, 404 for an unknown order, 401 without a key', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    const id = r.room.s.orders[0]?.id;
    const res = await r.call('POST', `/api/orders/${id}/approve`, { by: 'phone' }, APPROVE);
    expect(res.status).toBe(409);
    expect(ApiError.parse(await res.json()).code).toBe('conflict');
    expect((await r.call('POST', '/api/orders/o-404/approve', { by: 'phone' }, APPROVE)).status).toBe(404);
    expect((await r.call('POST', `/api/orders/${id}/approve`, { by: 'phone' })).status).toBe(401);
  });

  it('fails an order over the order cap or the day cap before any place job is sent', async () => {
    const r = await rig();
    const id = await toAwaiting(r, 180);
    await r.call('POST', `/api/orders/${id}/approve`, { by: 'phone' }, APPROVE);
    expect(r.room.order(id)).toMatchObject({ state: 'failed', error: '$180.00 is over the spend cap of $150 an order. Nothing was bought.' });
    expect(r.jobs().some((j) => j.kind === 'place')).toBe(false);

    const d = await rig({ DAY_CAP_CAD: 100 });
    d.room.x.spend = { day: d.room.today(), total: 60 };
    const id2 = await toAwaiting(d, 67.71);
    await d.call('POST', `/api/orders/${id2}/approve`, { by: 'phone' }, APPROVE);
    expect(d.room.order(id2)?.error).toBe('This order would pass the spend cap of $100 a day. Nothing was bought.');
  });

  it('fails cleanly when the cart or the place run fails', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    const id = r.room.s.orders[0]?.id ?? '';
    await r.call('POST', '/ingest/cart', { jobId: 'j', orderId: id, ok: false, packSize: null, packs: null, unitPrice: null, total: null, deliveryDays: null, error: 'The item is out of stock.' }, DEVICE);
    expect(r.room.order(id)).toMatchObject({ state: 'failed', error: 'Could not fill the cart: The item is out of stock. Nothing was bought.' });
    expect(r.room.s.screen).toBe('order');

    const p = await rig();
    const id2 = await toAwaiting(p);
    await p.call('POST', `/api/orders/${id2}/approve`, { by: 'button' }, DEVICE);
    await p.call('POST', '/ingest/placed', { jobId: 'j', orderId: id2, ok: false, confirmation: null, eta: null, error: null }, DEVICE);
    expect(p.room.order(id2)).toMatchObject({ state: 'failed', error: 'Could not place the order. Nothing was bought.' });
    // A failed order does not block the next one.
    await p.call('POST', '/ingest/counts', { counts: [count(p, 'z-screws', 3)] }, DEVICE);
    expect(p.room.s.orders).toHaveLength(2);
  });

  it('moves the screen with the order, holds it 20 seconds after placed, and obeys the override', async () => {
    const r = await rig();
    expect(r.room.s.screen).toBe('shelf');
    const id = await toAwaiting(r);
    expect(r.of('screen').map((m) => m.screen)).toEqual(['shop', 'order']);
    await r.call('POST', `/api/orders/${id}/approve`, { by: 'button' }, DEVICE);
    await r.call('POST', '/ingest/placed', { jobId: 'j', orderId: id, ok: true, confirmation: 'OC-1', eta: null, error: null }, DEVICE);
    r.advance(19_000);
    expect(r.room.s.screen).toBe('order');
    r.advance(1_500);
    expect(r.room.s).toMatchObject({ screen: 'shelf', focusProductId: null });

    await r.call('POST', '/api/demo/screen', { screen: 'why', focusProductId: 'p-screws' }, OPS);
    expect(r.room.s).toMatchObject({ screen: 'why', focusProductId: 'p-screws' });
    await r.call('POST', '/api/demo/screen', { screen: null, focusProductId: null }, OPS);
    expect(r.room.s.screen).toBe('shelf');
  });

  it('opens an order the node called for while offline, once', async () => {
    const r = await rig();
    const body = { id: 'ro-1', productId: 'p-brackets', countAfter: 2, ts: r.room.iso() };
    await r.call('POST', '/ingest/reorder', body, DEVICE);
    await r.call('POST', '/ingest/reorder', body, DEVICE);
    expect(r.room.s.orders).toHaveLength(1);
    expect(r.room.s.orders[0]).toMatchObject({ productId: 'p-brackets', trigger: 'node' });
  });

  it('starts an order by hand and cancels it; a placed order cannot be cancelled', async () => {
    const r = await rig();
    const made = await r.call('POST', '/api/orders', { productId: 'p-glue', units: 2 }, OPS);
    const order = Order.parse(await made.json());
    expect(order).toMatchObject({ trigger: 'manual', units: 2, reason: '2 units fills the board and arrives before it runs out.' });
    expect((await r.call('POST', '/api/orders', { productId: 'p-glue' }, OPS)).status).toBe(409);
    expect((await r.call('POST', '/api/orders', { productId: 'p-glue' }, DEVICE)).status).toBe(401);
    const cancelled = Order.parse(await (await r.call('POST', `/api/orders/${order.id}/cancel`, undefined, OPS)).json());
    expect(cancelled.state).toBe('cancelled');
    expect(r.room.x.jobs.filter((j) => 'orderId' in j && j.orderId === order.id)).toHaveLength(0);

    const p = await rig();
    const id = await toAwaiting(p);
    await p.call('POST', `/api/orders/${id}/approve`, { by: 'button' }, DEVICE);
    await p.call('POST', '/ingest/placed', { jobId: 'j', orderId: id, ok: true, confirmation: 'OC-1', eta: null, error: null }, DEVICE);
    expect((await p.call('POST', `/api/orders/${id}/cancel`, undefined, OPS)).status).toBe(409);
  });
});
