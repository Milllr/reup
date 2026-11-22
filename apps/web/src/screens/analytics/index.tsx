/** Analytics: every part on the board, the 30 days behind it, today as the cameras saw it, and what reup expects to order next. A page that scrolls, for a laptop. */
import { AnalyticsResult, type AnalyticsPart } from '@reup/contracts';
import { useEffect, useState, type MouseEvent } from 'react';
import { Frame, Tag, Units, Word, Wordmark } from '../../components';
import { BOX, byHour, columns, dayLabel, daysBetween, describe, feed, hourLabel, money, movers, nextOrder, partLine, scale, shortDay, standing, stepped, timeOf, totals, useByDay, weekChange } from '../../lib/analytics';
import { call } from '../../lib/hub';
import { useLive } from '../../store/live';
import { mockAnalytics } from '../../store/mock';
import type { LiveState } from '../../store/reduce';
import { alertText } from '../common';
import { Items } from './items';

/** Reads the analytics again whenever a count, an order or the season changes, and once a minute so the day rolls over. */
export function useAnalytics(live: LiveState, fetcher: typeof call = call): AnalyticsResult | null {
  const [data, setData] = useState<AnalyticsResult | null>(null);
  const s = live.snapshot;
  const key = s ? `${s.counts.map((c) => `${c.productId}:${c.count}`).join(',')}|${s.orders.map((o) => `${o.id}:${o.state}`).join(',')}|${s.season.factor}|${s.products.map((p) => `${p.id}:${p.name}:${p.sku ?? ''}`).join(',')}` : '';
  useEffect(() => {
    if (live.mock) {
      setData(AnalyticsResult.parse(mockAnalytics));
      return;
    }
    let stale = false;
    const load = () => void fetcher<unknown>('GET', '/api/analytics').then((r) => {
      const parsed = r.ok ? AnalyticsResult.safeParse(r.data) : null;
      if (!stale && parsed?.success) setData(parsed.data);
    });
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [key, live.mock, fetcher]);
  return data;
}

function Tile({ figure, label, note }: { figure: string; label: string; note?: string }) {
  return (
    <div className="stack tile">
      <span className="figure mid">{figure}</span>
      <span className="meta">{label}</span>
      {note ? <span className="copy small">{note}</span> : null}
    </div>
  );
}

/** Stock as one line: stepped where it was counted, dashed where it is expected. Squares mark the days reup orders and the days a delivery lands. */
export function StockChart({ part, today }: { part: AnalyticsPart; today: string }) {
  const cols = columns(part, today);
  const sc = scale(part, cols);
  const now = cols.findIndex((c) => c.when === 'today');
  const [hover, setHover] = useState<number | null>(null);
  const seen = cols.slice(0, now + 1);
  const ahead = cols.slice(now);
  const move = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width > 0) setHover(sc.at(((e.clientX - r.left) / r.width) * BOX.w));
  };
  const tip = hover != null ? cols[hover] : undefined;
  const tipLines = tip ? describe(tip, part) : [];
  const tipW = Math.max(150, ...tipLines.map((line) => line.length * 9.4 + 28));
  const tipX = hover != null ? (sc.x(hover) + 14 + tipW > BOX.w ? sc.x(hover) - 14 - tipW : sc.x(hover) + 14) : 0;
  return (
    <svg className="chart" viewBox={`0 0 ${BOX.w} ${BOX.h}`} role="img" onMouseMove={move} onMouseLeave={() => setHover(null)}
      aria-label={`${part.name}: stock over the last 30 days, ${part.count} on the board today, and what reup expects over the next ${part.projection.length} days. The reorder point is ${part.reorderPoint}.`}>
      <line className="base" x1={BOX.x0} y1={BOX.y0} x2={BOX.x1} y2={BOX.y0} />
      <polyline className="stock" points={stepped(seen.map((c, i) => [sc.x(i), sc.y(c.stock)]))} />
      <polyline className="ahead" points={ahead.map((c, i) => `${sc.x(now + i)},${sc.y(c.stock)}`).join(' ')} />
      <line className="today" x1={sc.x(now)} y1={34} x2={sc.x(now)} y2={BOX.y0} />
      {part.reorderPoint > 0 ? (
        <g className="rop" style={{ transform: `translateY(${sc.y(part.reorderPoint)}px)` }}>
          <line x1={BOX.x0} y1={0} x2={BOX.x1} y2={0} stroke="inherit" strokeWidth="inherit" />
          <text x={BOX.x0} y={22} style={{ stroke: 'none' }}>{`Reorder at ${part.reorderPoint}`}</text>
        </g>
      ) : null}
      {ahead.map((c, i) => (c.ordered > 0 ? <rect key={`o-${c.day}`} className="order" x={sc.x(now + i) - 6} y={sc.y(c.stock) - 6} width={12} height={12} /> : null))}
      {ahead.map((c, i) => (c.when === 'ahead' && c.arrives > 0 ? (
        <g key={`a-${c.day}`}>
          <rect className="mark" x={sc.x(now + i) - 6} y={sc.y(c.stock) - 6} width={12} height={12} />
          <text x={sc.x(now + i)} y={sc.y(c.stock) - 14} textAnchor="middle">{`+${c.arrives}`}</text>
        </g>
      ) : null))}
      <rect className="mark" x={sc.x(now) - 6} y={sc.y(part.count) - 6} width={12} height={12} />
      <text x={sc.x(now) - 10} y={22} textAnchor="end">Today</text>
      <text x={sc.x(now) + 10} y={22}>{`Next ${part.projection.length} days`}</text>
      <text x={BOX.x0} y={BOX.h - 12}>{shortDay(cols[0]?.day ?? today)}</text>
      <text x={BOX.x1} y={BOX.h - 12} textAnchor="end">{shortDay(cols.at(-1)?.day ?? today)}</text>
      {tip && hover != null ? (
        <g className="tip" pointerEvents="none">
          <line className="cross" x1={sc.x(hover)} y1={34} x2={sc.x(hover)} y2={BOX.y0} />
          <rect x={tipX} y={BOX.top} width={tipW} height={tipLines.length * 22 + 18} />
          {tipLines.map((line, i) => <text key={line} x={tipX + 14} y={BOX.top + 26 + i * 22}>{line}</text>)}
        </g>
      ) : null}
    </svg>
  );
}

function PartCard({ part, today }: { part: AnalyticsPart; today: string }) {
  const st = standing(part, today);
  const facts = part.ratePerDay > 0
    ? `Reorder at ${part.reorderPoint} · uses ${part.ratePerDay.toFixed(2)} a day · ${Math.round(part.daysOfCover ?? 0)} days of cover${part.unitPrice != null ? ` · ${money(part.unitPrice)} each` : ''}`
    : 'Counting · not in use yet';
  return (
    <article className="stack card" aria-label={part.name}>
      <div className="row">
        <span className="figure">{part.count}</span>
        <div className="stack" style={{ gap: 8, paddingBottom: 4, minWidth: 0 }}>
          <span className="name">{part.name}</span>
          <Units count={part.count} capacity={part.capacity} />
          <span className="meta">{facts}</span>
        </div>
      </div>
      <Frame label={`${part.name}: stock behind and ahead`} className="plot" tag={st === 'low' ? <Tag tone="alert">At the reorder point</Tag> : st === 'coming' ? <Tag tone="cream">More on the way</Tag> : undefined}>
        <StockChart part={part} today={today} />
      </Frame>
      <p className="copy small">{partLine(part, today)}</p>
    </article>
  );
}

/** One column a slot, all the same colour, the one that is now at full strength. */
function Columns({ items, label, empty }: { items: { key: string; value: number; now: boolean; title: string; tick?: string }[]; label: string; empty: string }) {
  const W = 900;
  const H = 300;
  const y0 = 252;
  const max = Math.max(1, ...items.map((i) => i.value));
  const step = (W - 32) / Math.max(1, items.length);
  const barW = Math.max(6, Math.min(54, Math.round(step * 0.62)));
  const x = (i: number) => 16 + step * (i + 0.5);
  const y = (v: number) => y0 - (v / max) * (y0 - 44);
  const most = items.reduce((best, item, i) => (item.value > (items[best]?.value ?? 0) ? i : best), 0);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <line className="base" x1={16} y1={y0} x2={W - 16} y2={y0} />
      {items.map((item, i) => (
        <g key={item.key}>
          <rect className={item.now ? 'bar now' : 'bar'} x={x(i) - barW / 2} y={item.value > 0 ? y(item.value) : y0 - 2} width={barW} height={item.value > 0 ? y0 - y(item.value) : 2}><title>{item.title}</title></rect>
          {item.value > 0 && (item.now || i === most) ? <text x={x(i)} y={y(item.value) - 10} textAnchor="middle">{item.value}</text> : null}
          {item.tick ? <text x={x(i)} y={H - 14} textAnchor={i === 0 ? 'start' : i === items.length - 1 ? 'end' : 'middle'}>{item.tick}</text> : null}
        </g>
      ))}
      {items.every((i) => i.value === 0) ? <text x={W / 2} y={150} textAnchor="middle">{empty}</text> : null}
    </svg>
  );
}

export function Analytics() {
  const live = useLive();
  return <AnalyticsView live={live} a={useAnalytics(live)} />;
}

/** The page itself, from one answer of the hub. a is null until the first answer is in. */
export function AnalyticsView({ live, a }: { live: LiveState; a: AnalyticsResult | null }) {
  const alert = alertText(live);

  if (!a) {
    return (
      <main className="plate paper analytics" aria-label="Analytics">
        <Word text="Analytics" at="top" quiet />
        <p className="copy">{alert ?? 'Reading the board.'}</p>
      </main>
    );
  }

  const t = totals(a);
  const days = useByDay(a);
  const hours = byHour(a);
  const rows = feed(a, 12);
  const ranked = movers(a);

  return (
    <main className="plate paper analytics" aria-label="Analytics">
      <Word text="Analytics" at="top" quiet={!live.connected && !live.mock} />

      <header className="stack" style={{ gap: 18 }}>
        <p className="copy" style={{ maxWidth: '30em' }}>Every part on the board: what it held, what was used, and what reup expects to order next.</p>
        <div className="wrap">
          <Tag tone={alert ? 'alert' : 'blue'}>{alert ?? `Counted by the cameras · ${timeOf(a.now)}`}</Tag>
          {t.sample ? <Tag>Before today: sample history</Tag> : null}
        </div>
      </header>

      {a.parts.length === 0 ? <p className="copy">No parts yet. Put one on the teach spot.</p> : null}

      <section className="tiles" aria-label="Now">
        <Tile figure={String(t.units)} label="On the board" note={t.holds != null ? `Of ${t.holds} when every ledge is full, across ${t.parts} ${t.parts === 1 ? 'part' : 'parts'}.` : `Across ${t.parts} ${t.parts === 1 ? 'part' : 'parts'}.`} />
        <Tile figure={String(t.usedToday)} label="Used today" note={`${t.used7} in the last 7 days. ${weekChange(t.used7, t.usedBefore7)}.`} />
        <Tile figure={String(t.low.length)} label="At the reorder point" note={t.low.length === 0 ? 'Nothing is low.' : `${t.low.map((l) => `${l.part.name}${l.coming ? ', more on the way' : ''}`).join('. ')}.`} />
        <Tile figure={t.firstOut ? `${t.firstOut.days} days` : 'None'} label="Least cover" note={t.firstOut ? `${t.firstOut.part.name}. Empty ${dayLabel(t.firstOut.day)} if nothing more came in.` : 'No part is in use yet.'} />
        <Tile figure={String(t.ahead.orders)} label={`Orders in the next ${t.ahead.days} days`} note={t.ahead.orders === 0 ? 'None expected.' : `${t.ahead.units} units${t.ahead.cost != null ? `, about ${money(t.ahead.cost)} before tax` : ''}.`} />
        <Tile figure={money(t.placed.total)} label="Ordered so far" note={`${t.placed.orders} ${t.placed.orders === 1 ? 'order' : 'orders'} placed at Offcut Supply.`} />
      </section>

      <Items live={live} />

      <section className="stack" style={{ gap: 30 }} aria-label="Each part">
        <div className="stack" style={{ gap: 8 }}>
          <h2 className="name">Each part, 30 days behind and {a.parts[0]?.projection.length ?? 60} days ahead</h2>
          <p className="copy small" style={{ maxWidth: '44em' }}>The solid line is what the board held. The dotted line is what reup expects. An orange square is a day reup orders, and a light square is the delivery landing. Point at a day to read it.</p>
        </div>
        <div className="cards">{a.parts.map((part) => <PartCard key={part.productId} part={part} today={a.today} />)}</div>
      </section>

      <section className="pair" aria-label="Use over time">
        <div className="stack" style={{ gap: 18 }}>
          <div className="stack" style={{ gap: 8 }}><h2 className="name">Used each day, every part</h2><span className="meta">{`${t.used30} units in 30 days · today is the bright bar`}</span></div>
          <Frame label="Units used each day over the last 30 days" className="plot short">
            <Columns label={`Units used on each of the last 30 days. ${t.used30} in all, ${t.usedToday} today.`} empty="Nothing was used in these 30 days."
              items={days.map((d, i) => ({ key: d.day, value: d.used, now: d.today, title: `${dayLabel(d.day)}: ${d.used} used${d.sample ? ', sample' : ''}`, tick: i === 0 || d.today ? shortDay(d.day) : undefined }))} />
          </Frame>
        </div>
        <div className="stack" style={{ gap: 18 }}>
          <div className="stack" style={{ gap: 8 }}><h2 className="name">What moves most</h2><span className="meta">Units used in the last 30 days</span></div>
          <div className="stack bars" role="list">
            {ranked.map((r) => (
              <div className="stack" style={{ gap: 6 }} role="listitem" key={r.part.productId}>
                <div className="line" style={{ padding: 0, justifyContent: 'space-between' }}><span className="copy small">{r.part.name}</span><span className="meta">{`${r.used} used · ${r.part.ratePerDay.toFixed(2)} a day`}</span></div>
                <div className="track"><i style={{ width: `${Math.max(r.used > 0 ? 2 : 0, Math.round(r.share * 100))}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pair" aria-label="Today">
        <div className="stack" style={{ gap: 18 }}>
          <div className="stack" style={{ gap: 8 }}><h2 className="name">Today, by the hour</h2><span className="meta">Units taken off the board, as the cameras counted them</span></div>
          <Frame label="Units taken off the board in each hour of today" className="plot short">
            <Columns label={`Units taken off the board in each hour of today. ${hours.reduce((n, h) => n + h.taken, 0)} in all.`} empty="Nothing has moved today."
              items={hours.map((h, i) => ({ key: String(h.hour), value: h.taken, now: i === hours.length - 1, title: `${hourLabel(h.hour)}: ${h.taken} taken, ${h.back} back`, tick: i === 0 || i === hours.length - 1 || hours.length <= 8 ? hourLabel(h.hour) : undefined }))} />
          </Frame>
        </div>
        <div className="stack" style={{ gap: 18 }}>
          <div className="stack" style={{ gap: 8 }}><h2 className="name">Last moves</h2><span className="meta">{`${a.trail.length} in the last 24 hours`}</span></div>
          {rows.length === 0 ? <p className="copy small">Nothing has moved yet. Take a part off the board.</p> : (
            <table>
              <tbody>
                {rows.map((r) => <tr key={`${r.ts}-${r.name}-${r.what}`}><td className="meta">{r.time}</td><td className="copy small">{r.name}</td><td className="copy small">{r.what}</td><td className="meta">{r.left}</td></tr>)}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="pair" aria-label="Orders and every number">
        <div className="stack" style={{ gap: 18 }}>
          <h2 className="name">Orders reup placed</h2>
          {a.placed.length === 0 ? <p className="copy small">None yet. An order is placed when someone says yes.</p> : (
            <table>
              <thead><tr><th className="meta">When</th><th className="meta">Part</th><th className="meta">Units</th><th className="meta">Total</th><th className="meta">Confirmation</th></tr></thead>
              <tbody>
                {a.placed.map((o) => <tr key={`${o.poNumber}-${o.ts}`}><td className="meta">{`${daysBetween(a.today, o.ts.slice(0, 10)) === 0 ? 'Today' : shortDay(o.ts.slice(0, 10))} ${timeOf(o.ts)}`}</td><td className="copy small">{o.name}</td><td className="copy small">{o.units}</td><td className="copy small">{o.total != null ? money(o.total) : ''}</td><td className="meta">{`${o.confirmation} · PO ${o.poNumber}`}</td></tr>)}
              </tbody>
            </table>
          )}
        </div>
        <div className="stack" style={{ gap: 18 }}>
          <h2 className="name">Every number</h2>
          <table>
            <thead><tr><th className="meta">Part</th><th className="meta">Now</th><th className="meta">Holds</th><th className="meta">A day</th><th className="meta">Reorder at</th><th className="meta">Next order</th><th className="meta">Empty without it</th></tr></thead>
            <tbody>
              {a.parts.map((p) => (
                <tr key={p.productId}>
                  <td className="copy small">{p.name}</td><td className="copy small">{p.count}</td><td className="copy small">{p.capacity ?? ''}</td><td className="copy small">{p.ratePerDay.toFixed(2)}</td><td className="copy small">{p.reorderPoint}</td>
                  <td className="copy small">{nextOrder(p, a.today)}</td>
                  <td className="copy small">{p.runsOutOn ? dayLabel(p.runsOutOn) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="meta">{`${t.units} units counted · updated ${timeOf(a.now)}`}</span>
        </div>
      </section>

      <footer className="wrap" style={{ justifyContent: 'space-between' }}>
        <Wordmark />
        <span className="meta"><a href="/">The board</a> · <a href="/ops">Operator</a></span>
      </footer>
    </main>
  );
}
