/** Order: the part in a frame, what it costs, when it arrives, and the button that says yes. The plate and the word follow the order's state. */
import { unitsText } from '@reup/brain';
import type { Order as OrderT, Snapshot } from '@reup/contracts';
import { useEffect, useState } from 'react';
import { Frame, PartBox, Plate, Tag, Word } from '../../components';
import { call, hubUrl, yesKey } from '../../lib/hub';
import { focusOrder, money, orderMoment, runsFor, supplierName, totalLabel, weekday } from '../../lib/view';
import type { LiveState } from '../../store/reduce';
import { alertText, BottomBar, Steps, TopBar } from '../common';

/**
 * The one line above the Approve button, or null when the button says it all. It names only what can say yes right
 * now: the wooden button when the shelf node is connected, a phone when this screen cannot say yes itself.
 */
export function howToSayYes(nodeOnline: boolean, canSayYes: boolean): string | null {
  if (nodeOnline) return 'Press the wooden button to place the order.';
  return canSayYes ? null : 'Say yes from a phone to place the order.';
}

/** The words on the button. Miller's wording. */
export const APPROVE = 'Approve to place order';

/**
 * Saying yes on this screen: one Approve button to click, and Enter does the same. Only a screen that holds a key
 * has it, which is the station's own laptop or a board opened with ?k=. When the hub says no, the reason shows under it.
 */
export function ApproveHere({ order, k, send = call }: { order: OrderT; k: string | null; send?: typeof call }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approve = async () => {
    if (k == null || busy) return;
    setBusy(true);
    const res = await send('POST', `/api/orders/${order.id}/approve`, { by: 'keyboard' }, k);
    setBusy(false);
    setError(res.ok ? null : (res.message ?? 'Could not place the order.'));
  };
  useEffect(() => {
    if (k == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      // Enter inside a form or on a button already means something there.
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName)) return;
      void approve();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (k == null) return null;
  return (
    <div className="stack" style={{ gap: 18, alignItems: 'flex-start' }}>
      <button className="btn yes" type="button" disabled={busy} onClick={() => void approve()}>{APPROVE}</button>
      {error ? <Tag tone="alert" style={{ whiteSpace: 'normal', borderRadius: 14, lineHeight: 1.3 }}>{error}</Tag> : null}
    </div>
  );
}

/** The X on a finished order: back to the main view. Escape does the same. */
function Close({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <button className="close" type="button" aria-label="Back to the board" onClick={onClose}><i /><i /></button>;
}

/** onClose is given on the board: an X on a finished order goes back to the main view. */
export function Order({ live, onClose }: { live: LiveState; onClose?: () => void }) {
  const s = live.snapshot as Snapshot;
  const order = focusOrder(s);
  if (!order) {
    return (
      <Plate tone="paper" label="Order">
        <Word text="No order" at="top" quiet />
        <BottomBar credit="Nothing is waiting" alert={alertText(live)} />
      </Plate>
    );
  }
  const product = s.products.find((p) => p.id === order.productId);
  const moment = orderMoment(order, product);
  const supplier = supplierName(s, order.supplierId);
  const units = unitsText(order.units, product?.unit ?? 'each');
  const arrives = order.eta ? weekday(order.eta) : null;
  const alert = alertText(live);
  const quiet = !live.connected && !live.mock;
  const name = product?.name ?? 'This part';
  const picture = product?.imageUrl ? <img className="fill mat crop" src={hubUrl(product.imageUrl)} alt={name} /> : null;
  const box = picture ? null : <PartBox name={name} unit={product?.unit ?? 'each'} style={{ left: 640, top: moment.plate === 'paper' ? 350 : 240, width: 640, transform: 'rotate(-9deg)' }} />;

  if (moment.plate === 'paper') {
    const waiting = order.state === 'awaiting_approval';
    const k = yesKey(s);
    const line = waiting ? howToSayYes(s.node.online, k != null) : order.state === 'cancelled' ? 'Nothing was bought.' : 'Getting the cart ready.';
    return (
      <Plate tone="paper" label="Order">
        <Word text={moment.word} at="top" quiet={quiet} />
        <Frame label={`${name}, the part being ordered`} waiting={waiting} settle style={{ left: 730, top: 280, width: 460, height: 600 }}>{picture}</Frame>
        {box}
        <div className="abs stack" style={{ left: 96, top: 420, width: 560, gap: 34 }}>
          <div className="stack" style={{ gap: 12 }}>
            <span className="figure">{order.total != null ? money(order.total) : units}</span>
            <span className="meta">{order.total != null ? `${totalLabel(order)}${order.unitPrice != null ? ` · ${money(order.unitPrice)} each` : ''} · ${units}` : `From ${supplier}`}</span>
          </div>
          {arrives ? <div className="stack" style={{ gap: 12 }}><span className="figure mid">{arrives}</span><span className="meta">{`Arrives · from ${supplier}`}</span></div> : null}
        </div>
        <div className="abs stack" style={{ left: 1280, top: 420, width: 580, gap: 22 }}>
          {line ? <p className="figure mid">{line}</p> : null}
          {waiting ? <ApproveHere key={order.id} order={order} k={k} /> : null}
        </div>
        <BottomBar credit={null} alert={alert} />
      </Plate>
    );
  }

  const placing = order.state === 'approved' || order.state === 'placing';
  const failed = order.state === 'failed';
  const placeRun = runsFor(s, order, ['place']).at(-1);
  const done = !placing && !failed;
  return (
    <Plate tone={moment.plate} label="Order">
      <TopBar credit={null} alert={alert ?? (failed ? 'Stopped. Nothing was bought.' : null)} meta={`PO ${order.poNumber}`} right={onClose && !placing ? 216 : undefined} />
      {onClose && !placing ? <Close onClose={onClose} /> : null}
      {placing ? (
        <Frame label={`Placing the order at ${supplier}`} waiting settle style={{ left: 580, top: 150, width: 760, height: 600 }} tag={placeRun?.replay ? <Tag tone="cream">Replay</Tag> : undefined}>
          {placeRun?.streamingUrl && placeRun.status === 'running' && !placeRun.replay && !live.mock
            ? <iframe className="fill mat" src={placeRun.streamingUrl} title={`Live browser at ${supplier}`} sandbox="allow-scripts allow-same-origin" />
            : <Steps run={placeRun} empty="Opening a browser." />}
        </Frame>
      ) : (
        <>
          <Frame label={`${name}, the part ordered`} settle style={{ left: 730, top: 170, width: 460, height: 600 }}>{picture}</Frame>
          {box}
        </>
      )}
      <div className="abs stack" style={{ left: 96, top: 210, width: placing ? 440 : 580, gap: 12 }}>
        <span className="figure" style={done && order.confirmation ? { fontSize: 96 } : undefined}>{done && order.confirmation ? order.confirmation : order.total != null ? money(order.total) : units}</span>
        <span className="meta">{done && order.confirmation ? `Confirmation${arrives ? ` · arrives ${arrives}` : ''}${order.total != null ? ` · ${money(order.total)}` : ''}` : `${units} · from ${supplier}`}</span>
      </div>
      <div className="abs stack" style={{ left: placing ? 1400 : 1280, top: 210, width: placing ? 470 : 580, gap: 22 }}>
        <p className="figure mid">{placing ? `Placing the order at ${supplier}.` : failed ? 'Nothing was bought.' : order.state === 'received' ? 'Arrived. Back on the board.' : `Ordered.${arrives ? ` Arrives ${arrives}.` : ''}`}</p>
        <p className="copy small" style={{ maxWidth: '19em' }}>{failed ? (order.error ?? '') : `${units} of ${name.toLowerCase()} from ${supplier}.`}</p>
      </div>
      <Word text={moment.word} quiet={quiet} />
    </Plate>
  );
}
