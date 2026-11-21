/** Order: the part in a frame, what it costs, when it arrives, and the wooden button. The plate and the word follow the order's state. */
import { unitsText } from '@reup/brain';
import type { Order as OrderT, Snapshot } from '@reup/contracts';
import { Frame, PartBox, Plate, Tag, Word } from '../../components';
import { hubUrl } from '../../lib/hub';
import { clock, focusOrder, money, orderMoment, runsFor, supplierName, weekday } from '../../lib/view';
import type { LiveState } from '../../store/reduce';
import { alertText, BottomBar, Steps, TopBar } from '../common';

const who = (o: OrderT) => (o.approvedBy === 'button' ? 'with the button' : o.approvedBy === 'phone' ? 'from a phone' : null);

/** The mono line that says where the order stands. */
export function orderTag(o: OrderT, s: Snapshot): string {
  const cap = 'spend cap $150 an order';
  const by = who(o);
  const at = by ? `Approved ${by} at ${clock(o.updatedAt).replace(/^\w+ /, '')}` : null;
  switch (o.state) {
    case 'pricing':
    case 'carting':
      return `Getting prices · PO ${o.poNumber}`;
    case 'awaiting_approval':
      return `Waiting for a yes · PO ${o.poNumber} · ${cap}`;
    case 'approved':
    case 'placing':
      return by ? `Approved ${by} · PO ${o.poNumber}` : `PO ${o.poNumber}`;
    case 'placed':
      return `Bought by reup${at ? ` · ${at.toLowerCase()}` : ''}`;
    case 'shipped':
    case 'received':
      return o.state === 'received' ? `Received · PO ${o.poNumber}` : `Shipped${o.eta ? ` · arrives ${weekday(o.eta)}` : ''}`;
    case 'failed':
      return `Stopped · PO ${o.poNumber}`;
    case 'cancelled':
      return `Cancelled · PO ${o.poNumber}`;
  }
  return supplierName(s, o.supplierId);
}

export function Order({ live }: { live: LiveState }) {
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
    return (
      <Plate tone="paper" label="Order">
        <Word text={moment.word} at="top" quiet={quiet} />
        <Frame label={`${name}, the part being ordered`} waiting={waiting} settle style={{ left: 730, top: 280, width: 460, height: 600 }}>{picture}</Frame>
        {box}
        <div className="abs stack" style={{ left: 96, top: 420, width: 560, gap: 34 }}>
          <div className="stack" style={{ gap: 12 }}>
            <span className="figure">{order.total != null ? money(order.total) : units}</span>
            <span className="meta">{order.total != null ? `Total with tax${order.unitPrice != null ? ` · ${money(order.unitPrice)} each` : ''} · ${units}` : `From ${supplier}`}</span>
          </div>
          {arrives ? <div className="stack" style={{ gap: 12 }}><span className="figure mid">{arrives}</span><span className="meta">{`Arrives · from ${supplier}`}</span></div> : null}
          <p className="copy small" style={{ maxWidth: '21em' }}>{[order.reason, order.marketNote].filter(Boolean).join(' ')}</p>
        </div>
        <div className="abs stack" style={{ left: 1280, top: 420, width: 580, gap: 22 }}>
          <p className="figure mid">{waiting ? 'Press the button to approve.' : order.state === 'cancelled' ? 'Nothing was bought.' : 'Getting the cart ready.'}</p>
          {waiting ? <p className="copy small" style={{ maxWidth: '19em' }}>Or approve from a phone. Nothing is bought until then.</p> : null}
        </div>
        <BottomBar credit={orderTag(order, s)} alert={alert} />
      </Plate>
    );
  }

  const placing = order.state === 'approved' || order.state === 'placing';
  const failed = order.state === 'failed';
  const placeRun = runsFor(s, order, ['place']).at(-1);
  const done = !placing && !failed;
  return (
    <Plate tone={moment.plate} label="Order">
      <TopBar credit={orderTag(order, s)} alert={alert ?? (failed ? 'Stopped. Nothing was bought.' : null)} meta={`PO ${order.poNumber}`} />
      {placing ? (
        <Frame label="Placing the order" waiting settle style={{ left: 580, top: 150, width: 760, height: 600 }} tag={<Tag tone="cream">{`Your supplier · ${supplier}${placeRun?.replay ? ' · replay' : ''}`}</Tag>}>
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
