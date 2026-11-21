/** Checkout on account: review, a PO number, Place order. No card field exists anywhere. */
import { Hono } from 'hono';
import { form, page, type Ctx, type StoreEnv } from '../lib/app';
import { dayText, money, totals } from '../lib/money';
import { ShopError, type CartLine } from '../lib/shop';
import { webhookBody } from '../webhook';

export const checkout = new Hono<StoreEnv>();

function review(c: Ctx, lines: CartLine[], po: string, error?: string) {
  const sums = totals(lines);
  const eta = c.get('shop').eta(lines);
  return page(c, 'Checkout', (
    <>
      <h1>Review your order</h1>
      {error ? <p class="notice error" role="alert" id="checkout-error">{error}</p> : null}
      <table id="review-lines">
        <thead><tr><th>Item</th><th>Pack</th><th class="num">Price</th><th class="num">Quantity</th><th class="num">Line total</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr><td>{l.name}<br /><span class="sku">{l.sku}</span></td><td>{l.packLabel}</td><td class="num">{money(l.price)}</td><td class="num">{String(l.qty)}</td><td class="num">{money(l.price * l.qty)}</td></tr>
          ))}
        </tbody>
      </table>
      <table class="totals"><tbody>
        <tr><td>Subtotal</td><td class="num" id="subtotal">{money(sums.subtotal)}</td></tr>
        <tr><td>HST (13%)</td><td class="num" id="tax">{money(sums.tax)}</td></tr>
        <tr><td>Shipping</td><td class="num" id="shipping">{sums.shipping === 0 ? 'Free' : money(sums.shipping)}</td></tr>
        <tr class="total"><td>Total</td><td class="num" id="total">{money(sums.total)}</td></tr>
      </tbody></table>
      <p>Delivery date: <strong id="delivery">{dayText(eta)}</strong></p>
      <form method="post" action="/checkout" class="stack">
        <label for="po">PO number</label>
        <input type="text" id="po" name="po" value={po} maxlength={40} autocomplete="off" />
        <p style="margin:0">Payment: <strong>Bill to account (net 30)</strong></p>
        <div><button type="submit" id="place-order">Place order</button></div>
      </form>
    </>
  ), { status: error ? 400 : 200 });
}

checkout.get('/checkout', async (c) => {
  if (!c.get('session').signedIn) return c.redirect('/signin?next=/checkout', 303);
  const lines = await c.get('shop').cart(c.get('session').id);
  if (lines.length === 0) return c.redirect('/cart', 303);
  return review(c, lines, '');
});

checkout.post('/checkout', async (c) => {
  if (!c.get('session').signedIn) return c.redirect('/signin?next=/checkout', 303);
  const shop = c.get('shop');
  const field = await form(c);
  try {
    const order = await shop.place(c.get('session').id, field('po'));
    c.get('hooks').notify(webhookBody('order.confirmed', order, shop.config.TIME_ZONE));
    c.get('hooks').schedule(order.confirmation);
    return c.redirect(`/orders/${order.confirmation}?placed=1`, 303);
  } catch (err) {
    if (!(err instanceof ShopError)) throw err;
    const lines = await shop.cart(c.get('session').id);
    if (lines.length === 0) return c.redirect('/cart', 303);
    return review(c, lines, field('po'), err.message);
  }
});
