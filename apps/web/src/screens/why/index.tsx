/** Why: the chart that shows the reorder point is reasoning, not a setting, and the season switch that moves it. */
import type { HistoryResult, Snapshot } from '@reup/contracts';
import { useEffect, useState } from 'react';
import { Frame, Plate, Word } from '../../components';
import { call, token } from '../../lib/hub';
import { mockHistory } from '../../store/mock';
import type { LiveState } from '../../store/reduce';
import { alertText, BottomBar } from '../common';
import { askHub, askMock, AskReup } from './ask';

export { AskReup, sourceLine, ASK_EMPTY, ASK_FALLBACK, ASK_WAIT } from './ask';

export const SEASONS = [
  { label: 'Normal', factor: 1 },
  { label: 'Busy week', factor: 1.4 },
  { label: 'Exam week', factor: 0.6 },
] as const;

const X0 = 40;
const X1 = 940;
const Y0 = 470;
const TOP = 62;

/** Where things go in the 980 by 500 chart box: 30 past days, today, then 7 days ahead. */
export function scales(history: HistoryResult, count: number, capacity: number | null) {
  const columns = history.days.length + history.forecast.length;
  const step = (X1 - X0) / Math.max(1, columns);
  const max = Math.max(1, capacity ?? 0, count, history.reorderPoint, ...history.days.map((d) => d.endCount), ...history.forecast.map((f) => f.high));
  const unit = (Y0 - TOP) / max;
  return { x: (i: number) => Math.round((X0 + i * step) * 10) / 10, y: (v: number) => Math.round((Y0 - v * unit) * 10) / 10, step, unit, today: history.days.length };
}

export function Chart({ history, count, capacity, reorderPoint }: { history: HistoryResult; count: number; capacity: number | null; reorderPoint: number }) {
  const sc = scales(history, count, capacity);
  const { x, y, today } = sc;
  const ends = [...history.days.map((d) => d.endCount), count];
  const usedToday = Math.max(0, (history.days.at(-1)?.endCount ?? count) - count);
  const used = [...history.days.map((d) => d.used), usedToday];
  // A stepped line: stock holds through a day and drops, or jumps, at the next.
  const line: string[] = [];
  ends.forEach((v, i) => {
    if (i > 0 && ends[i - 1] !== v) line.push(`${x(i)},${y(ends[i - 1] ?? v)}`);
    if (i === 0 || ends[i - 1] !== v || i === ends.length - 1) line.push(`${x(i)},${y(v)}`);
  });
  const upper = [`${x(today)},${y(count)}`, ...history.forecast.map((f, i) => `${x(today + 1 + i)},${y(f.high)}`)];
  const lower = [...history.forecast.map((f, i) => `${x(today + 1 + i)},${y(f.low)}`).reverse()];
  const barW = Math.max(6, Math.round(sc.step * 0.62));
  return (
    <svg className="chart" viewBox="0 0 980 500" role="img" aria-label={`Stock over the last 30 days, ${count} on the board today, and the next 7 days. The reorder point is ${reorderPoint}.`}>
      {used.map((u, i) => (u > 0 ? <rect key={i} className="bar" x={x(i) - barW / 2} y={y(u)} width={barW} height={Y0 - y(u)} /> : null))}
      <polygon className="band" points={[...upper, ...lower].join(' ')} />
      <polyline className="stock" points={line.join(' ')} />
      <line className="today" x1={x(today)} y1={40} x2={x(today)} y2={Y0} />
      <g className="rop" style={{ transform: `translateY(${y(reorderPoint)}px)` }}>
        <line x1={20} y1={0} x2={960} y2={0} stroke="inherit" strokeWidth="inherit" />
        <text x={20} y={-12} style={{ stroke: 'none' }}>{`Reorder at ${reorderPoint}`}</text>
      </g>
      <text x={x(today) - 12} y={28} textAnchor="end">Today</text>
      <text x={x(today) + 14} y={28}>Next 7 days</text>
      <text x={20} y={494}>30 days ago</text>
    </svg>
  );
}

export function Why({ live }: { live: LiveState }) {
  const s = live.snapshot as Snapshot;
  const product = s.products.find((p) => p.id === s.focusProductId) ?? s.products[0];
  const policy = s.policies.find((p) => p.productId === product?.id);
  const count = s.counts.find((c) => c.productId === product?.id)?.count ?? 0;
  const [history, setHistory] = useState<HistoryResult | null>(null);
  const ops = token('ops');
  const refetchOn = `${product?.id}|${count}|${s.season.factor}|${s.orders.length}`;

  useEffect(() => {
    if (!product) return;
    if (live.mock) return setHistory({ ...(mockHistory as HistoryResult), productId: product.id });
    let stale = false;
    void call<HistoryResult>('GET', `/api/products/${encodeURIComponent(product.id)}/history`).then((r) => {
      if (!stale && r.ok && r.data) setHistory(r.data);
    });
    return () => {
      stale = true;
    };
  }, [refetchOn, live.mock]);

  const setSeason = (season: (typeof SEASONS)[number]) => void call('POST', '/api/demo/season', season, ops);
  const sample = history?.days.some((d) => d.sample) ?? policy?.sampleHistory ?? false;

  return (
    <Plate tone="paper" label="Why">
      <Word text="Forecast" at="top" quiet={!live.connected && !live.mock} />
      <Frame label={`${product?.name ?? 'Part'}: use, stock and forecast`} waiting={!history} settle style={{ left: 96, top: 284, width: 1100, height: 580 }}>
        {history && product ? <Chart history={history} count={count} capacity={product.capacity} reorderPoint={policy?.reorderPoint ?? history.reorderPoint} /> : null}
      </Frame>
      <div className="abs stack" style={{ left: 1284, top: 396, width: 588, gap: 26 }}>
        <div className="row">
          <span className="figure">{policy?.reorderPoint ?? 0}</span>
          <div className="stack" style={{ gap: 8, paddingBottom: 4 }}><span className="name">{product?.name ?? 'No part'}</span><span className="meta">Reorder point</span></div>
        </div>
        <p className="copy">{policy?.reason ?? 'No history yet.'}</p>
        <div className="stack" style={{ gap: 10 }}>
          <span className="meta">Season</span>
          <div className="seg" role="group" aria-label="Season">
            {SEASONS.map((season) => (
              <button key={season.label} className="btn" type="button" aria-pressed={Math.abs(s.season.factor - season.factor) < 0.01} disabled={!ops && !live.mock} onClick={() => setSeason(season)}>{season.label}</button>
            ))}
          </div>
        </div>
        <AskReup ask={live.mock ? askMock : askHub} />
      </div>
      <p className="copy small abs" style={{ left: 268, bottom: 40, maxWidth: '30em' }}>Bars are what was used each day. The line is what was on the board. The shaded part is what reup expects next.</p>
      <BottomBar credit={sample ? 'Sample history' : null} alert={alertText(live)} />
    </Plate>
  );
}
