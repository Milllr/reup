import { SupplyWebhookBody } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../src/lib/config';
import { sendWebhook, shipDue, webhookBody } from '../../src/webhook';
import { rig, signedIn } from '../helpers';

const body: SupplyWebhookBody = { event: 'order.confirmed', confirmation: 'OC-58213', poNumber: 'RU-1042', eta: '2026-11-24T17:00:00-05:00' };
const noSleep = async () => {};

async function withOrder() {
  const r = rig();
  const b = await signedIn(r);
  await b.post('/cart', { sku: 'OC-1008-114', pack: '0', qty: '8' });
  await b.post('/checkout', { po: 'RU-1042' });
  const [order] = await r.shop.orders();
  if (!order) throw new Error('no order');
  return { r, b, order };
}

describe('the webhook', () => {
  it('sends a valid SupplyWebhookBody with the secret', async () => {
    const calls: { url: string; secret: string | null; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, secret: new Headers(init.headers).get('X-Offcut-Secret'), body: JSON.parse(String(init.body)) });
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;
    expect(await sendWebhook(DEFAULTS, body, fetcher, noSleep)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'http://localhost:3000/hooks/supply', secret: 'dev-supply-secret' });
    expect(SupplyWebhookBody.parse(calls[0]?.body)).toEqual(body);
  });

  it('retries 3 times on a 500 or a network error, and stops on a 404', async () => {
    let n = 0;
    const flaky = (async () => {
      n += 1;
      if (n === 1) throw new Error('network');
      return new Response('', { status: n < 4 ? 500 : 200 });
    }) as unknown as typeof fetch;
    expect(await sendWebhook(DEFAULTS, body, flaky, noSleep)).toBe(true);
    expect(n).toBe(4);
    let down = 0;
    expect(await sendWebhook(DEFAULTS, body, (async () => (down++, new Response('', { status: 500 }))) as unknown as typeof fetch, noSleep)).toBe(false);
    expect(down).toBe(4);
    let unknown = 0;
    expect(await sendWebhook(DEFAULTS, body, (async () => (unknown++, new Response('', { status: 404 }))) as unknown as typeof fetch, noSleep)).toBe(false);
    expect(unknown).toBe(1);
  });

  it('ships an order when its 20 seconds are up, once, and tells the hub with the delivery date', async () => {
    const { r, order } = await withOrder();
    const sent: SupplyWebhookBody[] = [];
    const notify = async (b: SupplyWebhookBody) => void sent.push(b);
    const pending = [{ confirmation: order.confirmation, dueAt: 20_000 }];
    expect(await shipDue(r.shop, pending, 19_000, notify)).toEqual(pending);
    expect(sent).toHaveLength(0);
    expect(await shipDue(r.shop, pending, 20_000, notify)).toEqual([]);
    await shipDue(r.shop, pending, 30_000, notify);
    expect(sent).toEqual([{ event: 'order.shipped', confirmation: order.confirmation, poNumber: 'RU-1042', eta: '2026-11-24T17:00:00-05:00' }]);
    expect((await r.shop.order(order.confirmation))?.status).toBe('Shipped');
    expect(SupplyWebhookBody.parse(webhookBody('order.delivered', order, 'America/Toronto')).event).toBe('order.delivered');
  });
});

describe('admin', () => {
  it('needs the password', async () => {
    const { r } = await withOrder();
    const b = r.browser();
    const locked = await b.get('/admin');
    expect(locked.status).toBe(401);
    expect(locked.text).not.toContain('RU-1042');
    expect((await b.post('/admin/reset')).location).toBe('/admin');
    expect(await r.shop.orders()).toHaveLength(1);
    expect((await b.submit('/admin/signin', { password: 'nope' })).text).toContain('Wrong password');
    const open = await b.submit('/admin/signin', { password: DEFAULTS.ADMIN_PASSWORD });
    expect(open.text).toContain('RU-1042');
    expect(open.text).toContain('Mark shipped');
  });

  it('edits a price and the in stock switch, marks orders shipped and delivered, and resets to the seed', async () => {
    const { r, order } = await withOrder();
    const b = r.browser();
    await b.post('/admin/signin', { password: DEFAULTS.ADMIN_PASSWORD });
    await b.post('/admin/items/OC-1008-114', { price: '9.99' });
    expect(await r.shop.item('OC-1008-114')).toMatchObject({ inStock: false });
    expect((await r.shop.item('OC-1008-114'))?.packs[0]?.price).toBe(9.99);
    await b.post('/admin/items/OC-6001', { price: '5.99', in_stock: '1' });
    expect((await r.shop.item('OC-6001'))?.inStock).toBe(true);

    r.notified.length = 0;
    await b.post(`/admin/orders/${order.confirmation}/ship`);
    await b.post(`/admin/orders/${order.confirmation}/ship`);
    await b.post(`/admin/orders/${order.confirmation}/deliver`);
    expect(r.notified.map((n) => n.event)).toEqual(['order.shipped', 'order.delivered']);
    expect((await r.shop.order(order.confirmation))?.status).toBe('Delivered');

    await r.browser().post('/cart', { sku: 'OC-1427', pack: '0', qty: '2' });
    await b.post('/admin/reset');
    expect(await r.shop.orders()).toHaveLength(0);
    expect((await r.shop.item('OC-1008-114'))?.packs[0]?.price).toBe(7.49);
    expect((await r.shop.item('OC-1008-114'))?.inStock).toBe(true);
    expect((await r.shop.item('OC-6001'))?.inStock).toBe(false);
  });
});
