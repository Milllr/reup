/** Shop: one frame per browser the buyer is driving, its result above it, and the part being bought. */
import { unitsText, unitWord } from '@reup/brain';
import type { Order, Product, Quote, Run, Snapshot, Supplier } from '@reup/contracts';
import { Frame, Plate, Tag, Word } from '../../components';
import { focusOrder, money, partRows, runsFor } from '../../lib/view';
import type { LiveState } from '../../store/reduce';
import { alertText, ordering, PartLine, Steps, TopBar } from '../common';

export interface Pane {
  supplier: Supplier;
  kind: 'market' | 'cart';
  run: Run | undefined;
  /** queued or running with no picture yet, live with a picture, done, failed */
  state: 'loading' | 'live' | 'done' | 'failed';
  /** The words on the frame's top edge. Null for the plain case at the supplier: the frame needs no label then. */
  tag: string | null;
  figure: string;
  meta: string;
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** One pane per price check, then the cart at the account supplier. */
export function panes(s: Snapshot, order: Order, product: Product | undefined): Pane[] {
  const marketRuns = runsFor(s, order, ['market']);
  const cartRun = runsFor(s, order, ['cart']).at(-1);
  const out: Pane[] = [];
  for (const supplier of s.suppliers.filter((x) => x.kind === 'market').slice(0, 2)) {
    const run = marketRuns.filter((r) => r.supplierId === supplier.id).at(-1);
    const quote: Quote | undefined = s.quotes.find((q) => q.supplierId === supplier.id && q.productId === order.productId);
    const replay = run?.replay ? ' · replay' : '';
    if ((quote && !quote.ok) || run?.status === 'failed' || run?.status === 'cancelled') {
      out.push({ supplier, kind: 'market', run, state: 'failed', tag: `Blocked · ${supplier.name}${replay}`, figure: 'No price', meta: run?.error ?? 'No price from this one' });
    } else if (quote?.ok && quote.unitPrice != null && (!run || run.status === 'completed')) {
      const stock = quote.inStock === false ? 'out of stock' : 'in stock';
      out.push({ supplier, kind: 'market', run, state: 'done', tag: `Price check · ${supplier.name}${replay}`, figure: money(quote.unitPrice), meta: `A ${unitWord(product?.unit ?? 'each')} · ${stock}${quote.deliveryDays != null ? ` · ${days(quote.deliveryDays)}` : ''}` });
    } else {
      out.push(working(supplier, 'market', run, `Price check · ${supplier.name}${replay}`));
    }
  }
  const account = s.suppliers.find((x) => x.id === order.supplierId);
  if (account) {
    const replay = cartRun?.replay ? ' · replay' : '';
    const tag = cartRun?.replay ? 'Replay' : null;
    if (order.state === 'failed' || cartRun?.status === 'failed') out.push({ supplier: account, kind: 'cart', run: cartRun, state: 'failed', tag: `Stopped · ${account.name}${replay}`, figure: 'No cart', meta: cartRun?.error ?? order.error ?? 'The cart could not be filled' });
    else if (order.total != null) out.push({ supplier: account, kind: 'cart', run: cartRun, state: 'done', tag, figure: money(order.total), meta: `${unitsText(order.units, product?.unit ?? 'each')} in the cart · with tax` });
    else out.push(working(account, 'cart', cartRun, tag));
  }
  return out;
}

function working(supplier: Supplier, kind: Pane['kind'], run: Run | undefined, tag: string | null): Pane {
  if (!run || run.steps.length === 0) return { supplier, kind, run, state: run?.streamingUrl ? 'live' : 'loading', tag, figure: 'Starting', meta: 'Opening a browser.' };
  return { supplier, kind, run, state: run.streamingUrl ? 'live' : 'loading', tag, figure: `Step ${run.steps.length}`, meta: run.steps.at(-1)?.purpose ?? '' };
}

export function shopSentence(s: Snapshot, list: Pane[], order: Order): string {
  const account = s.suppliers.find((x) => x.id === order.supplierId)?.name ?? 'the supplier';
  const market = list.filter((p) => p.kind === 'market');
  const back = market.filter((p) => p.state === 'done' || p.state === 'failed').length;
  const cart = list.find((p) => p.kind === 'cart');
  const first = cart?.state === 'done' ? `The cart is ready at ${account}.` : `Filling a cart at ${account}.`;
  const second = market.length > 0 ? ` ${back} of ${market.length} price ${market.length === 1 ? 'check' : 'checks'} came back.` : '';
  return `${first}${second}`;
}

const LEFTS = [96, 688, 1280];

export function Shop({ live }: { live: LiveState }) {
  const s = live.snapshot as Snapshot;
  const order = focusOrder(s);
  const product = s.products.find((p) => p.id === order?.productId);
  const row = partRows(s).find((r) => r.product.id === product?.id);
  const list = order ? panes(s, order, product) : [];
  const local = list.some((p) => p.run?.engine === 'local');
  const alert = alertText(live) ?? (!s.buyerOnline && !live.mock ? 'The buyer is offline.' : null);
  const first = LEFTS.length - list.length;

  return (
    <Plate tone="wine" label="Shop">
      <TopBar credit={local ? 'Shopped by a local stand in, not on the live web' : 'Shopped by TinyFish on the live web'} alert={alert} meta={order ? `PO ${order.poNumber}` : undefined} />
      {order ? <p className="copy abs" style={{ left: 96, top: 140, maxWidth: 860, fontSize: 34 }}>{shopSentence(s, list, order)}</p> : null}
      {row && order ? <PartLine row={{ ...row, low: true }} meta={ordering(order.units, row.product.unit)} style={{ position: 'absolute', zIndex: 6, left: 1280, top: 140 }} /> : null}

      {list.map((pane, i) => {
        const left = LEFTS[Math.max(0, first) + i] ?? 96;
        return (
          <div key={`${pane.kind}-${pane.supplier.id}`}>
            <div className="abs stack" style={{ left, top: 322, width: 544, gap: 10 }}>
              <span className="figure mid" style={{ whiteSpace: 'nowrap' }}>{pane.figure}</span>
              <span className="meta" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pane.meta}</span>
            </div>
            <Frame label={pane.tag ?? `The cart at ${pane.supplier.name}`} waiting={pane.state === 'loading' || pane.state === 'live'} settle style={{ left, top: 450, width: 544, height: 400 }} tag={pane.tag ? <Tag tone={pane.state === 'failed' ? 'alert' : 'cream'}>{pane.tag}</Tag> : undefined}>
              {pane.state === 'live' && pane.run?.streamingUrl && !pane.run.replay && !live.mock ? (
                <iframe className="fill mat" src={pane.run.streamingUrl} title={`Live browser at ${pane.supplier.name}`} sandbox="allow-scripts allow-same-origin" />
              ) : (
                <Steps run={pane.run} empty={pane.state === 'loading' ? '' : pane.meta} />
              )}
            </Frame>
          </div>
        );
      })}

      <Word text="Shopping" quiet={!live.connected && !live.mock} />
    </Plate>
  );
}
