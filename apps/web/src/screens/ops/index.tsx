/** The operator page: set up the board and rescue the demo from one place. Paper plate, type on the plate, one frame for the board. */
import type { Snapshot, Zone } from '@reup/contracts';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Frame, Tag, Wordmark } from '../../components';
import { call, setToken, token } from '../../lib/hub';
import { clock, duration, supplierName, zoneBox } from '../../lib/view';
import { useLive } from '../../store/live';
import { TeachForm } from '../phone';
import { ZoneDrawing } from '../shelf';
import { SEASONS } from '../why';
import { addZone, moveCorner, moveZone, patchZone } from './zones';

type Drag = { zoneId: string; corner: number | null; x: number; y: number };

export function ZoneEditor({ s, ops, send = call }: { s: Snapshot; ops: string; send?: typeof call }) {
  const [zones, setZones] = useState<Zone[]>(s.zones);
  const [camera, setCamera] = useState<Zone['camera']>('board');
  const [selected, setSelected] = useState<string | null>(s.zones[0]?.id ?? null);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  // Take the hub's zones whenever there are no unsaved edits.
  useEffect(() => {
    if (!dirty) setZones(s.zones);
  }, [s.zones, dirty]);

  const change = (next: Zone[]) => {
    setZones(next);
    setDirty(true);
    setNote(null);
  };
  const at = (e: PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    return r && r.width > 0 ? { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } : { x: 0, y: 0 };
  };
  const down = (e: PointerEvent, zoneId: string, corner: number | null) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setSelected(zoneId);
    drag.current = { zoneId, corner, ...at(e) };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = at(e);
    change(d.corner == null ? moveZone(zones, d.zoneId, p.x - d.x, p.y - d.y) : moveCorner(zones, d.zoneId, d.corner, p.x, p.y));
    drag.current = { ...d, ...p };
  };
  const up = () => {
    drag.current = null;
  };

  const save = async () => {
    const res = await send('PUT', '/api/zones', { zones }, ops);
    setNote(res.ok ? 'Saved.' : (res.message ?? 'Could not save.'));
    if (res.ok) setDirty(false);
  };
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const cam = s.cameras.find((c) => c.id === camera);
  const picture = cam?.streamUrl && cam.online && failedUrl !== cam.streamUrl ? cam.streamUrl : null;
  const capture = async () => {
    if (!cam?.streamUrl) return setNote('The eye is not reachable from this page.');
    try {
      const res = await fetch(cam.streamUrl.replace(/\/stream\/(\w+)\.mjpg.*$/, '/reference/$1'), { method: 'POST' });
      setNote(res.ok ? 'Empty board captured.' : 'The eye could not capture the board.');
    } catch {
      setNote('The eye is not reachable from this page.');
    }
  };
  const zone = zones.find((z) => z.id === selected);
  const shown = zones.filter((z) => z.camera === camera);

  return (
    <section className="stack" style={{ gap: 18 }} aria-label="Zone editor">
      <div className="wrap">
        <span className="name">Zones</span>
        <div className="seg" role="group" aria-label="Camera">
          {(['board', 'aux', 'node'] as const).map((c) => <button key={c} type="button" className="btn" aria-pressed={camera === c} onClick={() => setCamera(c)}>{c}</button>)}
        </div>
        <button type="button" className="btn quiet" onClick={() => change(addZone(zones, camera))}>Add zone</button>
        <button type="button" className="btn quiet" onClick={() => void capture()}>Capture empty board</button>
        <button type="button" className="btn" disabled={!dirty} onClick={() => void save()}>Save zones</button>
        {note ? <span className="meta" role="status">{note}</span> : null}
      </div>
      <Frame label={`Zones on the ${camera} camera`} style={{ width: 1064, height: 614 }}>
        <div className="fill mat feed" ref={box} onPointerMove={move} onPointerUp={up} onPointerLeave={up}>
          {picture ? <img src={picture} alt="" onError={() => setFailedUrl(picture)} /> : null}
          {shown.map((z) => (
            <div key={z.id} className={`zone editing${z.id === selected ? ' selected' : ''}`} style={zoneBox(z.quad)} onPointerDown={(e) => down(e, z.id, null)}>
              {picture ? null : <ZoneDrawing zone={z} count={s.counts.find((c) => c.zoneId === z.id)} />}
              <Tag tone="cream">{z.name}</Tag>
            </div>
          ))}
          <svg className="outlines" viewBox="0 0 1 1" preserveAspectRatio="none" style={{ pointerEvents: 'none' }}>
            {shown.map((z) => <polygon key={z.id} className="outline" style={{ stroke: z.id === selected ? 'var(--orange)' : undefined }} points={z.quad.map((p) => p.join(',')).join(' ')} />)}
          </svg>
          {zone && zone.camera === camera ? zone.quad.map((p, i) => (
            <i key={i} role="slider" aria-label={`Corner ${i + 1} of ${zone.name}`} aria-valuenow={Math.round(p[0] * 100)} tabIndex={0}
              style={{ position: 'absolute', zIndex: 7, left: `${p[0] * 100}%`, top: `${p[1] * 100}%`, width: 22, height: 22, margin: -11, background: 'var(--orange)', cursor: 'grab', touchAction: 'none' }}
              onPointerDown={(e) => down(e, zone.id, i)} />
          )) : null}
        </div>
      </Frame>
      {zone ? (
        <div className="wrap" style={{ alignItems: 'flex-end' }}>
          <label className="field"><span className="meta">Name</span><input value={zone.name} onChange={(e) => change(patchZone(zones, zone.id, { name: e.target.value }))} /></label>
          <label className="field"><span className="meta">Kind</span>
            <select value={zone.kind} onChange={(e) => change(patchZone(zones, zone.id, { kind: e.target.value as Zone['kind'] }))}><option value="pockets">pockets</option><option value="open">open</option><option value="bin">bin</option></select>
          </label>
          {zone.kind === 'pockets' ? (
            <>
              <label className="field"><span className="meta">Rows</span><input type="number" min={1} max={12} style={{ width: 90 }} value={zone.rows ?? 1} onChange={(e) => change(patchZone(zones, zone.id, { rows: Number(e.target.value) || 1 }))} /></label>
              <label className="field"><span className="meta">Cols</span><input type="number" min={1} max={12} style={{ width: 90 }} value={zone.cols ?? 1} onChange={(e) => change(patchZone(zones, zone.id, { cols: Number(e.target.value) || 1 }))} /></label>
            </>
          ) : null}
          <label className="field"><span className="meta">Part</span>
            <select value={zone.productId ?? ''} onChange={(e) => change(patchZone(zones, zone.id, { productId: e.target.value === '' ? null : e.target.value }))}>
              <option value="">None</option>
              {s.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <button type="button" className="btn quiet" onClick={() => { change(zones.filter((z) => z.id !== zone.id)); setSelected(null); }}>Remove zone</button>
        </div>
      ) : <span className="meta">Pick a zone to edit it, or add one.</span>}
    </section>
  );
}

export function Controls({ s, ops, send = call }: { s: Snapshot; ops: string; send?: typeof call }) {
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [replay, setReplay] = useState({ market: false, cart: false, place: false });
  const [productId, setProductId] = useState(s.products[0]?.id ?? '');
  const say = (res: { ok: boolean; message: string | null }, good: string) => setNote(res.ok ? good : (res.message ?? 'That did not work.'));
  const open = s.orders.filter((o) => ['pricing', 'carting', 'awaiting_approval', 'approved', 'placing'].includes(o.state));

  // Reset asks first: one press arms it, a second press within 4 seconds does it.
  const reset = async () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    say(await send('POST', '/api/demo/reset', undefined, ops), 'Reset. Put the parts back.');
  };
  const screen = async (name: 'shelf' | 'shop' | 'order' | 'why' | null) =>
    say(await send('POST', '/api/demo/screen', { screen: name, focusProductId: name ? (s.focusProductId ?? s.orders.at(-1)?.productId ?? s.products[0]?.id ?? null) : null }, ops), name ? `Showing ${name}.` : 'The hub chooses the screen again.');
  const flip = async (kind: 'market' | 'cart' | 'place') => {
    const on = !replay[kind];
    const res = await send('POST', '/api/demo/replay', { kind, on }, ops);
    if (res.ok) setReplay({ ...replay, [kind]: on });
    say(res, `Replay for ${kind} is ${on ? 'on' : 'off'}.`);
  };

  return (
    <section className="stack" style={{ gap: 22 }} aria-label="Controls">
      <div className="wrap">
        <button type="button" className="btn" onClick={() => void reset()}>{armed ? 'Press again to reset' : 'Reset demo'}</button>
        {note ? <span className="meta" role="status">{note}</span> : null}
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <span className="meta">Screen</span>
        <div className="seg" role="group" aria-label="Screen">
          {(['shelf', 'shop', 'order', 'why'] as const).map((name) => <button key={name} type="button" className="btn" aria-pressed={s.screen === name} onClick={() => void screen(name)}>{name}</button>)}
          <button type="button" className="btn" aria-pressed={false} onClick={() => void screen(null)}>auto</button>
        </div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <span className="meta">Season</span>
        <div className="seg" role="group" aria-label="Season">
          {SEASONS.map((season) => <button key={season.label} type="button" className="btn" aria-pressed={Math.abs(s.season.factor - season.factor) < 0.01} onClick={async () => say(await send('POST', '/api/demo/season', season, ops), `Season: ${season.label}.`)}>{season.label}</button>)}
        </div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <span className="meta">Replay the last good run in place of a live one</span>
        <div className="seg" role="group" aria-label="Replay">
          {(['market', 'cart', 'place'] as const).map((kind) => <button key={kind} type="button" className="btn" aria-pressed={replay[kind]} onClick={() => void flip(kind)}>{kind}</button>)}
        </div>
      </div>
      <div className="wrap" style={{ alignItems: 'flex-end' }}>
        <label className="field"><span className="meta">Start an order for</span>
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>{s.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </label>
        <button type="button" className="btn quiet" disabled={productId === ''} onClick={async () => say(await send('POST', '/api/orders', { productId }, ops), 'Order started.')}>Start order</button>
        {open.map((o) => <button key={o.id} type="button" className="btn quiet" onClick={async () => say(await send('POST', `/api/orders/${o.id}/cancel`, undefined, ops), `Order ${o.poNumber} cancelled.`)}>{`Cancel order ${o.poNumber}`}</button>)}
      </div>
    </section>
  );
}

export function Health({ s }: { s: Snapshot }) {
  const disagreement = [...s.activity].reverse().find((a) => a.tone === 'attention' && a.text.includes('disagree'));
  return (
    <section className="stack" style={{ gap: 8 }} aria-label="Health">
      <span className="name">Health</span>
      {s.cameras.length === 0 ? <span className="meta">No camera has reported yet</span> : s.cameras.map((c) => <span className="meta" key={c.id}>{`Camera ${c.id} · ${c.online ? 'online' : 'offline'} · ${Math.round(c.fps)} fps`}</span>)}
      <span className="meta">{`Shelf node · ${s.node.online ? 'online' : 'offline'} · level ${s.node.level} · last seen ${s.node.lastSeen ? clock(s.node.lastSeen) : 'never'} · ${s.node.queued} queued · ${s.node.visionRestarts} vision restarts`}</span>
      <span className="meta">{`Buyer · ${s.buyerOnline ? 'connected' : 'not connected'}`}</span>
      {disagreement ? <Tag tone="alert" style={{ alignSelf: 'flex-start' }}>{disagreement.text}</Tag> : <span className="meta">The eye and the node agree</span>}
    </section>
  );
}

export function RunLog({ s }: { s: Snapshot }) {
  const runs = [...s.runs].reverse();
  return (
    <section className="stack" style={{ gap: 8 }} aria-label="Run log">
      <span className="name">Runs</span>
      {runs.length === 0 ? <span className="meta">No runs yet</span> : (
        <table>
          <thead><tr className="meta"><th>Kind</th><th>Supplier</th><th>Status</th><th>Took</th></tr></thead>
          <tbody>
            {runs.map((r) => <tr className="meta" key={r.id}><td>{r.kind}{r.replay ? ' · replay' : ''}</td><td>{supplierName(s, r.supplierId)}</td><td>{r.error ? `${r.status}: ${r.error}` : r.status}</td><td>{duration(r, s.now)}</td></tr>)}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Ops() {
  const live = useLive();
  const [ops, setOps] = useState<string | null>(token('ops'));
  const [typed, setTyped] = useState('');
  const s = live.snapshot;
  return (
    <main className="plate paper ops" aria-label="Operator">
      <h1 className={`word top${!live.connected && !live.mock ? ' quiet' : ''}`} style={{ ['--size' as string]: 190 }}>Operator</h1>
      {!ops ? (
        <form className="stack" style={{ gap: 14, maxWidth: 420 }} onSubmit={(e) => { e.preventDefault(); if (typed.trim() !== '') { setToken('ops', typed.trim()); setOps(typed.trim()); } }}>
          <label className="field"><span className="meta">Ops token</span><input type="password" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus /></label>
          <button className="btn" type="submit">Open the operator page</button>
        </form>
      ) : !s ? <p className="copy">Waiting for the hub.</p> : (
        <>
          <div className="stack" style={{ gap: 28 }}>
            <ZoneEditor s={s} ops={ops} />
          </div>
          <div className="stack" style={{ gap: 34 }}>
            {!live.connected && !live.mock ? <Tag tone="alert" style={{ alignSelf: 'flex-start' }}>Hub unreachable.</Tag> : null}
            <Controls s={s} ops={ops} />
            {s.teach ? <section className="stack" style={{ gap: 10 }} aria-label="New part to confirm"><span className="name">New part on the teach spot</span><TeachForm teach={s.teach} s={s} bearer={ops} /></section> : null}
            <Health s={s} />
            <RunLog s={s} />
            <Wordmark />
          </div>
        </>
      )}
    </main>
  );
}
