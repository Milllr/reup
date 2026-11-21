/** The store's back office: prices, stock, shipping orders by hand, and reset. Behind one password. */
import { Hono } from 'hono';
import { form, page, type StoreEnv } from '../lib/app';
import { dayText, money } from '../lib/money';
import { webhookBody } from '../webhook';

export const admin = new Hono<StoreEnv>();

admin.get('/admin', async (c) => {
  if (!c.get('session').isAdmin) {
    return page(c, 'Admin', (
      <>
        <h1>Store admin</h1>
        {c.req.query('error') ? <p class="notice error" role="alert">Wrong password.</p> : null}
        <form method="post" action="/admin/signin" class="stack">
          <label for="admin-password">Admin password</label>
          <input type="password" id="admin-password" name="password" required />
          <div><button type="submit">Open admin</button></div>
        </form>
      </>
    ), { status: 401 });
  }
  const shop = c.get('shop');
  const [items, orders] = [await shop.items(), await shop.orders()];
  return page(c, 'Admin', (
    <>
      <h1>Store admin</h1>
      <h2>Orders</h2>
      {orders.length === 0 ? <p class="notice">No orders yet.</p> : (
        <table>
          <thead><tr><th>Confirmation</th><th>PO number</th><th>Status</th><th>Delivery</th><th class="num">Total</th><th></th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr>
                <td>{o.confirmation}</td><td>{o.poNumber}</td><td>{o.status}</td><td>{dayText(o.eta)}</td><td class="num">{money(o.total)}</td>
                <td class="inline">
                  {o.status === 'Confirmed' ? <form method="post" action={`/admin/orders/${o.confirmation}/ship`}><button type="submit" class="plain">Mark shipped</button></form> : null}
                  {o.status !== 'Delivered' ? <form method="post" action={`/admin/orders/${o.confirmation}/deliver`}><button type="submit" class="plain">Mark delivered</button></form> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Items</h2>
      <table>
        <thead><tr><th>Item</th><th>SKU</th><th>Price of the first pack</th><th>In stock</th><th></th></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr>
              <td>{i.name}</td><td class="sku">{i.sku}</td>
              <td colspan={3}>
                <form method="post" action={`/admin/items/${i.sku}`} class="inline">
                  <label for={`price-${i.sku}`} class="muted">{i.packs[0]?.label ?? 'Price'}</label>
                  <input type="number" id={`price-${i.sku}`} name="price" min="0" step="0.01" value={String(i.packs[0]?.price ?? 0)} />
                  <label class="inline"><input type="checkbox" name="in_stock" value="1" checked={i.inStock} /> In stock</label>
                  <button type="submit" class="plain">Save</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Reset</h2>
      <form method="post" action="/admin/reset"><button type="submit">Reset the store</button> <span class="muted">Clears orders and carts and restores seeded prices and stock.</span></form>
    </>
  ));
});

admin.post('/admin/signin', async (c) => {
  const field = await form(c);
  const ok = await c.get('shop').adminIn(c.get('session').id, field('password'));
  return c.redirect(ok ? '/admin' : '/admin?error=1', 303);
});

admin.use('/admin/*', async (c, next) => {
  if (!c.get('session').isAdmin) return c.redirect('/admin', 303);
  await next();
});

admin.post('/admin/items/:sku', async (c) => {
  const field = await form(c);
  const price = field('price') === '' ? null : Number(field('price'));
  await c.get('shop').updateItem(c.req.param('sku'), price != null && Number.isFinite(price) ? price : null, field('in_stock') === '1');
  return c.redirect('/admin', 303);
});

admin.post('/admin/orders/:confirmation/ship', async (c) => {
  const shop = c.get('shop');
  const order = await shop.setStatus(c.req.param('confirmation'), 'Shipped');
  if (order) c.get('hooks').notify(webhookBody('order.shipped', order, shop.config.TIME_ZONE));
  return c.redirect('/admin', 303);
});

admin.post('/admin/orders/:confirmation/deliver', async (c) => {
  const shop = c.get('shop');
  const order = await shop.setStatus(c.req.param('confirmation'), 'Delivered');
  if (order) c.get('hooks').notify(webhookBody('order.delivered', order, shop.config.TIME_ZONE));
  return c.redirect('/admin', 303);
});

admin.post('/admin/reset', async (c) => {
  await c.get('shop').reset();
  return c.redirect('/admin', 303);
});
