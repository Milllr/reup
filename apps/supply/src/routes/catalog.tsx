/** Home, search, product pages, the cookie notice and the public catalog. */
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { form, page, safeNext, type StoreEnv } from '../lib/app';
import { money } from '../lib/money';
import type { Item } from '../lib/shop';

export const catalog = new Hono<StoreEnv>();

const from = (item: Item) => money(Math.min(...item.packs.map((p) => p.price / p.size)));

function ItemList({ items }: { items: Item[] }) {
  return (
    <table>
      <thead><tr><th>Item</th><th>SKU</th><th>Sold as</th><th class="num">From</th><th>Stock</th></tr></thead>
      <tbody>
        {items.map((item) => (
          <tr>
            <td><a href={`/p/${item.sku}`}>{item.name}</a><br /><span class="muted">{item.category}</span></td>
            <td class="sku">{item.sku}</td>
            <td>{item.unit}</td>
            <td class="num">{from(item)}</td>
            <td>{item.inStock ? 'In stock' : 'Out of stock'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

catalog.get('/', async (c) => {
  const items = await c.get('shop').items();
  const categories = [...new Set(items.map((i) => i.category))];
  return page(c, 'Shop supplies for small shops', (
    <>
      <h1>Shop supplies, sold by the box</h1>
      <p class="muted">Fasteners, brackets, glue and sanding supplies for small shops and labs. Orders on account ship in 1 to 3 business days.</p>
      <h2>Categories</h2>
      <ul class="grid">
        {categories.map((category) => (
          <li><a href={`/search?q=${encodeURIComponent(category)}`}>{category}</a><br /><span class="muted">{`${items.filter((i) => i.category === category).length} items`}</span></li>
        ))}
      </ul>
      <h2>Featured</h2>
      <ItemList items={items.filter((i) => i.inStock).slice(0, 6)} />
    </>
  ));
});

catalog.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const items = q === '' ? await c.get('shop').items() : await c.get('shop').search(q);
  return page(c, q === '' ? 'All items' : `Search: ${q}`, (
    <>
      <h1>{q === '' ? 'All items' : `Results for "${q}"`}</h1>
      {items.length === 0 ? <p class="notice">No items match. Try a SKU like OC-1008-114, or fewer words.</p> : <><p class="muted">{`${items.length} ${items.length === 1 ? 'item' : 'items'}, best match first.`}</p><ItemList items={items} /></>}
    </>
  ), { query: q });
});

catalog.get('/p/:sku', async (c) => {
  const item = await c.get('shop').item(c.req.param('sku'));
  if (!item) return page(c, 'Not found', <><h1>Item not found</h1><p>There is no item with that SKU. <a href="/search">See all items</a>.</p></>, { status: 404 });
  const error = c.req.query('error');
  return page(c, item.name, (
    <>
      <p class="muted"><a href="/">Home</a> / <a href={`/search?q=${encodeURIComponent(item.category)}`}>{item.category}</a></p>
      <h1>{item.name}</h1>
      {error ? <p class="notice error" role="alert">{error}</p> : null}
      <p>SKU <span class="sku" id="sku">{item.sku}</span> · Sold as: {item.unit} · <strong id="stock">{item.inStock ? 'In stock' : 'Out of stock'}</strong> · {`Delivery in ${item.leadDays} business ${item.leadDays === 1 ? 'day' : 'days'}`}</p>
      {item.inStock ? (
        <form method="post" action="/cart" class="stack">
          <input type="hidden" name="sku" value={item.sku} />
          <fieldset>
            <legend>Pack size</legend>
            {item.packs.map((pack, i) => (
              <label><input type="radio" name="pack" value={String(i)} checked={i === 0} />{` ${pack.label}, ${money(pack.price)}`}</label>
            ))}
          </fieldset>
          <label for="qty">Quantity</label>
          <input type="number" id="qty" name="qty" min="1" max="999" step="1" value="1" required />
          <div><button type="submit">Add to cart</button></div>
        </form>
      ) : (
        <p class="notice">This item is out of stock and cannot be ordered right now.</p>
      )}
    </>
  ));
});

catalog.get('/catalog.json', async (c) => c.json(await c.get('shop').catalog(new URL(c.req.url).origin)));

catalog.post('/cookies', async (c) => {
  const field = await form(c);
  setCookie(c, 'oc_cookies', '1', { path: '/', maxAge: 365 * 24 * 60 * 60, sameSite: 'Lax' });
  return c.redirect(safeNext(field('next'), '/'), 303);
});
