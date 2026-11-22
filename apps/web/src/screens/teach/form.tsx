/** The form that names a new part. The phone, the operator page and the TV's new part plate all use it. */
import type { Snapshot, TeachConfirmBody, TeachState } from '@reup/contracts';
import { useState, type FormEvent } from 'react';
import { Tag } from '../../components';
import { call } from '../../lib/hub';
import type { Place } from './boxes';

export const NO_KEY = 'This phone cannot approve. Scan the code on the station.';
export const SURE = { sure: 'sure', fairly_sure: 'fairly sure', not_sure: 'not sure' } as const;

/**
 * Name a new part.
 * place: the screen has the boxes on the board to say where the part sits (the TV's new part plate). The form then
 * has no list of places: Confirm saves the boxes that were moved, and the part takes the place the boxes come to.
 * With it the form is also set tighter, as the plate says the suggestion in large type itself.
 */
export function TeachForm({ teach, s, send = call, bearer, focus = false, place }: { teach: TeachState; s: Snapshot; send?: typeof call; bearer: string | null; focus?: boolean; place?: () => Place }) {
  const sug = teach.suggestion;
  const [name, setName] = useState(sug?.name ?? '');
  const [unit, setUnit] = useState(sug?.unit ?? 'each');
  const [sku, setSku] = useState(sug?.sku ?? '');
  const [zoneId, setZoneId] = useState(teach.zoneId ?? s.zones[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seenId, setSeenId] = useState(`${teach.id}:${teach.status}`);
  // When the suggestion arrives, fill the form with it once.
  if (seenId !== `${teach.id}:${teach.status}`) {
    setSeenId(`${teach.id}:${teach.status}`);
    if (sug) {
      setName(sug.name);
      setUnit(sug.unit);
      setSku(sug.sku ?? '');
    }
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (bearer == null) return setError(NO_KEY);
    if (busy) return;
    const where = place?.();
    const body: TeachConfirmBody = { name: name.trim(), unit: unit.trim() || 'each', sku: sku.trim() === '' ? null : sku.trim(), searchPhrase: sug && sug.name === name.trim() ? sug.searchPhrase : name.trim(), zoneId: where ? where.zoneId : zoneId, ...(where?.quad ? { quad: where.quad } : {}) };
    if (body.name === '' || body.zoneId === '') return setError('Give it a name and a place.');
    setBusy(true);
    // The boxes that were moved are saved first, so the part is counted in the box as it was left.
    for (const box of where?.moved ?? []) {
      const saved = await send('POST', `/api/zones/${box.id}/quad`, { quad: box.quad }, bearer);
      if (!saved.ok) {
        setBusy(false);
        return setError(saved.message ?? 'Could not save the boxes.');
      }
    }
    const res = await send('POST', `/api/teach/${teach.id}/confirm`, body, bearer);
    setBusy(false);
    setError(res.ok ? null : (res.message ?? 'Could not add it.'));
  };
  const cancel = async () => {
    const res = await send('POST', `/api/teach/${teach.id}/cancel`, undefined, bearer);
    setError(res.ok ? null : (res.message ?? 'Could not cancel.'));
  };
  const said = error ? <Tag tone="alert" style={{ whiteSpace: 'normal', borderRadius: 14, lineHeight: 1.3 }}>{error}</Tag> : null;
  if (place) {
    return (
      <form className="stack" style={{ gap: 14 }} onSubmit={(e) => void submit(e)}>
        <label className="field"><span className="meta">Name</span><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus={focus} /></label>
        <div className="pairs">
          <label className="field"><span className="meta">One unit is</span><input value={unit} onChange={(e) => setUnit(e.target.value)} /></label>
          <label className="field"><span className="meta">Offcut SKU</span><input value={sku} onChange={(e) => setSku(e.target.value)} /></label>
        </div>
        {said}
        <div className="pairs">
          <button className="btn" type="submit" disabled={busy}>Confirm</button>
          <button className="btn quiet" type="button" onClick={() => void cancel()}>Not a part</button>
        </div>
      </form>
    );
  }
  return (
    <form className="stack" style={{ gap: 14 }} onSubmit={(e) => void submit(e)}>
      <p className="copy small">{teach.status === 'naming' ? 'Naming it.' : sug ? `Looks like ${sug.name}. ${SURE[sug.confidence].charAt(0).toUpperCase()}${SURE[sug.confidence].slice(1)}.` : (teach.error ?? 'Type a name to add it.')}</p>
      <label className="field"><span className="meta">Name</span><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus={focus} /></label>
      <label className="field"><span className="meta">One unit is</span><input value={unit} onChange={(e) => setUnit(e.target.value)} /></label>
      <label className="field"><span className="meta">Offcut SKU</span><input value={sku} onChange={(e) => setSku(e.target.value)} /></label>
      <label className="field"><span className="meta">Where it sits</span>
        <select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>{s.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select>
      </label>
      {said}
      <button className="btn" type="submit" disabled={busy}>Confirm</button>
      <button className="btn quiet" type="button" onClick={() => void cancel()}>Not a part</button>
    </form>
  );
}
