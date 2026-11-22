/** Why: the chart that shows the reorder point is reasoning, not a setting, and the season switch that moves it. */
import type { HistoryResult, Snapshot } from '@reup/contracts';
import { Frame, Plate, Word } from '../../components';
import { dateTicks } from '../../lib/analytics';
import { call, yesKey } from '../../lib/hub';
import { mockHistory } from '../../store/mock';
import type { LiveState } from '../../store/reduce';
import { alertText, BottomBar } from '../common';
import { askHub, askMock, AskReup } from './ask';
import { HISTORY_RETRY, HISTORY_WAIT, useHistory } from './history';

export { AskReup, sourceLine, ASK_FALLBACK, ASK_WAIT } from './ask';

/** How busy the shop is. It scales the use reup plans for, so the reorder line moves with it. */
export const SEASONS = [
  { label: 'Slow', factor: 0.6 },
  { label: 'Normal', factor: 1 },
  { label: 'Busy', factor: 1.4 },
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

/** Today as a day: the day after the last day behind it. The history lists the days before today and the days after. */
function todayDay(history: HistoryResult): string {
  const last = history.days.at(-1)?.day ?? history.forecast[0]?.day;
  if (!last) return '';
  const at = new Date(`${last}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + (history.days.length > 0 ? 1 : -1));
  return at.toISOString().slice(0, 10);
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
      {dateTicks([...history.days.map((d) => d.day), todayDay(history), ...history.forecast.map((f) => f.day)], today, 7).map((t) => (
        <g key={t.index}>
          <line className="tick" x1={x(t.index)} y1={Y0} x2={x(t.index)} y2={Y0 + 8} />
          <text x={x(t.index)} y={494} textAnchor="middle">{t.label}</text>
        </g>
      ))}
    </svg>
  );
}

export function Why({ live }: { live: LiveState }) {
  const s = live.snapshot as Snapshot;
  const product = s.products.find((p) => p.id === s.focusProductId) ?? s.products[0];
  const policy = s.policies.find((p) => p.productId === product?.id);
  const count = s.counts.find((c) => c.productId === product?.id)?.count ?? 0;
  const k = yesKey(s);
  const read = useHistory(product?.id, `${count}|${s.season.factor}|${s.orders.length}`, live.mock);
  const history = live.mock && product ? { ...(mockHistory as HistoryResult), productId: product.id } : read.history;

  const setSeason = (season: (typeof SEASONS)[number]) => void call('POST', '/api/demo/season', season, k);

  return (
    <Plate tone="paper" label="Why">
      <Word text="Forecast" at="top" quiet={!live.connected && !live.mock} />
      <Frame label={`${product?.name ?? 'Part'}: use, stock and forecast`} waiting={!history} settle style={{ left: 96, top: 284, width: 1100, height: 580 }}>
        {history && product ? <Chart history={history} count={count} capacity={product.capacity} reorderPoint={policy?.reorderPoint ?? history.reorderPoint} /> : null}
        {!history && product ? <p className="copy small abs" role="status" style={{ left: 40, top: 36 }}>{read.failed ? HISTORY_RETRY : HISTORY_WAIT}</p> : null}
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
              <button key={season.label} className="btn" type="button" aria-pressed={Math.abs(s.season.factor - season.factor) < 0.01} disabled={k == null && !live.mock} onClick={() => setSeason(season)}>{season.label}</button>
            ))}
          </div>
        </div>
        <AskReup ask={live.mock ? askMock : askHub} />
      </div>
      <BottomBar credit={null} alert={alertText(live)} />
    </Plate>
  );
}
