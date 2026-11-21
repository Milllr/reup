import { Catalog, SupplyWebhookBody } from '@reup/contracts';
import { describe, expect, it } from 'vitest';
import { FOOTER } from '../src/lib/layout';
import { deliveryDay, etaIso, totals } from '../src/lib/money';
import { rank, SEED } from '../src/lib/shop';
import { rig, signedIn } from './helpers';

const items = SEED.items.map((i) => ({ ...i }));

describe('catalog, search and product pages', () => {
  it('ranks an exact SKU first and finds by words in any order', () => {
    expect(rank(items, 'OC-1008-114')[0]?.sku).toBe('OC-1008-114');
    expect(rank(items, 'oc-1008-200')[0]?.sku).toBe('OC-1008-200');
    expect(rank(items, 'screws wood 1-1/4 #8')[0]?.sku).toBe('OC-1008-114');
    expect(rank(items, '#8 x 1-1/4 wood screws box of 100')[0]?.sku).toBe('OC-1008-114');
    expect(rank(items, '2 inch corner bracket 4 pack')[0]?.sku).toBe('OC-2202');
    expect(rank(items, 'glue')[0]?.sku).toBe('OC-3473');
    expect(rank(items, 'Sanding').map((i) => i.sku)).toEqual(['OC-4120', 'OC-4220']);
    expect(rank(items, 'zzz')).toEqual([]);
  });

  it('serves the whole catalog as the Catalog contract, with links to this store', async () => {
    const b = rig().browser();
    const cat = Catalog.parse(JSON.parse((await b.get('/catalog.json')).text));
    expect(cat.items).toHaveLength(16);
    expect(cat.items[0]?.url).toBe('http://offcut.test/p/OC-1008-114');
  });

  it('shows pack options as radio buttons with a quantity and Add to cart', async () => {
    const page = (await rig().browser().get('/p/OC-1008-114')).text;
    expect(page).toContain('#8 x 1-1/4 in Wood Screws, Robertson');
    expect(page).toMatch(/<input type="radio" name="pack" value="0" checked[^>]*\/?> Box of 100, \$7\.49/);
    expect(page).toContain('Case of 10 boxes, $67.90');
    expect(page).toContain('<label for="qty">Quantity</label>');
    expect(page).toContain('Add to cart');
    expect(page).toContain('Delivery in 2 business days');
  });

  it('shows Out of stock with no Add to cart button, and refuses it in the cart', async () => {
    const r = rig();
    const b = r.browser();
    const page = (await b.get('/p/OC-6001')).text;
    expect(page).toContain('Out of stock');
    expect(page).not.toContain('Add to cart');
    const res = await b.submit('/cart', { sku: 'OC-6001', pack: '0', qty: '1' });
    expect(res.text).toContain('Carpenter Pencils is out of stock.');
    expect((await b.get('/cart')).text).toContain('Your cart is empty');
  });

  it('puts the footer on every route, and a cookie notice until it is dismissed', async () => {
    const r = rig();
    const b = await signedIn(r);
    for (const path of ['/', '/search?q=screws', '/p/OC-1008-114', '/p/nope', '/cart', '/orders', '/admin', '/nowhere']) {
      const res = await b.get(path);
      expect(res.text, path).toContain(FOOTER);
    }
    expect((await r.browser().get('/signin?next=/x')).text).toContain(FOOTER);
    expect((await b.get('/')).text).toContain('Accept cookies');
    const after = await b.submit('/cookies', { next: '/search?q=glue' });
    expect(after.path).toBe('/search?q=glue');
    expect(after.text).not.toContain('Accept cookies');
    expect((await b.submit('/cookies', { next: 'https://evil.example' })).path).toBe('/');
  });
});

describe('account, cart, checkout and orders', () => {
  it('totals: tax at 13 percent, free shipping from 50 dollars, rounded to cents', () => {
    expect(totals([{ price: 7.49, qty: 8 }])).toEqual({ subtotal: 59.92, tax: 7.79, shipping: 0, total: 67.71 });
    expect(totals([{ price: 7.49, qty: 2 }])).toEqual({ subtotal: 14.98, tax: 1.95, shipping: 9.95, total: 26.88 });
    expect(totals([{ price: 50, qty: 1 }]).shipping).toBe(0);
    expect(totals([{ price: 0.335, qty: 3 }]).subtotal).toBe(1.01);
  });

  it('delivery dates skip weekends', () => {
    const tz = 'America/Toronto';
    expect(deliveryDay(new Date('2026-11-21T14:00:00Z'), 2, tz)).toBe('2026-11-24'); // Saturday, 2 business days: Tuesday
    expect(deliveryDay(new Date('2026-11-19T14:00:00Z'), 2, tz)).toBe('2026-11-23'); // Thursday: Monday
    expect(deliveryDay(new Date('2026-11-23T03:30:00Z'), 1, tz)).toBe('2026-11-23'); // late Sunday in Toronto: Monday
    expect(etaIso('2026-11-24', tz)).toBe('2026-11-24T17:00:00-05:00');
    expect(etaIso('2026-07-02', tz)).toBe('2026-07-02T17:00:00-04:00');
  });

  it('keeps one cart per browser, and lets a quantity change, a line go and the cart empty', async () => {
    const r = rig();
    const [a, b] = [r.browser(), r.browser()];
    await a.post('/cart', { sku: 'OC-1008-114', pack: '0', qty: '8' });
    await a.post('/cart', { sku: 'OC-3473', pack: '0', qty: '1' });
    expect((await a.get('/cart')).text).toContain('Cart (9)');
    expect((await b.get('/cart')).text).toContain('Your cart is empty');
    await a.post('/cart/update', { sku: 'OC-1008-114', pack: '0', qty: '3' });
    await a.post('/cart/remove', { sku: 'OC-3473', pack: '0' });
    const cart = (await a.get('/cart')).text;
    expect(cart).toContain('Cart (3)');
    expect(cart).toContain('id="subtotal">$22.47');
    expect(cart).not.toContain('Wood Glue');
    expect((await a.submit('/cart/empty')).text).toContain('Your cart is empty');
  });

  it('sends checkout to sign in first, and refuses a wrong password', async () => {
    const b = rig().browser();
    await b.post('/cart', { sku: 'OC-1008-114', pack: '0', qty: '8' });
    expect((await b.get('/checkout')).location).toBe('/signin?next=/checkout');
    expect((await b.post('/checkout', { po: 'RU-1' })).location).toBe('/signin?next=/checkout');
    const wrong = await b.post('/signin', { email: 'shop@reup.test', password: 'nope', next: '/checkout' });
    expect(wrong.status).toBe(401);
    expect(wrong.text).toContain('do not match');
    const ok = await b.submit('/signin', { email: 'SHOP@reup.test', password: 'dev-shop-password', next: '/checkout' });
    expect(ok.path).toBe('/checkout');
    expect(ok.text).toContain('Review your order');
  });

  it('shows the review page the buyer reads: lines, tax, shipping, total, delivery, PO field, bill to account', async () => {
    const r = rig();
    const b = await signedIn(r);
    await b.post('/cart', { sku: 'OC-1008-114', pack: '0', qty: '8' });
    const page = (await b.get('/checkout')).text;
    expect(page).toContain('id="subtotal">$59.92');
    expect(page).toContain('id="tax">$7.79');
    expect(page).toContain('id="shipping">Free');
    expect(page).toContain('id="total">$67.71');
    expect(page).toContain('id="delivery">Tuesday, Nov 24');
    expect(page).toContain('<label for="po">PO number</label>');
    expect(page).toContain('Bill to account (net 30)');
    expect(page).toContain('Place order');
    expect(page.toLowerCase()).not.toMatch(/card number|credit card|cvv/);
  });

  it('refuses checkout without a PO number and creates nothing', async () => {
    const r = rig();
    const b = await signedIn(r);
    await b.post('/cart', { sku: 'OC-1008-114', pack: '0', qty: '8' });
    const res = await b.post('/checkout', { po: '   ' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Enter a PO number');
    expect(await r.shop.orders()).toHaveLength(0);
    expect(r.notified).toHaveLength(0);
    expect((await b.get('/cart')).text).toContain('Cart (8)');
  });

  it('places the order, empties the cart, shows the confirmation and tells the hub', async () => {
    const r = rig();
    const b = await signedIn(r);
    await b.post('/cart', { sku: 'OC-1008-114', pack: '0', qty: '8' });
    const done = await b.submit('/checkout', { po: 'RU-1042' });
    const [order] = await r.shop.orders();
    expect(order).toMatchObject({ poNumber: 'RU-1042', total: 67.71, status: 'Confirmed', eta: '2026-11-24' });
    expect(order?.confirmation).toMatch(/^OC-\d{5}$/);
    expect(done.path).toBe(`/orders/${order?.confirmation}?placed=1`);
    expect(done.text).toContain(`id="confirmation">${order?.confirmation}`);
    expect(done.text).toContain('id="delivery">Tuesday, Nov 24');
    expect(done.text).toContain('id="status">Confirmed');
    expect((await b.get('/cart')).text).toContain('Your cart is empty');
    expect(r.notified.map((n) => SupplyWebhookBody.parse(n))).toEqual([{ event: 'order.confirmed', confirmation: order?.confirmation, poNumber: 'RU-1042', eta: '2026-11-24T17:00:00-05:00' }]);
    expect(r.scheduled).toEqual([order?.confirmation]);
    expect((await b.get('/orders')).text).toContain(order?.confirmation ?? '?');
  });

  it('gives every order its own confirmation number', async () => {
    const r = rig();
    const b = await signedIn(r);
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      await b.post('/cart', { sku: 'OC-1427', pack: '0', qty: '1' });
      await b.post('/checkout', { po: `PO-${i}` });
    }
    for (const o of await r.shop.orders()) seen.add(o.confirmation);
    expect(seen.size).toBe(12);
  });

  it('asks for sign in before showing orders', async () => {
    const b = rig().browser();
    expect((await b.get('/orders')).location).toBe('/signin?next=/orders');
    expect((await b.get('/orders/OC-1')).location).toBe('/signin?next=/orders/OC-1');
  });
});
