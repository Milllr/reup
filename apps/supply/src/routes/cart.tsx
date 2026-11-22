/** The cart: add, change a quantity, remove a line, empty it. */
import { Hono } from 'hono';
import { form, page, type StoreEnv } from '../lib/app';
import { money, totals } from '../lib/money';
import { ShopError } from '../lib/shop';

export const cart = new Hono<StoreEnv>();

cart.post('/cart', async (c) => {
  const field = await form(c);
  const sku = field('sku');
  try {
    await c.get('shop').add(c.get('session').id, sku, Number(field('pack') || '0'), Number(field('qty') || '1'));
  } catch (err) {
    if (!(err instanceof ShopError)) throw err;
    return c.redirect(`/p/${encodeURIComponent(sku)}?error=${encodeURIComponent(err.message)}`, 303);
  }
  return c.redirect('/cart', 303);
});

cart.get('/cart', async (c) => {
  const lines = await c.get('shop').cart(c.get('session').id);
  const sums = totals(lines);
  return page(c, 'Cart', (
    <>
      <h1>Cart</h1>
      {lines.length === 0 ? (
        <p class="notice" id="cart-empty">Your cart is empty. <a href="/search">See all items</a>.</p>
      ) : (
        <>
          <table id="cart-lines">
            <thead><tr><th>Item</th><th>Pack</th><th class="num">Price</th><th>Quantity</th><th class="num">Line total</th><th></th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr>
                  <td><a href={`/p/${l.sku}`}>{l.name}</a><br /><span class="sku">{l.sku}</span></td>
                  <td>{l.packLabel}</td>
                  <td class="num">{money(l.price)}</td>
                  <td>
                    <form method="post" action="/cart/update" class="inline">
                      <input type="hidden" name="sku" value={l.sku} /><input type="hidden" name="pack" value={String(l.packIndex)} />
                      <label for={`qty-${l.sku}-${l.packIndex}`} class="muted">Qty</label>
                      <input type="number" id={`qty-${l.sku}-${l.packIndex}`} name="qty" min="0" max="999" step="1" value={String(l.qty)} />
                      <button type="submit" class="plain">Update</button>
                    </form>
                  </td>
                  <td class="num">{money(l.price * l.qty)}</td>
                  <td>
                    <form method="post" action="/cart/remove">
                      <input type="hidden" name="sku" value={l.sku} /><input type="hidden" name="pack" value={String(l.packIndex)} />
                      <button type="submit" class="plain" aria-label={`Remove ${l.name}`}>Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table class="totals"><tbody><tr><td>Subtotal</td><td class="num" id="subtotal">{money(sums.subtotal)}</td></tr></tbody></table>
          <p class="muted" style="text-align:right">Tax and shipping are shown at checkout.</p>
          {/* Checkout is a real button, alone on its row. It used to be a link beside the "Empty cart" button, and a
              browser agent told to press Checkout pressed the only button there: its cart was emptied, every time. */}
          <form method="get" action="/checkout" style="display:flex;justify-content:flex-end;margin-top:14px">
            <button type="submit" id="checkout" style="font-size:18px;padding:12px 32px">Checkout</button>
          </form>
          <form method="post" action="/cart/empty" style="margin-top:56px">
            <button type="submit" class="plain" id="empty-cart">Empty cart</button>
          </form>
        </>
      )}
    </>
  ));
});

cart.post('/cart/update', async (c) => {
  const field = await form(c);
  await c.get('shop').setQty(c.get('session').id, field('sku'), Number(field('pack') || '0'), Number(field('qty') || '0'));
  return c.redirect('/cart', 303);
});

cart.post('/cart/remove', async (c) => {
  const field = await form(c);
  await c.get('shop').remove(c.get('session').id, field('sku'), Number(field('pack') || '0'));
  return c.redirect('/cart', 303);
});

cart.post('/cart/empty', async (c) => {
  await c.get('shop').empty(c.get('session').id);
  return c.redirect('/cart', 303);
});
