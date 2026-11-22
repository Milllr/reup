import { AnalyticsResult, type AnalyticsPart } from '@reup/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import analytics from '../../../contracts/mocks/analytics.json';
import { byHour, columns, coming, dateTicks, dayLabel, daysBetween, describe as say, feed, hourLabel, inDays, movers, nextOrder, partLine, scale, standing, stepped, totals, useByDay, weekChange } from '../src/lib/analytics';
import { AnalyticsView, StockChart, useAnalytics } from '../src/screens/analytics';
import { mockSnapshot } from '../src/store/mock';
import { initial, type LiveState } from '../src/store/reduce';

// The sample is the station as built, after a morning at the table: bolts taken and put back, wax too, a 9V battery
// out and back, two washers gone and an order for them placed, and one bolt taken last.
const A = AnalyticsResult.parse(analytics);
const part = (id: string) => A.parts.find((p) => p.productId === id) as AnalyticsPart;
const live = (patch: Partial<LiveState> = {}): LiveState => ({ ...initial, snapshot: mockSnapshot('shelf'), connected: true, mock: true, ...patch });

describe('the numbers on the Analytics page', () => {
  it('adds the board up', () => {
    const t = totals(A);
    expect(t).toMatchObject({ parts: 4, units: 10, holds: 13, usedToday: 4, used7: 8, usedBefore7: 2, used30: 16, sample: true });
    expect(t.low.map((l) => [l.part.productId, l.coming])).toEqual([['p-washers', true]]);
    expect(t.firstOut).toMatchObject({ day: '2026-12-11', days: 20 });
    expect(t.firstOut?.part.productId).toBe('p-washers');
    expect(t.ahead).toEqual({ orders: 9, units: 18, cost: 181.02, days: 60 });
    expect(t.placed).toEqual({ orders: 1, total: 17.68 });
  });

  it('a part with no price leaves the cost of the orders ahead unknown, and a board with one open ledge has no full size', () => {
    const t = totals({ ...A, parts: A.parts.map((p, i) => (i === 0 ? { ...p, unitPrice: null, capacity: null } : p)) });
    expect(t.ahead.cost).toBeNull();
    expect(t.holds).toBeNull();
  });

  it('says days and changes in plain words', () => {
    expect(daysBetween('2026-11-21', '2026-12-11')).toBe(20);
    expect(dayLabel('2026-11-24')).toBe('Tue Nov 24');
    expect([inDays(0), inDays(1), inDays(12)]).toEqual(['today', 'tomorrow', 'in 12 days']);
    expect([weekChange(8, 2), weekChange(2, 8), weekChange(3, 3)]).toEqual(['6 more than the week before', '6 fewer than the week before', 'The same as the week before']);
    expect([hourLabel(0), hourLabel(9), hourLabel(12), hourLabel(18)]).toEqual(['12 AM', '9 AM', '12 PM', '6 PM']);
  });

  it('knows where each part stands and what happens next', () => {
    expect(standing(part('p-washers'), A.today)).toBe('coming');
    expect(coming(part('p-washers'), A.today)).toEqual({ day: '2026-11-24', units: 2 });
    expect(partLine(part('p-washers'), A.today)).toBe('2 units on the way, here Tue Nov 24.');
    expect(nextOrder(part('p-washers'), A.today)).toBe('On its way, here Tue Nov 24');
    expect(standing(part('p-bolts'), A.today)).toBe('fine');
    expect(coming(part('p-bolts'), A.today)).toBeNull();
    expect(partLine(part('p-bolts'), A.today)).toBe('Next order in 20 days, Fri Dec 11. Without it the ledge is empty Thu Dec 31.');
    expect(nextOrder(part('p-bolts'), A.today)).toBe('Fri Dec 11, in 20 days');
    // At the line with nothing ordered is low. Not in use is never low.
    const bare = { ...part('p-bolts'), count: 1, reorderOn: '2026-11-22' };
    expect(standing(bare, A.today)).toBe('low');
    const idle = { ...part('p-bolts'), ratePerDay: 0, reorderOn: null, runsOutOn: null };
    expect(standing(idle, A.today)).toBe('fine');
    expect(partLine(idle, A.today)).toBe('Counted. Not in use yet, so nothing is ordered.');
    expect(nextOrder(idle, A.today)).toBe('Not in use');
  });

  it('lays a part out as 30 days behind, today, and 60 ahead', () => {
    const p = part('p-wax');
    const cols = columns(p, A.today);
    expect(cols).toHaveLength(91);
    expect(cols.map((c) => c.when).filter((w, i, all) => all.indexOf(w) === i)).toEqual(['behind', 'today', 'ahead']);
    expect(cols[30]).toMatchObject({ day: A.today, when: 'today', stock: 4, sample: false });
    expect(cols[0]?.sample).toBe(true);
    const sc = scale(p, cols);
    expect(sc.max).toBe(4);
    expect(sc.x(0)).toBe(16);
    expect(sc.x(90)).toBe(884);
    expect(sc.y(0)).toBe(326);
    expect(sc.y(4)).toBe(66);
    expect([sc.at(0), sc.at(16), sc.at(450), sc.at(2000)]).toEqual([0, 0, 45, 90]);
    expect(say(cols[30] as never, p)).toEqual(['Today, Nov 21', '4 on the board']);
    const order = cols.find((c) => c.ordered > 0);
    expect(say(order as never, p).at(-1)).toMatch(/^reup orders 2/);
    expect(say(cols[4] as never, p)).toEqual(['Mon Oct 26', '3 on the board', '1 pack used']);
  });

  it('draws a stepped line with a corner at every change and none in between', () => {
    expect(stepped([[0, 10], [5, 10], [10, 10], [15, 20], [20, 20]])).toBe('0,10 15,10 15,20 20,20');
    expect(stepped([[0, 10]])).toBe('0,10');
  });

  it('reads today from the trail: by the hour, the last moves, and what moves most', () => {
    expect(byHour(A)).toEqual([{ hour: 9, taken: 2, back: 2 }, { hour: 10, taken: 3, back: 2 }, { hour: 11, taken: 3, back: 1 }]);
    expect(byHour({ ...A, trail: [] })).toEqual([]);
    const rows = feed(A, 3);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ time: '11:49 AM', name: 'Hex bolts 3/4 x 3 in', what: '1 taken', left: '2 on the board' });
    expect(rows[1]).toMatchObject({ name: '9V batteries', what: '1 back' });
    expect(movers(A).map((m) => [m.part.productId, m.used])).toEqual([['p-wax', 6], ['p-washers', 4], ['p-9v', 3], ['p-bolts', 3]]);
    expect(movers(A)[0]?.share).toBe(1);
    const days = useByDay(A);
    expect(days).toHaveLength(30);
    expect(days.at(-1)).toEqual({ day: A.today, used: 4, today: true, sample: false });
    expect(days.reduce((n, d) => n + d.used, 0)).toBe(totals(A).used30);
  });
});

describe('the Analytics page', () => {
  it('shows the tiles, a chart for every part, today, the orders and every number', () => {
    const { container } = render(<AnalyticsView live={live()} a={A} />);
    expect(container.querySelector('.word')?.textContent).toBe('Analytics');
    const now = within(screen.getByLabelText('Now'));
    expect(now.getByText('On the board').previousSibling?.textContent).toBe('10');
    expect(now.getByText('Of 13 when every ledge is full, across 4 parts.')).toBeTruthy();
    expect(now.getByText('8 in the last 7 days. 6 more than the week before.')).toBeTruthy();
    expect(now.getByText('Flat washers 3/4 in, more on the way.')).toBeTruthy();
    expect(now.getByText('Flat washers 3/4 in. Empty Fri Dec 11 if nothing more came in.')).toBeTruthy();
    expect(now.getByText('18 units, about $181.02 before tax.')).toBeTruthy();
    expect(now.getByText('$17.68')).toBeTruthy();
    // No tags over the figures unless something is wrong: nothing about who counted, nothing about sample days.
    expect(screen.queryByText(/sample/i)).toBeNull();
    expect(screen.queryByText(/Counted by the cameras/)).toBeNull();

    const parts = within(screen.getByLabelText('Each part'));
    for (const p of A.parts) expect(parts.getByLabelText(p.name)).toBeTruthy();
    expect(container.querySelectorAll('.card svg.chart')).toHaveLength(4);
    expect(parts.getByText('More on the way')).toBeTruthy();
    expect(parts.getByText('2 units on the way, here Tue Nov 24.')).toBeTruthy();
    expect(parts.getByText('Uses 0.18 a day · 22 days of cover · $14.99 each')).toBeTruthy();
    // A date under the axis every two weeks, counted from today.
    const waxTicks = dateTicks(columns(part('p-wax'), A.today).map((c) => c.day), 30, 14);
    expect(waxTicks.map((x) => x.index - 30)).toEqual([-28, -14, 0, 14, 28, 42, 56]);
    expect(within(parts.getByLabelText('MWAX synthetic lubricant')).getAllByText(/^[A-Z][a-z]{2} \d{1,2}$/).map((n) => n.textContent)).toEqual(waxTicks.map((x) => x.label));
    // Every order day and every delivery ahead is marked on its chart.
    const wax = parts.getByLabelText('MWAX synthetic lubricant');
    expect(wax.querySelectorAll('rect.order')).toHaveLength(part('p-wax').projection.filter((d) => d.ordered > 0).length);

    expect(within(screen.getByLabelText('Today')).getByText('11:49 AM')).toBeTruthy();
    const tables = within(screen.getByLabelText('Orders and every number'));
    expect(tables.getByText('OC-61675 · PO RU-1044')).toBeTruthy();
    expect(tables.getByText('Fri Dec 11, in 20 days')).toBeTruthy();
    expect(tables.getByText('On its way, here Tue Nov 24')).toBeTruthy();
  });

  it('says what a day held when the pointer is on it', () => {
    const { container } = render(<svg><StockChart part={part('p-wax')} today={A.today} /></svg>);
    const chart = container.querySelector('svg.chart') as SVGSVGElement;
    chart.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 380, right: 900, bottom: 380, x: 0, y: 0, toJSON: () => ({}) });
    expect(container.querySelector('.tip')).toBeNull();
    fireEvent.mouseMove(chart, { clientX: 16 + (868 / 90) * 30, clientY: 100 });
    expect(container.querySelector('.tip')?.textContent).toBe('Today, Nov 214 on the board');
    fireEvent.mouseLeave(chart);
    expect(container.querySelector('.tip')).toBeNull();
  });

  it('waits for the first answer, and says so when there are no parts', () => {
    const { unmount } = render(<AnalyticsView live={live()} a={null} />);
    expect(screen.getByText('Reading the board.')).toBeTruthy();
    unmount();
    render(<AnalyticsView live={live()} a={{ ...A, parts: [], trail: [], placed: [] }} />);
    expect(screen.getByText('No parts yet. Put one on the teach spot.')).toBeTruthy();
    expect(screen.getByText('None yet. An order is placed when someone says yes.')).toBeTruthy();
    expect(screen.getByText('Nothing has moved yet. Take a part off the board.')).toBeTruthy();
  });

  it('asks the hub again when a count changes, and keeps the last good answer when the hub says no', async () => {
    const send = vi.fn(async () => ({ ok: true, status: 200, data: A, message: null }));
    function Probe({ state }: { state: LiveState }) {
      const a = useAnalytics(state, send as never);
      return <span>{a ? `${a.parts.length} parts` : 'none'}</span>;
    }
    const first = live({ mock: false });
    const { rerender } = render(<Probe state={first} />);
    await waitFor(() => expect(screen.getByText('4 parts')).toBeTruthy());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('GET', '/api/analytics');
    // The same snapshot again asks nothing. A count that moved asks once more.
    rerender(<Probe state={{ ...first }} />);
    expect(send).toHaveBeenCalledTimes(1);
    const snap = first.snapshot as NonNullable<LiveState['snapshot']>;
    send.mockImplementationOnce((async () => ({ ok: false, status: 502, data: null, message: 'no' })) as never);
    await act(async () => {
      rerender(<Probe state={{ ...first, snapshot: { ...snap, counts: snap.counts.map((c, i) => (i === 0 ? { ...c, count: c.count - 1 } : c)) } }} />);
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(screen.getByText('4 parts')).toBeTruthy();
  });
});
