/** The phone view: plates stacked as bands. Approve an order, name a new part, see the counts. */
import { unitsText } from '@reup/brain';
import type { CountCheck, Order, Snapshot } from '@reup/contracts';
import { useState } from 'react';
import { cx, Frame, Tag, Units, Word, Wordmark } from '../../components';
import { call, hubUrl, token } from '../../lib/hub';
import { money, partRows, shelfMoment, shortTime, supplierName, weekday, type Tone } from '../../lib/view';
import { useLive } from '../../store/live';
import { sentence } from '../shelf';
import { NO_KEY, TeachForm } from '../teach/form';

export { NO_KEY, TeachForm } from '../teach/form';

function Band({ tone, label, children, word }: { tone: Tone; label: string; word: string; children: React.ReactNode }) {
  return (
    <section className={cx('plate', tone, 'band stack')} style={{ gap: 14 }} aria-label={label}>
      <Word text={word} band />
      {children}
    </section>
  );
}

export function ApproveBand({ order, s, send = call, k = token('k'), first }: { order: Order; s: Snapshot; send?: typeof call; k?: string | null; first?: boolean }) {
  const [state, setState] = useState<'idle' | 'busy' | 'hidden'>('idle');
  const [error, setError] = useState<string | null>(null);
  const product = s.products.find((p) => p.id === order.productId);
  if (state === 'hidden') return null;
  const approve = async () => {
    if (!k) return setError(NO_KEY);
    setState('busy');
    const res = await send('POST', `/api/orders/${order.id}/approve`, { by: 'phone' }, k);
    setState('idle');
    setError(res.ok ? null : res.status === 401 ? NO_KEY : (res.message ?? 'Could not approve.'));
  };
  return (
    <Band tone="paper" label="Order waiting for approval" word={unitsText(order.units, product?.unit ?? 'each')}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {first ? <Wordmark /> : <span />}
        <Tag>Waiting for a yes</Tag>
      </div>
      <p className="name">{`${product?.name ?? 'Part'}, from ${supplierName(s, order.supplierId)}`}</p>
      <div className="stack" style={{ gap: 8 }}>
        <span className="figure">{order.total != null ? money(order.total) : ''}</span>
        <span className="meta">{`With tax${order.eta ? ` · arrives ${weekday(order.eta)}` : ''} · PO ${order.poNumber}`}</span>
      </div>
      {error ? <Tag tone="alert" style={{ whiteSpace: 'normal', borderRadius: 14, lineHeight: 1.3 }}>{error}</Tag> : null}
      <button className="btn" type="button" disabled={state === 'busy'} onClick={() => void approve()}>Approve</button>
      <button className="btn quiet" type="button" onClick={() => setState('hidden')}>Not now</button>
    </Band>
  );
}

/** A count check: the camera saw a drop far bigger than normal use. A person says whether it is right before reup shops. */
export function CheckBand({ check, s, send = call, k = token('k') }: { check: CountCheck; s: Snapshot; send?: typeof call; k?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zone = s.zones.find((z) => z.id === check.zoneId);
  const answer = async (value: 'right' | 'miscount') => {
    if (!k) return setError(NO_KEY);
    setBusy(true);
    const res = await send('POST', `/api/checks/${check.id}`, { answer: value }, k);
    setBusy(false);
    setError(res.ok ? null : res.status === 401 ? NO_KEY : (res.message ?? 'Could not answer.'));
  };
  return (
    <Band tone="wine" label="Count check" word="Check">
      <Tag tone="alert">{`${zone?.name ?? 'Part'} · ${check.before} to ${check.after}`}</Tag>
      <p className="copy small">{check.text}</p>
      {error ? <Tag tone="alert" style={{ whiteSpace: 'normal', borderRadius: 14, lineHeight: 1.3 }}>{error}</Tag> : null}
      <button className="btn" type="button" disabled={busy} onClick={() => void answer('right')}>That is right</button>
      <button className="btn quiet" type="button" disabled={busy} onClick={() => void answer('miscount')}>Miscount</button>
    </Band>
  );
}

export function Phone() {
  const live = useLive();
  const s = live.snapshot;
  if (!s) {
    return <section className="plate olive band" aria-label="Starting"><Word text="Starting" band quiet /><Wordmark /><p className="copy small" style={{ marginTop: 14 }}>Waiting for the hub.</p></section>;
  }
  const waiting = s.orders.filter((o) => o.state === 'awaiting_approval');
  const moment = shelfMoment(s);
  const rows = partRows(s);
  const offline = !live.connected && !live.mock;
  return (
    <div style={{ maxWidth: 520, margin: '0 auto' }}>
      {(s.checks ?? []).map((check) => <CheckBand key={check.id} check={check} s={s} />)}
      {waiting.map((order, i) => <ApproveBand key={order.id} order={order} s={s} first={i === 0} />)}
      {s.teach ? (
        <section className="plate paper band stack" style={{ gap: 14 }} aria-label="New part to confirm">
          <Word text="New part" band />
          <Frame label="The new part" waiting className="" style={{ height: 190, margin: '8px 7px' }}>
            {s.teach.cropUrl ? <img className="fill mat crop" src={hubUrl(s.teach.cropUrl)} alt="The new part" /> : null}
          </Frame>
          <TeachForm teach={s.teach} s={s} bearer={token('k')} />
        </section>
      ) : null}
      <section className={cx('plate', moment.plate, 'band')} aria-label="Counts">
        <Word text={moment.word} band quiet={moment.quiet || offline} />
        {waiting.length === 0 ? <Wordmark style={{ marginBottom: 10 }} /> : null}
        {offline ? <Tag tone="alert" style={{ whiteSpace: 'normal', borderRadius: 14, lineHeight: 1.3 }}>{`Hub unreachable. Showing the last counts from ${shortTime(live.syncedAt ?? s.now)}.`}</Tag> : null}
        {rows.map((row) => (
          <div className="line" key={row.product.id}>
            <span className={row.low ? 'figure low' : 'figure'}>{row.count}</span>
            <div className="stack" style={{ gap: 6 }}><span className="name">{row.product.name}</span><Units count={row.count} capacity={row.capacity} /><span className="meta">{row.meta}</span></div>
          </div>
        ))}
        <p className="copy small" style={{ marginTop: 14 }}>{sentence(s)}</p>
      </section>
    </div>
  );
}
