/** The form that names a new part. The phone, the operator page and the TV's new part plate all use it. */
import type { Snapshot, TeachConfirmBody, TeachState } from '@reup/contracts';
import { useState, type FormEvent } from 'react';
import { Tag } from '../../components';
import { call } from '../../lib/hub';

export const NO_KEY = 'This phone cannot approve. Scan the code on the station.';
export const SURE = { sure: 'sure', fairly_sure: 'fairly sure', not_sure: 'not sure' } as const;

/** Name a new part. */
export function TeachForm({ teach, s, send = call, bearer, focus = false }: { teach: TeachState; s: Snapshot; send?: typeof call; bearer: string | null; focus?: boolean }) {
  const sug = teach.suggestion;
  const [name, setName] = useState(sug?.name ?? '');
  const [unit, setUnit] = useState(sug?.unit ?? 'each');
  const [sku, setSku] = useState(sug?.sku ?? '');
  const [zoneId, setZoneId] = useState(teach.zoneId ?? s.zones[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
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
    const body: TeachConfirmBody = { name: name.trim(), unit: unit.trim() || 'each', sku: sku.trim() === '' ? null : sku.trim(), searchPhrase: sug && sug.name === name.trim() ? sug.searchPhrase : name.trim(), zoneId };
    if (body.name === '' || body.zoneId === '') return setError('Give it a name and a place.');
    const res = await send('POST', `/api/teach/${teach.id}/confirm`, body, bearer);
    setError(res.ok ? null : (res.message ?? 'Could not add it.'));
  };
  const cancel = async () => {
    const res = await send('POST', `/api/teach/${teach.id}/cancel`, undefined, bearer);
    setError(res.ok ? null : (res.message ?? 'Could not cancel.'));
  };
  return (
    <form className="stack" style={{ gap: 14 }} onSubmit={(e) => void submit(e)}>
      <p className="copy small">{teach.status === 'naming' ? 'Naming it.' : sug ? `Looks like ${sug.name}. ${SURE[sug.confidence].charAt(0).toUpperCase()}${SURE[sug.confidence].slice(1)}.` : (teach.error ?? 'Type a name to add it.')}</p>
      <label className="field"><span className="meta">Name</span><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus={focus} /></label>
      <label className="field"><span className="meta">One unit is</span><input value={unit} onChange={(e) => setUnit(e.target.value)} /></label>
      <label className="field"><span className="meta">Offcut SKU</span><input value={sku} onChange={(e) => setSku(e.target.value)} /></label>
      <label className="field"><span className="meta">Where it sits</span>
        <select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>{s.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select>
      </label>
      {error ? <Tag tone="alert" style={{ whiteSpace: 'normal', borderRadius: 14, lineHeight: 1.3 }}>{error}</Tag> : null}
      <button className="btn" type="submit">Confirm</button>
      <button className="btn quiet" type="button" onClick={() => void cancel()}>Not a part</button>
    </form>
  );
}
