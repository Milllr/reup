/** Items on the dashboard: every item reup tracks, with its count typed by hand, its details changed, an item removed or a new one added. */
import { Catalog, type CatalogItem, type Product, type Snapshot } from '@reup/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { Tag } from '../../components';
import { call, yesKey } from '../../lib/hub';
import { mockCatalog } from '../../store/mock';
import type { LiveState } from '../../store/reduce';

export const ITEMS_NO_KEY = 'This screen has no key, so it can only show the items. Open the board with its key first, then come back here.';
export const ITEMS_MOCK = 'This is the sample board. Nothing is saved.';
/** The choice in the "Counted" list that means no camera: a person types the count. */
export const BY_HAND = '';

type Send = typeof call;
/** One change sent to the hub with this screen's key. what is the line shown when the hub says yes. True when it did. */
type Act = (what: string, method: 'POST' | 'PUT', path: string, body?: unknown) => Promise<boolean>;

/** Where an item's count comes from, in words. */
export function countedBy(s: Snapshot, product: Product): string {
  const zone = s.zones.find((z) => z.id === product.zoneId);
  return zone ? `Camera · ${zone.name}` : 'By hand';
}

/** Zones a camera sees that hold nothing yet. A new item can be put on one. */
export const freeZones = (s: Snapshot) => s.zones.filter((z) => z.productId == null && s.teach?.zoneId !== z.id);

const itemLabel = (i: CatalogItem) => `${i.sku} · ${i.name}`;

/** The store's catalog, to pick what an item is bought as. Empty until it is read, and when the store cannot be reached. */
export function useCatalog(live: LiveState, fetcher: Send = call): CatalogItem[] {
  const [items, setItems] = useState<CatalogItem[]>([]);
  useEffect(() => {
    if (live.mock) return setItems(Catalog.parse(mockCatalog).items);
    let stale = false;
    void fetcher<unknown>('GET', '/api/catalog').then((r) => {
      const parsed = r.ok ? Catalog.safeParse(r.data) : null;
      if (!stale && parsed?.success) setItems(parsed.data.items);
    });
    return () => {
      stale = true;
    };
  }, [live.mock, fetcher]);
  return items;
}

function StoreItem({ id, value, catalog, onChange }: { id: string; value: string; catalog: CatalogItem[]; onChange: (sku: string) => void }) {
  // An item matched before the catalog was read, or to a SKU the store dropped, still shows what it is matched to.
  const known = value === '' || catalog.some((i) => i.sku === value);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Not matched to a store item</option>
      {known ? null : <option value={value}>{value}</option>}
      {catalog.map((i) => <option key={i.sku} value={i.sku}>{itemLabel(i)}</option>)}
    </select>
  );
}

function Row({ s, product, catalog, act, busy }: { s: Snapshot; product: Product; catalog: CatalogItem[]; act: Act | null; busy: boolean }) {
  const count = s.counts.find((c) => c.productId === product.id)?.count ?? 0;
  const [typed, setTyped] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [name, setName] = useState(product.name);
  const [unit, setUnit] = useState(product.unit);
  const [sku, setSku] = useState(product.sku ?? '');
  const [phrase, setPhrase] = useState(product.searchPhrase);
  const shown = typed ?? String(count);
  const n = Number(shown);
  const canSet = act != null && typed != null && shown.trim() !== '' && Number.isInteger(n) && n >= 0 && n !== count;

  const open = () => {
    setName(product.name);
    setUnit(product.unit);
    setSku(product.sku ?? '');
    setPhrase(product.searchPhrase);
    setEditing(true);
  };

  if (editing && act) {
    const save = async (e: FormEvent) => {
      e.preventDefault();
      const done = await act(`${name.trim()} saved.`, 'PUT', `/api/products/${product.id}`, { name: name.trim(), unit: unit.trim(), sku: sku === '' ? null : sku, searchPhrase: phrase.trim() || name.trim() });
      if (done) setEditing(false);
    };
    return (
      <tr>
        <td colSpan={5}>
          <form className="wrap edit" onSubmit={(e) => void save(e)} aria-label={`Change ${product.name}`}>
            <label className="field"><span className="meta">Name</span><input value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} /></label>
            <label className="field"><span className="meta">Unit</span><input value={unit} maxLength={40} required onChange={(e) => setUnit(e.target.value)} /></label>
            <label className="field wide"><span className="meta">Bought as</span><StoreItem id={`sku-${product.id}`} value={sku} catalog={catalog} onChange={setSku} /></label>
            <label className="field wide"><span className="meta">Search words for retailers</span><input value={phrase} maxLength={120} onChange={(e) => setPhrase(e.target.value)} /></label>
            <button className="btn" type="submit" disabled={busy || name.trim() === '' || unit.trim() === ''}>Save</button>
            <button className="btn quiet" type="button" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="copy small">{product.name}<br /><span className="meta">{product.unit}</span></td>
      <td className="copy small">{product.sku ?? 'Not matched'}</td>
      <td className="copy small">{countedBy(s, product)}</td>
      <td>
        {act ? (
          <form className="wrap" onSubmit={(e) => { e.preventDefault(); if (canSet) void act(`${product.name}: ${n} on the shelf.`, 'POST', `/api/products/${product.id}/count`, { count: n }).then((ok) => { if (ok) setTyped(null); }); }}>
            <input className="count" type="number" min={0} max={9999} step={1} inputMode="numeric" aria-label={`Count of ${product.name}`} value={shown} onChange={(e) => setTyped(e.target.value)} />
            <button className="btn quiet" type="submit" disabled={busy || !canSet}>Set</button>
          </form>
        ) : <span className="copy small">{count}</span>}
      </td>
      <td>
        {act ? (
          <div className="wrap">
            <button className="btn quiet" type="button" onClick={open}>Edit</button>
            <button className="btn quiet" type="button" disabled={busy} onBlur={() => setArmed(false)} onClick={() => {
              if (!armed) return setArmed(true);
              setArmed(false);
              void act(`${product.name} removed.`, 'POST', `/api/products/${product.id}/remove`);
            }}>{armed ? 'Press again to remove' : 'Remove'}</button>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function AddItem({ s, catalog, act, busy }: { s: Snapshot; catalog: CatalogItem[]; act: Act; busy: boolean }) {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [zoneId, setZoneId] = useState(BY_HAND);
  const [count, setCount] = useState('1');
  const free = freeZones(s);
  const n = Number(count);
  const ok = name.trim() !== '' && unit.trim() !== '' && count.trim() !== '' && Number.isInteger(n) && n >= 0;

  // Picking a store item fills in what the store calls it and how it is sold. Both can still be changed.
  const pick = (next: string) => {
    setSku(next);
    const item = catalog.find((i) => i.sku === next);
    if (item) {
      setName(item.name);
      setUnit(item.unit);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    const done = await act(`${name.trim()} added.`, 'POST', '/api/products', { name: name.trim(), unit: unit.trim(), sku: sku === '' ? null : sku, zoneId: zoneId === BY_HAND ? null : zoneId, count: n });
    if (!done) return;
    setSku('');
    setName('');
    setUnit('');
    setZoneId(BY_HAND);
    setCount('1');
  };

  return (
    <form className="wrap edit" onSubmit={(e) => void add(e)} aria-label="Add an item">
      <label className="field wide"><span className="meta">Bought as</span><StoreItem id="add-sku" value={sku} catalog={catalog} onChange={pick} /></label>
      <label className="field"><span className="meta">Name</span><input value={name} maxLength={80} placeholder="Blue tape 1 in" onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span className="meta">Unit</span><input value={unit} maxLength={40} placeholder="roll" onChange={(e) => setUnit(e.target.value)} /></label>
      <label className="field">
        <span className="meta">Counted</span>
        <select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
          <option value={BY_HAND}>By hand</option>
          {free.map((z) => <option key={z.id} value={z.id}>{`By the camera, on ${z.name}`}</option>)}
        </select>
      </label>
      <label className="field narrow"><span className="meta">On the shelf now</span><input type="number" min={0} max={9999} step={1} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} /></label>
      <button className="btn" type="submit" disabled={busy || !ok}>Add item</button>
    </form>
  );
}

/**
 * The section. k is the key this screen holds: with none, the list is shown and nothing can be changed.
 * send is the hub call, swapped in tests.
 */
export function Items({ live, k: given, send = call }: { live: LiveState; k?: string | null; send?: Send }) {
  const s = live.snapshot;
  const k = given !== undefined ? given : yesKey(s);
  const catalog = useCatalog(live, send);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  if (!s) return null;

  // One change at a time, sent with this screen's key. The hub's own words when it says no.
  const act: Act | null = k == null ? null : async (what, method, path, body) => {
    if (live.mock) {
      setSaid({ text: ITEMS_MOCK, bad: false });
      return false;
    }
    setBusy(true);
    const res = await send(method, path, body, k);
    setBusy(false);
    setSaid(res.ok ? { text: what, bad: false } : { text: res.message ?? 'The hub did not take that.', bad: true });
    return res.ok;
  };

  return (
    <section className="stack items" style={{ gap: 26 }} aria-label="Items">
      <div className="stack" style={{ gap: 8 }}>
        <h2 className="name">Items</h2>
        <p className="copy small" style={{ maxWidth: '44em' }}>Everything reup tracks. Type a count to correct it, or for an item no camera sees: reup works out use and the next order from it the same way. A count on a camera ledge stands until the camera next reports.</p>
      </div>
      {s.products.length === 0 ? <p className="copy small">No items yet. Add one below, or put a part on the teach spot.</p> : (
        <table>
          <thead><tr><th className="meta">Item</th><th className="meta">Bought as</th><th className="meta">Counted</th><th className="meta">On the shelf</th><th className="meta" /></tr></thead>
          <tbody>{s.products.map((p) => <Row key={p.id} s={s} product={p} catalog={catalog} act={act} busy={busy} />)}</tbody>
        </table>
      )}
      <div aria-live="polite">{said ? <Tag tone={said.bad ? 'alert' : 'blue'} style={{ whiteSpace: 'normal', borderRadius: 14, lineHeight: 1.3 }}>{said.text}</Tag> : null}</div>
      {act ? (
        <div className="stack" style={{ gap: 14 }}>
          <h3 className="name" style={{ margin: 0 }}>Add an item</h3>
          <AddItem s={s} catalog={catalog} act={act} busy={busy} />
        </div>
      ) : <p className="copy small">{ITEMS_NO_KEY}</p>}
    </section>
  );
}
