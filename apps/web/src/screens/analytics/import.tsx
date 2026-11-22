/** Import a list: an export from the shop's inventory system becomes items, each with the reorder point its use gives. */
import type { CatalogItem, Snapshot } from '@reup/contracts';
import { useMemo, useState, type ChangeEvent } from 'react';
import { readExport, rowBody } from './export';

export const IMPORT_HINT = 'An export from Zoho Inventory, Cin7 Core, Fishbowl or any sheet, saved as CSV. reup reads the name, the unit, what is on hand and what was used, and works out when to reorder. Nothing is written back to that system.';
export const NO_USE_COLUMN = 'The file has no column for what was used or sold, so each item starts on sample use.';

/** One change sent to the hub with this screen's key. True when the hub said yes. */
type Act = (what: string, method: 'POST' | 'PUT', path: string, body?: unknown) => Promise<boolean>;

const perDay = (n: number | null) => (n == null ? '' : String(Math.round(n * 100) / 100));
const reorderText = (n: number | null) => (n == null ? 'From sample use' : n === 0 ? 'Never, not used' : String(n));

export function ImportItems({ s, catalog, act, busy }: { s: Snapshot; catalog: CatalogItem[]; act: Act; busy: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Read again whenever the store's catalog arrives or the board's items change: a row just added turns into "Already here".
  const read = useMemo(() => (text == null ? null : readExport(text, s, catalog)), [text, s, catalog]);
  const fresh = read?.rows.filter((r) => r.skip == null) ?? [];

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setText(file ? await file.text() : null);
  };

  // One at a time, in the file's order. The hub's own words stop it: what was added before stays added.
  const add = async () => {
    setAdding(true);
    let done = 0;
    for (const row of fresh) {
      if (!(await act(`${done + 1} of ${fresh.length} added.`, 'POST', '/api/products', rowBody(row)))) break;
      done += 1;
    }
    setAdding(false);
    if (done === fresh.length) setText(null);
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <h3 className="name" style={{ margin: 0 }}>Import a list</h3>
      <p className="copy small" style={{ maxWidth: '44em' }}>{IMPORT_HINT}</p>
      <div className="wrap"><label className="field wide"><span className="meta">Inventory export</span><input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => void pick(e)} /></label></div>
      {read?.problem ? <p className="copy small" role="alert">{read.problem}</p> : null}
      {read && !read.problem ? (
        <>
          <table aria-label="Items in the file">
            <thead><tr><th className="meta">Item</th><th className="meta">Unit</th><th className="meta">On hand</th><th className="meta">Used a day</th><th className="meta">Reorder at</th><th className="meta">Bought as</th><th className="meta" /></tr></thead>
            <tbody>
              {read.rows.map((r, i) => (
                <tr key={`${r.name}-${i}`} style={r.skip ? { opacity: 0.5 } : undefined}>
                  <td>{r.name}</td>
                  <td>{r.unit}</td>
                  <td>{r.count}</td>
                  <td>{perDay(r.usePerDay)}</td>
                  <td>{reorderText(r.reorderAt)}</td>
                  <td>{r.sku ?? 'Not matched yet'}</td>
                  <td className="meta">{r.skip ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="copy small" style={{ maxWidth: '44em' }}>
            {read.use ?? NO_USE_COLUMN}
            {read.left > 0 ? ` Only the first ${read.rows.length} rows are read: ${read.left} more are in the file.` : ''}
            {' '}Each item is counted by hand until it has a ledge. Nothing is ordered without a yes.
          </p>
          <div className="wrap">
            <button className="btn" type="button" disabled={busy || adding || fresh.length === 0} onClick={() => void add()}>{fresh.length === 1 ? 'Add 1 item' : `Add ${fresh.length} items`}</button>
            <button className="btn quiet" type="button" onClick={() => setText(null)}>Clear</button>
          </div>
        </>
      ) : null}
    </div>
  );
}
