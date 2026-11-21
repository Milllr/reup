/** Sign in for the one shop account, and its orders. */
import { Hono } from 'hono';
import { form, page, safeNext, type StoreEnv } from '../lib/app';
import { dayText, money } from '../lib/money';

export const account = new Hono<StoreEnv>();

function SignIn({ next, error, email }: { next: string; error?: string; email?: string }) {
  return (
    <>
      <h1>Sign in</h1>
      <p class="muted">Offcut Supply sells to shops with an account. Orders are billed to the account, net 30.</p>
      {error ? <p class="notice error" role="alert">{error}</p> : null}
      <form method="post" action="/signin" class="stack">
        <input type="hidden" name="next" value={next} />
        <label for="email">Email</label>
        <input type="email" id="email" name="email" autocomplete="username" value={email ?? ''} required />
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autocomplete="current-password" required />
        <div><button type="submit">Sign in</button></div>
      </form>
    </>
  );
}

account.get('/signin', (c) => {
  const next = safeNext(c.req.query('next') ?? '', '/');
  if (c.get('session').signedIn) return c.redirect(next, 303);
  return page(c, 'Sign in', <SignIn next={next} />);
});

account.post('/signin', async (c) => {
  const field = await form(c);
  const next = safeNext(field('next'), '/');
  const ok = await c.get('shop').signIn(c.get('session').id, field('email'), field('password'));
  if (!ok) return page(c, 'Sign in', <SignIn next={next} email={field('email')} error="That email and password do not match the shop account." />, { status: 401 });
  return c.redirect(next, 303);
});

account.post('/signout', async (c) => {
  await c.get('shop').signOut(c.get('session').id);
  return c.redirect('/', 303);
});

account.get('/orders', async (c) => {
  if (!c.get('session').signedIn) return c.redirect('/signin?next=/orders', 303);
  const orders = await c.get('shop').orders();
  return page(c, 'Orders', (
    <>
      <h1>Orders</h1>
      {orders.length === 0 ? <p class="notice">No orders yet.</p> : (
        <table>
          <thead><tr><th>Confirmation</th><th>PO number</th><th>Status</th><th>Delivery</th><th class="num">Total</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr><td><a href={`/orders/${o.confirmation}`}>{o.confirmation}</a></td><td>{o.poNumber}</td><td>{o.status}</td><td>{dayText(o.eta)}</td><td class="num">{money(o.total)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  ));
});

account.get('/orders/:confirmation', async (c) => {
  if (!c.get('session').signedIn) return c.redirect(`/signin?next=/orders/${encodeURIComponent(c.req.param('confirmation'))}`, 303);
  const order = await c.get('shop').order(c.req.param('confirmation'));
  if (!order) return page(c, 'Not found', <><h1>Order not found</h1><p><a href="/orders">See all orders</a>.</p></>, { status: 404 });
  return page(c, `Order ${order.confirmation}`, (
    <>
      {c.req.query('placed') ? <p class="notice good" role="status">Thank you. Your order is placed.</p> : null}
      <h1>{`Order ${order.confirmation}`}</h1>
      <p>Confirmation number: <strong id="confirmation">{order.confirmation}</strong></p>
      <p>Status: <strong id="status">{order.status}</strong></p>
      <p>Delivery date: <strong id="delivery">{dayText(order.eta)}</strong></p>
      <p>PO number: <span id="po">{order.poNumber}</span> · Payment: Bill to account (net 30)</p>
      <table>
        <thead><tr><th>Item</th><th>Pack</th><th class="num">Price</th><th class="num">Quantity</th><th class="num">Line total</th></tr></thead>
        <tbody>
          {order.lines.map((l) => (
            <tr><td>{l.name}<br /><span class="sku">{l.sku}</span></td><td>{l.packLabel}</td><td class="num">{money(l.price)}</td><td class="num">{String(l.qty)}</td><td class="num">{money(l.price * l.qty)}</td></tr>
          ))}
        </tbody>
      </table>
      <table class="totals"><tbody>
        <tr><td>Subtotal</td><td class="num">{money(order.subtotal)}</td></tr>
        <tr><td>HST (13%)</td><td class="num">{money(order.tax)}</td></tr>
        <tr><td>Shipping</td><td class="num">{order.shipping === 0 ? 'Free' : money(order.shipping)}</td></tr>
        <tr class="total"><td>Total</td><td class="num" id="total">{money(order.total)}</td></tr>
      </tbody></table>
    </>
  ));
});
