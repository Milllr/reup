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
    expect(order()).toMatchObject({ state: 'received', unitsReceived: 8 });
    expect(r.room.s.activity.slice(-2).map((a) => a.text)).toEqual(['8 boxes of wood screws arrived. 12 on the board.', 'All 8 boxes are in. Order RU-1042 is done.']);
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

  it('credits the node when its queued count opened the order a moment before its call arrived', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 6)] }, DEVICE);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
    expect(r.room.s.orders[0]).toMatchObject({ productId: 'p-screws', trigger: 'hub' });
    await r.call('POST', '/ingest/reorder', { id: 'ro-2', productId: 'p-screws', countAfter: 4, ts: r.room.iso() }, DEVICE);
    expect(r.room.s.orders).toHaveLength(1);
    expect(r.room.s.orders[0]?.trigger).toBe('node');
    expect(r.room.s.activity.some((a) => a.text === 'The shelf node called for this reorder while it was offline.')).toBe(true);
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

describe('restocking', () => {
  const used = (r: Awaited<ReturnType<typeof rig>>) => r.room.usageDay('p-screws', r.room.today());
  const put = (r: Awaited<ReturnType<typeof rig>>, n: number) => r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', n)] }, DEVICE);
  const texts = (r: Awaited<ReturnType<typeof rig>>, n: number) => r.room.s.activity.slice(-n).map((a) => a.text);

  it('cancels an order nobody has said yes to when the parts are put back above the reorder point', async () => {
    const r = await rig();
    const id = await toAwaiting(r);
    expect(r.room.order(id)?.state).toBe('awaiting_approval');
    r.advance(4000);
    await put(r, 6);
    expect(r.room.order(id)?.state).toBe('cancelled');
    expect(r.room.s.screen).toBe('shelf');
    expect(r.room.x.jobs.filter((j) => 'orderId' in j && j.orderId === id)).toEqual([]);
    expect(r.room.x.spend.total).toBe(0);
    expect(texts(r, 2)).toEqual(['2 boxes of wood screws put back. 6 on the board.', 'Wood screws are back above the reorder point. Order RU-1042 cancelled. Nothing was bought.']);
    // A yes that comes a moment too late buys nothing.
    expect((await r.call('POST', `/api/orders/${id}/approve`, { by: 'button' }, DEVICE)).status).toBe(409);
    // Taken again: a new order, with the next PO number.
    r.advance(4000);
    await put(r, 4);
    expect(r.room.s.orders.at(-1)).toMatchObject({ state: 'pricing', poNumber: 'RU-1043', units: 8 });
    // The first price check is still running, so the new order does not start a second one.
    expect(r.jobs().map((j) => j.kind)).toEqual(['market', 'cart', 'cart']);
    expect(r.room.x.jobs.map((j) => j.kind)).toEqual(['market', 'cart']);
  });

  it('cancels while the buyer is still shopping, and its late cart buys nothing', async () => {
    const r = await rig();
    await put(r, 4);
    const order = r.room.s.orders.at(-1);
    const cart = r.jobs().find((j) => j.kind === 'cart');
    expect(order?.state).toBe('pricing');
    await put(r, 6);
    expect(order?.state).toBe('cancelled');
    expect(r.room.s.screen).toBe('shelf');
    const late = await r.call('POST', '/ingest/cart', { jobId: cart?.id, orderId: order?.id, ok: true, packSize: 1, packs: 8, unitPrice: 7.49, total: 67.71, deliveryDays: 2, error: null }, DEVICE);
    expect(late.status).toBe(409);
    expect(order?.state).toBe('cancelled');
  });

  it('keeps the order when what was put back still leaves the part at the reorder point', async () => {
    const r = await rig();
    await put(r, 2);
    const id = r.room.s.orders.at(-1)?.id ?? '';
    expect(r.room.order(id)).toMatchObject({ state: 'pricing', units: 8 });
    r.advance(4000);
    await put(r, 4);
    expect(r.room.order(id)?.state).toBe('pricing');
    expect(r.room.s.orders).toHaveLength(1);
  });

  it('shops again when a put back means the order no longer fits on the board', async () => {
    const r = await rig();
    // A busy week: the reorder point is 5 and the order wants more than the board has room for.
    await r.call('POST', '/api/demo/season', { factor: 1.4, label: 'Busy' }, OPS);
    expect(r.room.policy('p-screws')?.reorderPoint).toBe(5);
    await put(r, 2);
    const first = r.room.s.orders.at(-1);
    expect(first).toMatchObject({ state: 'pricing', units: 10 });
    r.advance(4000);
    await put(r, 4);
    expect(first?.state).toBe('cancelled');
    const again = r.room.s.orders.at(-1);
    expect(again).toMatchObject({ state: 'pricing', units: 8, poNumber: 'RU-1043' });
    expect(r.room.s.activity.some((a) => a.text === 'The count of wood screws changed. Order RU-1042 cancelled. Nothing was bought.')).toBe(true);
  });

  it('counts a delivery in as it arrives, and is done only when all of it is in', async () => {
    const r = await rig();
    const id = await toAwaiting(r);
    await r.call('POST', `/api/orders/${id}/approve`, { by: 'button' }, DEVICE);
    await r.call('POST', '/ingest/placed', { jobId: 'j', orderId: id, ok: true, confirmation: 'OC-1', eta: null, error: null }, DEVICE);
    expect(r.room.order(id)).toMatchObject({ state: 'placed', unitsReceived: 0 });
    // The judge's two boxes go back. That is not the delivery of 8.
    r.advance(5000);
    await put(r, 6);
    expect(r.room.order(id)).toMatchObject({ state: 'placed', unitsReceived: 2 });
    expect(texts(r, 1)).toEqual(['2 boxes of wood screws arrived. 6 on the board.']);
    // The box arrives and goes in a few at a time.
    r.advance(5000);
    await put(r, 9);
    expect(r.room.order(id)).toMatchObject({ state: 'placed', unitsReceived: 5 });
    r.advance(5000);
    await put(r, 12);
    expect(r.room.order(id)).toMatchObject({ state: 'received', unitsReceived: 8 });
    expect(texts(r, 1)).toEqual(['All 8 boxes are in. Order RU-1042 is done.']);
    expect(r.room.x.deliveries).toEqual({});
    // Nothing that arrived counts as use, and nothing came off the use either.
    expect(used(r)).toMatchObject({ used: 2, restocked: 8 });
  });

  it('measures a delivery from the lowest count, so a box taken while waiting does not hide it', async () => {
    const r = await rig();
    const id = await toAwaiting(r);
    await r.call('POST', `/api/orders/${id}/approve`, { by: 'button' }, DEVICE);
    await r.call('POST', '/ingest/placed', { jobId: 'j', orderId: id, ok: true, confirmation: 'OC-1', eta: null, error: null }, DEVICE);
    r.advance(5000);
    await put(r, 3);
    expect(r.room.order(id)).toMatchObject({ state: 'placed', unitsReceived: 0 });
    expect(r.room.s.orders).toHaveLength(1);
    r.advance(5000);
    await put(r, 10);
    expect(r.room.order(id)).toMatchObject({ state: 'placed', unitsReceived: 7 });
    r.advance(5000);
    await put(r, 11);
    expect(r.room.order(id)?.state).toBe('received');
  });

  it('is done when the board is full, even if fewer came in than were ordered', async () => {
    const r = await rig();
    const id = await toAwaiting(r);
    await r.call('POST', `/api/orders/${id}/approve`, { by: 'button' }, DEVICE);
    r.advance(5000);
    await put(r, 6); // put back while the buyer was placing it: before it is placed, so not part of the delivery
    await r.call('POST', '/ingest/placed', { jobId: 'j', orderId: id, ok: true, confirmation: 'OC-1', eta: null, error: null }, DEVICE);
    r.advance(5000);
    await put(r, 12);
    expect(r.room.order(id)).toMatchObject({ state: 'received', unitsReceived: 6 });
    expect(texts(r, 1)).toEqual(['The board is full. Order RU-1042 is done.']);
  });

  it('does not count parts as used when they are put straight back', async () => {
    const r = await rig();
    await put(r, 6);
    r.advance(1000);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-brackets', 3)] }, DEVICE);
    const brackets = () => r.room.usageDay('p-brackets', r.room.today());
    expect(brackets()).toMatchObject({ used: 2, restocked: 0 });
    r.advance(60_000);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-brackets', 5)] }, DEVICE);
    expect(brackets()).toMatchObject({ used: 0, restocked: 0 });
    expect(texts(r, 1)).toEqual(['2 bags of corner brackets put back. 5 on the board.']);
    // One more than was taken: that one came from somewhere else.
    r.advance(60_000);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-brackets', 6)] }, DEVICE);
    expect(brackets()).toMatchObject({ used: 0, restocked: 1 });
    expect(texts(r, 1)).toEqual(['1 bag of corner brackets added. 6 on the board.']);
  });

  it('treats parts that come back much later as a restock, not as never used', async () => {
    const r = await rig();
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-brackets', 4)] }, DEVICE);
    r.advance(11 * 60_000);
    await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-brackets', 5)] }, DEVICE);
    expect(r.room.usageDay('p-brackets', r.room.today())).toMatchObject({ used: 1, restocked: 1 });
    expect(texts(r, 1)).toEqual(['1 bag of corner brackets added. 5 on the board.']);
  });

  it('ignores a reorder call from the node when the hub has since seen the parts put back', async () => {
    const r = await rig();
    const called = r.room.iso();
    r.advance(30_000);
    await put(r, 6);
    await r.call('POST', '/ingest/reorder', { id: 'ro-late', productId: 'p-screws', countAfter: 4, ts: called }, DEVICE);
    expect(r.room.s.orders).toHaveLength(0);
  });

  describe('an order the buyer never finishes', () => {
    const cartRun = (r: Awaited<ReturnType<typeof rig>>, id: string, steps = 0) => ({ id: 'r-1', tinyfishRunId: 'tf', kind: 'cart', supplierId: 's-offcut', productId: 'p-screws', orderId: id, status: 'running', streamingUrl: null, steps: Array.from({ length: steps }, () => ({ ts: r.room.iso(), purpose: 'Looking for the part.' })), replay: false, error: null, startedAt: r.room.iso(), finishedAt: null });

    it('fails after 45 seconds when no buyer is connected, and the Shelf comes back', async () => {
      const r = await rig();
      await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
      const id = r.room.s.orders[0]?.id ?? '';
      r.advance(2600);
      expect(r.room.s.screen).toBe('shop');
      expect(r.room.nextDeadline()).toBe(r.clock.now - 2600 + 45_001);
      r.advance(42_000);
      expect(r.room.order(id)?.state).toBe('pricing');
      r.advance(500);
      expect(r.room.order(id)).toMatchObject({ state: 'failed', error: 'The buyer is offline. Nothing was bought.' });
      expect(r.of('order').at(-1)?.order.state).toBe('failed');
      expect(r.room.s.activity.at(-1)).toMatchObject({ tone: 'error', text: 'The buyer is offline. Nothing was bought.' });
      expect(r.room.x.jobs.filter((j) => 'orderId' in j && j.orderId === id)).toEqual([]);
      // The failed order keeps the Order screen for 20 seconds, then the Shelf is back.
      expect(r.room.s.screen).toBe('order');
      r.advance(20_100);
      expect(r.room.s.screen).toBe('shelf');
      // The count is still low, and no second order opens by itself.
      r.advance(600_000);
      expect(r.room.s.orders).toHaveLength(1);
    });

    it('waits as long as the buyer keeps reporting, and fails after 6 minutes of silence', async () => {
      const r = await rig();
      r.room.setBuyerOnline(true);
      await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
      const id = r.room.s.orders[0]?.id ?? '';
      // A price check for the same part is a word from the buyer too, while the order is still pricing.
      r.advance(300_000);
      await r.call('POST', '/ingest/runs', { run: { ...cartRun(r, id), id: 'r-0', kind: 'market', supplierId: 's-market-a', orderId: null } }, DEVICE);
      r.advance(300_000);
      expect(r.room.order(id)?.state).toBe('pricing');
      for (let step = 1; step <= 4; step++) {
        r.advance(50_000);
        await r.call('POST', '/ingest/runs', { run: cartRun(r, id, step) }, DEVICE);
        r.advance(300_000);
      }
      expect(r.room.order(id)?.state).toBe('carting');
      r.advance(59_000);
      expect(r.room.order(id)?.state).toBe('carting');
      r.advance(1500);
      expect(r.room.order(id)).toMatchObject({ state: 'failed', error: 'The buyer stopped answering. Nothing was bought.' });
    });

    it('a buyer that drops off while it still reports is given the time, and one that comes back in time loses nothing', async () => {
      const r = await rig();
      r.room.setBuyerOnline(true);
      await r.call('POST', '/ingest/counts', { counts: [count(r, 'z-screws', 4)] }, DEVICE);
      const id = r.room.s.orders[0]?.id ?? '';
      r.advance(100_000);
      r.room.setBuyerOnline(false);
      r.advance(40_000);
      await r.call('POST', '/ingest/runs', { run: cartRun(r, id, 1) }, DEVICE); // its socket is down, its run goes on
      r.advance(40_000);
      expect(r.room.order(id)?.state).toBe('carting');
      r.room.setBuyerOnline(true);
      r.advance(300_000);
      expect(r.room.order(id)?.state).toBe('carting');
    });

    it('an order waiting for a yes waits for good', async () => {
      const r = await rig();
      const id = await toAwaiting(r);
      r.advance(3_600_000);
      expect(r.room.order(id)?.state).toBe('awaiting_approval');
      expect(r.room.s.screen).toBe('order');
    });

    it('after the yes the words say to check the store, and the store or a late report still marks it placed', async () => {
      const r = await rig();
      const id = await toAwaiting(r);
      await r.call('POST', `/api/orders/${id}/approve`, { by: 'button' }, APPROVE);
      r.advance(44_000);
      expect(r.room.order(id)?.state).toBe('approved');
      r.advance(1500);
      expect(r.room.order(id)).toMatchObject({ state: 'failed', error: 'The buyer is offline while the order was being placed. Check the store before ordering again.' });
      const late = await r.call('POST', '/ingest/placed', { jobId: 'j', orderId: id, ok: true, confirmation: 'OC-58213', eta: null, error: null }, DEVICE);
      expect(late.status).toBe(200);
      expect(r.room.order(id)).toMatchObject({ state: 'placed', confirmation: 'OC-58213', error: null });

      // The same through the store's webhook. An order that failed before its yes stays failed.
      const p = await rig();
      const id2 = await toAwaiting(p);
      await p.call('POST', `/api/orders/${id2}/approve`, { by: 'phone' }, APPROVE);
      p.advance(46_000);
      expect(p.room.order(id2)?.state).toBe('failed');
      const hook = (q: Awaited<ReturnType<typeof rig>>) => q.call('POST', '/hooks/supply', { event: 'order.confirmed', confirmation: 'OC-7', poNumber: 'RU-1042', eta: '2026-11-24T17:00:00-05:00' }, undefined, { 'X-Offcut-Secret': 'dev-supply-secret' });
      expect((await hook(p)).status).toBe(200);
      expect(p.room.order(id2)).toMatchObject({ state: 'placed', confirmation: 'OC-7', error: null });

      const q = await rig();
      await q.call('POST', '/ingest/counts', { counts: [count(q, 'z-screws', 4)] }, DEVICE);
      q.advance(46_000);
      expect(q.room.s.orders[0]?.state).toBe('failed');
      await hook(q);
      expect(q.room.s.orders[0]?.state).toBe('failed');
    });
  });
});
