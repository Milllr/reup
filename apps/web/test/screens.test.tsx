import type { AskResult, HistoryResult, Order, Snapshot, TeachState } from '@reup/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import history from '../../../contracts/mocks/history.json';
import { yesKey, type Reply } from '../src/lib/hub';
import { Menu, pageHref } from '../src/screens/menu';
import { APPROVE, ApproveHere, howToSayYes, Order as OrderScreen } from '../src/screens/order';
import { Controls, ZoneEditor } from '../src/screens/ops';
import { ApproveBand, NO_KEY, TeachForm } from '../src/screens/phone';
import { FEED_RETRY_MS, feedUrl, NO_FEED, NO_PARTS, Shelf, shelfCredit, WATCHING, wrongBox } from '../src/screens/shelf';
import { EYE_AWAY, LEDGES_HINT, LEDGES_SAVE, LOOKING, nameTeachSpot } from '../src/screens/shelf/ledges';
import { panes, Shop, shopSentence } from '../src/screens/shop';
import { frameFor, Teach } from '../src/screens/teach';
import { centre, FRESH, inside, placeFor, START, WHERE } from '../src/screens/teach/boxes';
import { Tv } from '../src/screens/tv';
import { ASK_FALLBACK, ASK_WAIT, AskReup, Chart, scales, SEASONS, sourceLine, Why } from '../src/screens/why';
import { forgetHistory, HISTORY_RETRY, HISTORY_WAIT, prefetchHistory, useHistory } from '../src/screens/why/history';
import askMock from '../../../contracts/mocks/ask-result.json';
import { store } from '../src/store/live';
import { mockSnapshot } from '../src/store/mock';
import { initial, type LiveState } from '../src/store/reduce';

const live = (at: string | null, patch: Partial<LiveState> = {}): LiveState => ({ ...initial, snapshot: mockSnapshot(at), connected: true, mock: true, ...patch });
const plate = (c: HTMLElement) => c.querySelector('.plate')?.className ?? '';
const word = (c: HTMLElement) => c.querySelector('.word')?.textContent;
const ok = <T,>(data: T): Reply<T> => ({ ok: true, status: 200, data, message: null });

describe('Shelf', () => {
  it('renders the board, a tagged zone per part, the index and the word', () => {
    const { container } = render(<Shelf live={live('shelf')} />);
    expect(plate(container)).toContain('olive');
    expect(word(container)).toBe('Stocked');
    // The name, a wide gap, the count: no dot between them.
    // The test library folds the gap to one space when it looks a tag up. On the page it is two spaces that do not fold.
    expect(screen.getByText('Wood screws 6 of 12').textContent).toBe('Wood screws\u00a0\u00a06 of 12');
    expect(screen.getByText('Wood glue 3 of 4')).toBeTruthy();
    expect(container.textContent).not.toContain('Wood screws ·');
    expect(container.querySelectorAll('.feed .zone')).toHaveLength(4);
    expect(container.querySelectorAll('.pocket.full')).toHaveLength(6 + 5);
    expect(screen.getByText('11 days of cover')).toBeTruthy();
    expect(screen.queryByText(/Reorder at \d+ ·/)).toBeNull();
    expect(screen.getByText(WATCHING)).toBeTruthy();
    expect(screen.getByText('Counted by the shelf node on QNX')).toBeTruthy();
  });

  it('cuts to the wine plate and Reorder at the reorder point', () => {
    const { container } = render(<Shelf live={live('low')} />);
    expect(plate(container)).toContain('wine');
    expect(word(container)).toBe('Reorder');
    expect(screen.getByText('Wood screws 4 of 12').className).toContain('alert');
    expect(container.querySelector('.zone.low')).not.toBeNull();
    expect(container.querySelector('.figure.low')?.textContent).toBe('4');
  });

  it('is olive with On the way once the order is placed', () => {
    const { container } = render(<Shelf live={live('ontheway')} />);
    expect(plate(container)).toContain('olive');
    expect(word(container)).toBe('On the way');
    expect(screen.getByText('8 boxes on the way · arrives Tuesday')).toBeTruthy();
  });

  it('shows the stream, and falls back to the drawn board with an alert when the image errors', () => {
    const { container } = render(<Shelf live={live('shelf', { mock: false })} />);
    const img = container.querySelector('.feed img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('http://192.168.1.20:8089/stream/board.mjpg');
    expect(container.querySelector('.pockets')).toBeNull();
    fireEvent.error(img);
    expect(container.querySelector('.feed img')).toBeNull();
    expect(container.querySelectorAll('.pockets')).toHaveLength(2);
    expect(screen.getByText(NO_FEED).className).toContain('alert');
  });

  it('opens the picture again by itself: when it would not load and the eye still answers, and when the eye was gone and is back', async () => {
    vi.useFakeTimers();
    let up = true;
    const eyeFetch = vi.fn(async () => {
      if (!up) throw new Error('refused');
      return new Response(JSON.stringify({ items: [] }));
    });
    const { container } = render(<Shelf live={live('shelf', { mock: false })} eyeFetch={eyeFetch as never} />);
    const src = () => container.querySelector('.feed img')?.getAttribute('src') ?? null;
    const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    await pass(100);
    expect(eyeFetch).toHaveBeenCalledWith('http://192.168.1.20:8089/outlines/board.json');
    expect(src()).toBe('http://192.168.1.20:8089/stream/board.mjpg');
    // The picture fails to load. The drawn board stands in, and the eye is still asked.
    fireEvent.error(container.querySelector('.feed img') as HTMLImageElement);
    expect(src()).toBeNull();
    expect(screen.getByText(NO_FEED)).toBeTruthy();
    await pass(FEED_RETRY_MS - 800);
    expect(src()).toBeNull();
    // The eye has answered for three seconds since: the picture is opened again, on a new address.
    await pass(2100);
    expect(src()).toBe('http://192.168.1.20:8089/stream/board.mjpg?turn=1');
    expect(screen.queryByText(NO_FEED)).toBeNull();
    // The eye stops and is started again. Its old stream said nothing when it ended: the picture is opened again all the same.
    up = false;
    await pass(1500);
    expect(src()).toBe('http://192.168.1.20:8089/stream/board.mjpg?turn=1');
    up = true;
    await pass(800);
    expect(src()).toBe('http://192.168.1.20:8089/stream/board.mjpg?turn=2');
    // While it answers and the picture is well, nothing is opened again.
    await pass(10_000);
    expect(src()).toBe('http://192.168.1.20:8089/stream/board.mjpg?turn=2');
    expect(feedUrl('http://x/stream/board.mjpg?a=1', 3)).toBe('http://x/stream/board.mjpg?a=1&turn=3');
    vi.useRealTimers();
  });

  it('says so when there are no parts, and when the hub is unreachable', () => {
    const empty = render(<Shelf live={live('empty')} />);
    expect(word(empty.container)).toBe('Empty');
    expect(screen.getByText(NO_PARTS)).toBeTruthy();
    empty.unmount();
    const off = render(<Shelf live={live('shelf', { mock: false, connected: false, syncedAt: '2026-11-21T09:14:00-05:00' })} />);
    expect(screen.getByText('Hub unreachable. Showing the last counts from 9:14.')).toBeTruthy();
    expect(off.container.querySelector('.word')?.className).toContain('quiet');
  });

  it('turns a zone lime while a hand is over it', () => {
    const { container } = render(<Shelf live={live('shelf', { reaching: { 'z-glue': true } })} />);
    expect(container.querySelectorAll('.zone.reach')).toHaveLength(1);
  });

  it('the tag says what the shelf node on QNX is doing, there is none without it, and the mono line is the time alone', () => {
    const node = render(<Shelf live={live('shelf')} />);
    expect(screen.getByText('Counted by the shelf node on QNX')).toBeTruthy();
    expect(node.container.querySelector('.meta.abs')?.textContent).toBe('Sat 9:14 AM');
    node.unmount();
    // The node is up and sees hands, but the eye does the counting: it is not credited with the count.
    const l = live('shelf');
    (l.snapshot as Snapshot).node.level = 1;
    const hands = render(<Shelf live={l} />);
    expect(screen.getByText('Hands seen by the shelf node on QNX')).toBeTruthy();
    expect(hands.container.textContent).not.toContain('Counted by');
    hands.unmount();
    // No node: the eye counting is the plain case and gets no tag.
    const away = live('shelf');
    (away.snapshot as Snapshot).node = { ...(away.snapshot as Snapshot).node, online: false, level: 1 };
    const eye = render(<Shelf live={away} />);
    expect(eye.container.querySelector('.tag.center:not(.alert)')).toBeNull();
    expect(eye.container.textContent).not.toContain('Counted by');
    expect(eye.container.textContent).not.toContain('camera live');
  });
});

describe('Shop', () => {
  const s = mockSnapshot('shop');
  const order = s.orders[0] as Order;
  const product = s.products[0];

  it('draws one frame per run of the order, each tagged with whose page it is', () => {
    const { container } = render(<Shop live={live('shop')} />);
    expect(plate(container)).toContain('wine');
    expect(word(container)).toBe('Shopping');
    expect(container.querySelectorAll('.frame')).toHaveLength(3);
    expect(screen.getByText('Price check · Retailer A')).toBeTruthy();
    expect(screen.getByText('Blocked · Retailer B').className).toContain('alert');
    // The supplier's own frame carries no tag: the price checks are the ones that need naming.
    expect(container.querySelectorAll('.frame > .tag')).toHaveLength(2);
    expect(container.textContent).not.toContain('Your supplier');
    expect(screen.getByLabelText('The cart at Offcut Supply')).toBeTruthy();
    expect(screen.getByText('Shopped by TinyFish on the live web')).toBeTruthy();
    expect(screen.getByText('Ordering 8 boxes')).toBeTruthy();
  });

  it('words each result: a price, no price, a step, a total', () => {
    const list = panes(s, order, product);
    expect(list.map((p) => [p.state, p.figure, p.meta])).toEqual([
      ['done', '$8.69', 'A box · in stock · 3 days'],
      ['failed', 'No price', 'The site showed a challenge page.'],
      ['live', 'Step 3', 'Setting quantity to 8'],
    ]);
    expect(shopSentence(s, list, order)).toBe('Filling a cart at Offcut Supply. 2 of 2 price checks came back.');
    const done = panes(s, { ...order, total: 67.71 }, product)[2];
    expect([done?.state, done?.figure, done?.meta]).toEqual(['done', '$67.71', '8 boxes in the cart · with tax']);
  });

  it('shows loading before any step, a replay tag for a recording, and says when a local stand in shopped', () => {
    const bare: Snapshot = { ...s, runs: [], quotes: [] };
    expect(panes(bare, order, product).map((p) => [p.state, p.figure, p.meta])).toEqual(Array(3).fill(['loading', 'Starting', 'Opening a browser.']));
    const replayed: Snapshot = { ...s, runs: s.runs.map((r) => ({ ...r, replay: true, engine: 'local' as const })) };
    expect(panes(replayed, order, product).map((p) => p.tag)).toEqual(['Price check · Retailer A · replay', 'Blocked · Retailer B · replay', 'Replay']);
    expect(panes(s, order, product).map((p) => p.tag)).toEqual(['Price check · Retailer A', 'Blocked · Retailer B', null]);
    render(<Shop live={{ ...live('shop'), snapshot: replayed }} />);
    expect(screen.getByText('Shopped by a local stand in, not on the live web')).toBeTruthy();
  });

  it('puts the live browser in the frame when there is a picture, and says when the buyer is offline', () => {
    const l = live('shop', { mock: false });
    (l.snapshot as Snapshot).buyerOnline = false;
    const { container } = render(<Shop live={l} />);
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(s.runs.find((r) => r.kind === 'cart')?.streamingUrl);
    expect(screen.getByText('The buyer is offline.').className).toContain('alert');
  });
});

describe('Order', () => {
  const at = (name: string) => render(<OrderScreen live={live(name)} />);

  it('waits for a yes on paper with the part, the total, the day and the line that says how to say yes', () => {
    const { container } = at('order');
    expect(plate(container)).toContain('paper');
    expect(word(container)).toBe('8 boxes');
    expect(screen.getByText('$67.71')).toBeTruthy();
    expect(screen.getByText('Tuesday')).toBeTruthy();
    // The sample shelf node is connected, and the test page is on localhost so it holds the local key: the plate has one button, Approve.
    expect(screen.getByText('Press the wooden button to place the order.')).toBeTruthy();
    expect(APPROVE).toBe('Approve to place order');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([APPROVE]);
    // Nothing else is written: no small print, no reason, no price note, no tag with the PO and the spend cap.
    for (const gone of ['Nothing is bought', 'press Enter', 'fills the board', 'Retailer A is', 'Waiting for a yes', 'spend cap']) expect(container.textContent).not.toContain(gone);
    expect(container.querySelector('.tag')).toBeNull();
    expect(container.querySelector('.frame.waiting')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'A box of Wood screws #8 x 1-1/4 in' })).toBeTruthy();
  });

  it('with no shelf node the button stands alone, and a hub that takes a yes from any screen gives it to a screen with no key', () => {
    const l = live('order');
    (l.snapshot as Snapshot).node.online = false;
    const { container, unmount } = render(<OrderScreen live={l} />);
    expect(screen.getByRole('button', { name: APPROVE })).toBeTruthy();
    expect(container.querySelector('.figure.mid')?.textContent).toBe('Tuesday');
    expect(container.textContent).not.toContain('phone');
    unmount();
    // The same key rules as a page: asked with no key at all, the open hub still means yes.
    expect(yesKey({ open: true })).not.toBeNull();
    expect(yesKey(null)).toBe('dev-approve-key');
  });

  it('placing is wine with the live pane; placed is olive with the confirmation; failed and cancelled say nothing was bought', () => {
    let r = at('placing');
    expect([plate(r.container).includes('wine'), word(r.container)]).toEqual([true, 'Placing']);
    expect(screen.getByText('Placing the order at Offcut Supply.')).toBeTruthy();
    expect(r.container.querySelector('.tag')).toBeNull();
    expect(r.container.textContent).not.toContain('Your supplier');
    expect(screen.queryByRole('button', { name: 'Back to the board' })).toBeNull();
    r.unmount();
    r = at('placed');
    expect([plate(r.container).includes('olive'), word(r.container)]).toEqual([true, 'Ordered']);
    expect(screen.getByText('OC-58213')).toBeTruthy();
    expect(screen.getByText('Ordered. Arrives Tuesday.')).toBeTruthy();
    expect(screen.getByText('Confirmation · arrives Tuesday · $67.71')).toBeTruthy();
    expect(r.container.textContent).not.toContain('Bought by reup');
    expect(r.container.querySelector('.tag')).toBeNull();
    r.unmount();
    r = at('failed');
    expect([plate(r.container).includes('wine'), word(r.container)]).toEqual([true, 'Stopped']);
    expect(screen.getByText('Nothing was bought.')).toBeTruthy();
    expect(screen.getByText('Could not fill the cart: the item is out of stock. Nothing was bought.')).toBeTruthy();
    r.unmount();
    r = at('cancelled');
    expect([plate(r.container).includes('paper'), word(r.container)]).toEqual([true, 'Cancelled']);
    expect(screen.getByText('Nothing was bought.')).toBeTruthy();
  });
});

describe('Why', () => {
  const h = history as HistoryResult;

  it('maps the history into the chart box', () => {
    const sc = scales(h, 4, 12);
    expect(sc.x(0)).toBe(40);
    expect(sc.x(37)).toBe(940);
    expect(sc.today).toBe(30);
    expect(sc.y(0)).toBe(470);
    expect(sc.y(12)).toBe(62);
  });

  it('draws the reorder line where the policy puts it', () => {
    const { container, rerender } = render(<Chart history={h} count={4} capacity={12} reorderPoint={4} />);
    const line = () => (container.querySelector('.rop') as SVGGElement).style.transform;
    expect(line()).toBe('translateY(334px)');
    expect(screen.getByText('Reorder at 4')).toBeTruthy();
    rerender(<Chart history={h} count={4} capacity={12} reorderPoint={5} />);
    expect(line()).toBe('translateY(300px)');
    expect(container.querySelectorAll('.bar').length).toBeGreaterThan(5);
  });

  it('puts a date under the axis every week, counted from today, and nothing else under it', () => {
    const { container } = render(<Chart history={h} count={4} capacity={12} reorderPoint={4} />);
    const dates = [...container.querySelectorAll('text')].map((n) => n.textContent ?? '').filter((s) => /^[A-Z][a-z]{2} \d{1,2}$/.test(s));
    // 30 days behind, today, 7 ahead: a date four weeks back, each week since, today and a week on.
    expect(dates).toHaveLength(6);
    const day = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${iso}T12:00:00Z`));
    expect(dates.at(-1)).toBe(day(h.forecast.at(-1)?.day ?? ''));
    expect(dates[0]).toBe(day(h.days[2]?.day ?? ''));
    expect(container.querySelectorAll('.tick')).toHaveLength(6);
    expect(screen.queryByText('30 days ago')).toBeNull();
  });

  it('has the chart, the reason and the switch, and none of the lines Miller took off', () => {
    render(<Why live={live('why')} />);
    expect(screen.queryByText(/Bars are what was used/)).toBeNull();
    expect(screen.queryByText(/sample/i)).toBeNull();
    expect(screen.queryByText(/Ask about use/)).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Season' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Slow', 'Normal', 'Busy']);
    expect(SEASONS.map((x) => x.factor)).toEqual([0.6, 1, 1.4]);
  });
});

describe('the Forecast chart is there when the screen opens', () => {
  const h = history as HistoryResult;
  const s = mockSnapshot('why');
  const id = s.focusProductId ?? s.products[0]?.id ?? '';
  const state = (patch: Partial<LiveState> = {}): LiveState => ({ ...live('why'), mock: false, ...patch });
  function Probe({ send, again = 'a' }: { send: never; again?: string }) {
    const { history: got, failed } = useHistory(id, again, false, send);
    return <p>{got ? `days ${got.days.length}` : failed ? HISTORY_RETRY : HISTORY_WAIT}</p>;
  }

  it('says what it is reading, asks again when the hub does not answer, and then draws', async () => {
    forgetHistory();
    let n = 0;
    const send = vi.fn(async () => (++n < 2 ? { ok: false, status: 0, data: null, message: 'Hub unreachable.' } : ok({ ...h, productId: id })));
    vi.useFakeTimers();
    render(<Probe send={send as never} />);
    expect(screen.getByText(HISTORY_WAIT)).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(HISTORY_RETRY)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.getByText('days 30')).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('GET', `/api/products/${id}/history`);
    vi.useRealTimers();
  });

  it('what was read is kept: the next time it is on screen at once, and read again behind it', async () => {
    forgetHistory();
    const send = vi.fn(async () => ok({ ...h, productId: id }));
    prefetchHistory([id, id], send as never);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    // Already kept: reading ahead again asks for nothing.
    prefetchHistory([id], send as never);
    expect(send).toHaveBeenCalledTimes(2);
    render(<Probe send={send as never} />);
    expect(screen.getByText('days 30')).toBeTruthy();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    // Something the hub does not send as a history is not drawn.
    forgetHistory();
    cleanup();
    render(<Probe send={(async () => ok({ nope: true })) as never} />);
    expect(await screen.findByText(HISTORY_RETRY)).toBeTruthy();
    cleanup();
  });

  it('on the screen itself: the waiting line in the frame, and the switch works with the key this screen says yes with', async () => {
    forgetHistory();
    const fetched: [string, RequestInit | undefined][] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      fetched.push([String(url), init]);
      return new Response(JSON.stringify(String(url).includes('/history') ? { ...h, productId: id } : { ok: true }), { status: 200 });
    });
    render(<Why live={state()} />);
    expect(screen.getByText(HISTORY_WAIT)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(HISTORY_WAIT)).toBeNull());
    const busy = screen.getByRole('button', { name: 'Busy' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(false);
    fireEvent.click(busy);
    await waitFor(() => expect(fetched.some(([u]) => u.endsWith('/api/demo/season'))).toBe(true));
    const [, init] = fetched.find(([u]) => u.endsWith('/api/demo/season')) ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({ label: 'Busy', factor: 1.4 });
    spy.mockRestore();
    forgetHistory();
  });
});

describe('Ask reup', () => {
  const result = (patch: Partial<AskResult> = {}): AskResult => ({ answer: 'Wood screws, 14 boxes in the last 7 days.', source: 'gemini', facts: ['a', 'b'], ...patch });
  const askOnce = (q = 'What did we use most this week?') => {
    fireEvent.change(screen.getByPlaceholderText('What did we use most this week?'), { target: { value: q } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  };

  it('starts with the field alone, and Ask waits for a question', () => {
    const { container } = render(<AskReup ask={vi.fn()} />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows Asking while it waits, then the answer and where it came from', async () => {
    let answer: (r: Reply<AskResult>) => void = () => {};
    const ask = vi.fn(() => new Promise<Reply<AskResult>>((resolve) => (answer = resolve)));
    render(<AskReup ask={ask} />);
    askOnce('  What did we use most this week?  ');
    expect(ask).toHaveBeenCalledWith('What did we use most this week?');
    expect(screen.getByText(ASK_WAIT)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer(ok(result())));
    expect(screen.getByText('Wood screws, 14 boxes in the last 7 days.')).toBeTruthy();
    expect(screen.getByText('Gemini, from 2 facts on this board.')).toBeTruthy();
    expect(screen.queryByText(ASK_WAIT)).toBeNull();
  });

  it('says so when the answer is the hub reading its own numbers', async () => {
    render(<AskReup ask={async () => ok(result({ source: 'fallback' }))} />);
    askOnce();
    await waitFor(() => expect(screen.getByText(ASK_FALLBACK)).toBeTruthy());
    expect(sourceLine(result({ facts: [] }))).toBe('Gemini, from the board. The numbers here do not cover it.');
    expect(sourceLine(result({ facts: ['a'] }))).toBe('Gemini, from 1 fact on this board.');
  });

  it('shows the hub message when asking fails', async () => {
    render(<AskReup ask={async () => ({ ok: false, status: 0, data: null, message: 'Hub unreachable.' })} />);
    askOnce();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not ask. Hub unreachable.'));
  });

  it('sits on the Why screen and answers from the mock in mock mode', async () => {
    render(<Why live={live('why')} />);
    askOnce();
    await waitFor(() => expect(screen.getByText(String(askMock.answer))).toBeTruthy());
  });
});

describe('the TV', () => {
  it('follows snapshot.screen, shows the Teach plate while a teach is open, and Starting before the first snapshot', () => {
    act(() => store.set({ ...initial }));
    const { container } = render(<Tv />);
    expect(word(container)).toBe('Starting');
    act(() => store.set(live('order')));
    expect(word(container)).toBe('8 boxes');
    act(() => store.set(live('why')));
    expect(word(container)).toBe('Forecast');
    act(() => store.set(live('teach')));
    expect(word(container)).toBe('New part');
    expect(screen.getByText('Looks like wood screws #8 x 2 in.')).toBeTruthy();
    // The test page is on localhost, like the station's own laptop: the plate holds the local key and shows the form.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Wood screws #8 x 2 in');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    act(() => store.set(live('shelf')));
    expect(word(container)).toBe('Stocked');
    act(() => store.set({ ...live('shelf'), countingUntil: Date.now() + 3000 }));
    expect(word(container)).toBe('Counting');
    act(() => store.set({ ...initial }));
  });

  it('the menu holds this screen on a picked screen until the hub moves on, and Auto follows the hub again', () => {
    act(() => store.set(live('shelf')));
    const { container } = render(<Tv />);
    const pick = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
      fireEvent.click(screen.getByRole('button', { name }));
    };
    expect(screen.queryByRole('navigation')).toBeNull();
    pick('Why');
    expect(word(container)).toBe('Forecast');
    // Picking shuts the menu, and the same hub screen arriving again changes nothing.
    expect(screen.queryByRole('navigation')).toBeNull();
    act(() => store.set(live('shelf')));
    expect(word(container)).toBe('Forecast');
    // The hub moves to the order by itself: the board follows it.
    act(() => store.set(live('order')));
    expect(word(container)).toBe('8 boxes');
    pick('Shelf');
    expect(word(container)).toBe('Reorder');
    pick('Auto');
    expect(word(container)).toBe('8 boxes');
    act(() => store.set({ ...initial }));
  });
});

describe('the X on a finished order', () => {
  it('goes back to the main view, on the board, and Escape does the same', () => {
    act(() => store.set(live('placed')));
    const { container } = render(<Tv />);
    expect(word(container)).toBe('Ordered');
    fireEvent.click(screen.getByRole('button', { name: 'Back to the board' }));
    expect(container.querySelector('.plate')?.getAttribute('aria-label')).toBe('Shelf');
    // The hub moves to another order by itself: the board follows it, and Escape closes that one too.
    act(() => store.set(live('shelf')));
    act(() => store.set(live('placed')));
    expect(word(container)).toBe('Ordered');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.plate')?.getAttribute('aria-label')).toBe('Shelf');
    act(() => store.set({ ...initial }));
  });

  it('is not there while the order is being placed, or on a screen that is not the board', () => {
    const placing = render(<OrderScreen live={live('placing')} onClose={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Back to the board' })).toBeNull();
    placing.unmount();
    render(<OrderScreen live={live('placed')} />);
    expect(screen.queryByRole('button', { name: 'Back to the board' })).toBeNull();
  });
});

describe('moving the ledge boxes on the board', () => {
  const rect = () => vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, x: 0, y: 0, toJSON: () => ({}) });
  const state = (patch: Partial<LiveState> = {}): LiveState => ({ ...live('shelf'), mock: false, ...patch });

  it('the menu offers it on a screen that can change things, every corner is a handle, and Save posts each moved box', async () => {
    const s = mockSnapshot('shelf');
    const zone = s.zones.filter((z) => z.camera === 'board')[0];
    if (!zone) throw new Error('no zone');
    const send = vi.fn(async () => ok(zone));
    const done = vi.fn();
    const spy = rect();
    const { container, rerender } = render(<Shelf live={state()} />);
    expect(container.querySelectorAll('.corner')).toHaveLength(0);
    expect(container.querySelectorAll('.zone > .h').length).toBeGreaterThan(0);
    rerender(<Shelf live={state()} ledges={{ k: 'key', done, send: send as never }} />);
    expect(screen.getByText(LEDGES_HINT)).toBeTruthy();
    expect(container.querySelectorAll('.corner')).toHaveLength(s.zones.filter((z) => z.camera === 'board').length * 4);
    expect(container.querySelectorAll('.zone > .h')).toHaveLength(0);
    // The third corner of the first box is dragged to the middle of the picture, then a little further.
    const corner = screen.getByLabelText(`Corner 3 of ${zone.name}`);
    const feed = container.querySelector('.feed') as HTMLElement;
    const third = zone.quad[2] ?? [0, 0];
    fireEvent.pointerDown(corner, { clientX: third[0] * 1000, clientY: third[1] * 500 });
    fireEvent.pointerMove(feed, { clientX: 480, clientY: 240 });
    fireEvent.pointerMove(feed, { clientX: 500, clientY: 250 });
    fireEvent.pointerUp(feed);
    fireEvent.pointerMove(feed, { clientX: 900, clientY: 450 });
    expect(screen.getByLabelText(`Corner 3 of ${zone.name}`).style.left).toBe('50%');
    fireEvent.click(screen.getByRole('button', { name: LEDGES_SAVE }));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    // Only the box that moved is sent, with its four corners and the key.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('POST', `/api/zones/${zone.id}/quad`, { quad: [zone.quad[0], zone.quad[1], [0.5, 0.5], zone.quad[3]] }, 'key');
    spy.mockRestore();
  });

  it('the middle moves the whole box, the hub saying no keeps the edit open with its reason, and Cancel or Escape saves nothing', async () => {
    const s = mockSnapshot('shelf');
    const zone = s.zones.filter((z) => z.camera === 'board')[0];
    if (!zone) throw new Error('no zone');
    const send = vi.fn(async (): Promise<Reply<unknown>> => ({ ok: false, status: 401, data: null, message: 'That key is not accepted.' }));
    const done = vi.fn();
    const spy = rect();
    const { container } = render(<Shelf live={state()} ledges={{ k: '', done, send: send as never }} />);
    const box = container.querySelector('.zone.editing') as HTMLElement;
    const feed = container.querySelector('.feed') as HTMLElement;
    fireEvent.pointerDown(box, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(feed, { clientX: 150, clientY: 100 });
    fireEvent.pointerUp(feed);
    const moved = zone.quad.map((p) => [Math.round((p[0] + 0.05) * 1000) / 1000, p[1]]);
    fireEvent.click(screen.getByRole('button', { name: LEDGES_SAVE }));
    expect((await screen.findByRole('alert')).textContent).toBe('That key is not accepted.');
    expect(send).toHaveBeenCalledWith('POST', `/api/zones/${zone.id}/quad`, { quad: moved }, '');
    expect(done).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(done).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('on the board the menu opens the edit and Cancel leaves it, and a screen that cannot change things is not offered it', () => {
    act(() => store.set(live('shelf')));
    const { container } = render(<Tv />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    // The sample board has no eye to ask, so only the boxes are offered.
    expect(screen.queryByRole('button', { name: 'Name what is on the teach spot' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move the ledge boxes' }));
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(container.querySelectorAll('.corner').length).toBeGreaterThan(0);
    // While the boxes are being moved the menu does not offer it a second time.
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.queryByRole('button', { name: 'Move the ledge boxes' })).toBeNull();
    // Escape shuts the menu first and the boxes stay. A second Escape leaves the edit.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(container.querySelectorAll('.corner').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(container.querySelectorAll('.corner')).toHaveLength(0);
    expect(screen.getByText(WATCHING)).toBeTruthy();
    act(() => store.set({ ...initial }));
  });
});

describe('naming what is on the teach spot from the menu', () => {
  const cameras = mockSnapshot('shelf').cameras.map((c) => (c.id === 'board' ? { ...c, streamUrl: 'http://127.0.0.1:8090/stream/board.mjpg?x=1' } : { ...c, streamUrl: null }));

  it('asks the eye on its own address, and says what the eye said when it could not', async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    expect(await nameTeachSpot(cameras, fetcher as never)).toBe(LOOKING);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8090/teach', { method: 'POST' });
    const busy = vi.fn(async () => new Response('{"ok":false,"code":"conflict","message":"A new part is already waiting for its name."}', { status: 409 }));
    expect(await nameTeachSpot(cameras, busy as never)).toBe('A new part is already waiting for its name.');
    expect(await nameTeachSpot(cameras, (async () => { throw new Error('offline'); }) as never)).toBe(EYE_AWAY);
    expect(await nameTeachSpot(cameras.map((c) => ({ ...c, streamUrl: null })), fetcher as never)).toBe(EYE_AWAY);
  });

  it('the Shelf shows that line where an alert goes', () => {
    render(<Shelf live={live('shelf')} note={LOOKING} />);
    expect(screen.getByText(LOOKING)).toBeTruthy();
  });
});

describe('the menu', () => {
  it('lists the pages with where you are marked, and the board screens only on the board', () => {
    const { unmount } = render(<Menu page="/analytics" fixed />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const links = screen.getAllByRole('link') as HTMLAnchorElement[];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Board', '/'], ['Analytics', '/analytics'], ['Operator', '/ops'], ['Phone', '/m']]);
    expect(links.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent)).toEqual(['Analytics']);
    expect(screen.queryByRole('button', { name: 'Why' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('navigation')).toBeNull();
    unmount();
    const onLook = vi.fn();
    render(<Menu page="/" look="why" onLook={onLook} />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('button', { name: 'Why' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(onLook).toHaveBeenCalledWith(null);
    // What the board can do is listed last, and picking one shuts the menu.
    const run = vi.fn();
    cleanup();
    render(<Menu page="/" onLook={onLook} actions={[{ label: 'Move the ledge boxes', run }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByText('The board')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move the ledge boxes' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('a click anywhere else shuts it, and a link keeps the mock switch and a hub that lives elsewhere', () => {
    render(<Menu page="/" />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('navigation')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('navigation')).toBeNull();
    const given: Record<string, string> = { mock: '1', hub: 'https://hub.example', k: 'secret' };
    expect(pageHref('/analytics', (name) => given[name] ?? null)).toBe('/analytics?mock=1&hub=https%3A%2F%2Fhub.example');
    expect(pageHref('/ops', () => null)).toBe('/ops');
  });
});

describe('who did what, as a tag', () => {
  it('the board names the shelf node on QNX for what it is doing, and says nothing when it is away', () => {
    const s = mockSnapshot('shelf');
    const node = (patch: Partial<Snapshot['node']>): Snapshot => ({ ...s, node: { ...s.node, ...patch } });
    expect(shelfCredit(node({ online: true, level: 2 }))).toBe('Counted by the shelf node on QNX');
    expect(shelfCredit(node({ online: true, level: 1 }))).toBe('Hands seen by the shelf node on QNX');
    expect(shelfCredit(node({ online: false, level: 1 }))).toBeNull();
    expect(shelfCredit(node({ online: true, level: 0 }))).toBeNull();
  });
});

describe('a part in the wrong box', () => {
  it('is said in one line with the number, the part and the box, and nothing is said when every part is at home', () => {
    const s = mockSnapshot('shelf');
    const pts: [number, number][] = [[0.1, 0.6], [0.15, 0.6], [0.15, 0.7], [0.1, 0.7]];
    expect(wrongBox(s, [{ productId: 'p-glue', points: pts }])).toBeNull();
    expect(wrongBox(s, [{ productId: 'p-discs', points: pts, zoneId: 'z-glue' }])).toBe('1 from sanding discs is in the wood glue box. Not counted.');
    expect(wrongBox(s, [{ productId: 'p-discs', points: pts, zoneId: 'z-glue' }, { productId: 'p-discs', points: pts, zoneId: 'z-glue' }])).toBe('2 from sanding discs are in the wood glue box. Not counted.');
    // A box or a part the hub no longer has is not talked about.
    expect(wrongBox(s, [{ productId: 'p-gone', points: pts, zoneId: 'z-glue' }])).toBeNull();
    expect(wrongBox(s, [{ productId: 'p-discs', points: pts, zoneId: 'z-gone' }])).toBeNull();
  });

  it('the board draws it in orange and says the line where an alert goes', async () => {
    const pts = [[0.1, 0.6], [0.15, 0.6], [0.15, 0.7], [0.1, 0.7]];
    const eyeFetch = vi.fn(async () => new Response(JSON.stringify({ items: [{ productId: 'p-glue', points: pts }, { productId: 'p-discs', points: pts, zoneId: 'z-glue' }] })));
    const { container } = render(<Shelf live={live('shelf', { mock: false })} eyeFetch={eyeFetch as never} />);
    await waitFor(() => expect(container.querySelectorAll('polygon.outline')).toHaveLength(2));
    expect(container.querySelectorAll('polygon.outline.wrong')).toHaveLength(1);
    expect(screen.getByText('1 from sanding discs is in the wood glue box. Not counted.').className).toContain('alert');
  });
});

describe('saying yes and naming a part on the TV itself', () => {
  const teaching = mockSnapshot('teach');

  it('a screen with no key points at a phone, and one with a key has the form', () => {
    const { unmount } = render(<Teach live={live('teach')} bearer={null} />);
    expect(screen.getByText('box of 100 · Offcut OC-1008-200 · fairly sure')).toBeTruthy();
    expect(screen.getByText('Confirm on a phone or the operator page.')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
    unmount();
    render(<Teach live={live('teach')} bearer="key-1" />);
    expect(screen.getByLabelText('Name')).toBeTruthy();
    expect(screen.queryByText('Confirm on a phone or the operator page.')).toBeNull();
  });

  it('a screen with a key has the board with every box on it in place of a list of places, and no line about the teach spot', () => {
    const { container } = render(<Teach live={live('teach')} bearer="key-1" />);
    expect(screen.getByLabelText(WHERE).className).toContain('frame');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(container.textContent).not.toContain('Put one unit on the teach spot');
    // The new part's box starts on the spot it was seen on, so that spot's own box is not drawn under it.
    expect(container.querySelectorAll('.feed .zone')).toHaveLength(4);
    expect(container.querySelectorAll('.feed .zone.fresh')).toHaveLength(1);
    expect(screen.queryByText('Wood screws', { selector: '.tag' })).toBeNull();
    expect(screen.getByText('New part', { selector: '.tag' })).toBeTruthy();
    expect(screen.getAllByRole('slider')).toHaveLength(16);
    expect(screen.getByRole('slider', { name: 'Corner 1 of the new part' })).toBeTruthy();
    // The sentence is on the plate once, with how sure reup is under it. The form does not say it again.
    expect(screen.getByText('Looks like wood screws #8 x 2 in.')).toBeTruthy();
    expect(screen.getByText('fairly sure')).toBeTruthy();
    expect(screen.queryByText('Looks like Wood screws #8 x 2 in. Fairly sure.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
  });

  it('dragging the new box away gives the part a box of its own, and dragging a ledge box saves that box first', async () => {
    const send = vi.fn(async () => ok({}));
    const t = mockSnapshot('teach');
    const { container } = render(<Teach live={live('teach')} bearer="key-1" />);
    const feed = container.querySelector('.feed') as HTMLElement;
    feed.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    // The new box, taken by its middle and set down in the clear strip between the two rows.
    const fresh = container.querySelector('.zone.fresh') as HTMLElement;
    fireEvent.pointerDown(fresh, { clientX: 300, clientY: 130, pointerId: 1 });
    fireEvent.pointerMove(feed, { clientX: 700, clientY: 330, pointerId: 1 });
    fireEvent.pointerUp(feed, { pointerId: 1 });
    // The spot it left has its own box again.
    expect(container.querySelectorAll('.feed .zone')).toHaveLength(5);
    expect(screen.getByText('Wood screws', { selector: '.tag' })).toBeTruthy();
    // One corner of the wood glue box, pulled in.
    fireEvent.pointerDown(screen.getByRole('slider', { name: 'Corner 2 of Wood glue' }), { clientX: 450, clientY: 275, pointerId: 2 });
    fireEvent.pointerMove(feed, { clientX: 400, clientY: 275, pointerId: 2 });
    fireEvent.pointerUp(feed, { pointerId: 2 });
    const teach = t.teach as TeachState;
    const where = placeFor(t, teach, { [FRESH]: [[0.44, 0.5], [0.96, 0.5], [0.96, 0.82], [0.44, 0.82]], 'z-glue': [[0.04, 0.55], [0.4, 0.55], [0.45, 0.92], [0.04, 0.92]] });
    expect(where).toEqual({ moved: [{ id: 'z-glue', quad: [[0.04, 0.55], [0.4, 0.55], [0.45, 0.92], [0.04, 0.92]] }], zoneId: 'z-screws', quad: [[0.44, 0.5], [0.96, 0.5], [0.96, 0.82], [0.44, 0.82]] });
    cleanup();
    // The form saves the moved box, then confirms with the new one.
    render(<TeachForm teach={teach} s={t} send={send as never} bearer="key-1" place={() => where} />);
    expect(screen.queryByLabelText('Where it sits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenNthCalledWith(1, 'POST', '/api/zones/z-glue/quad', { quad: where.moved[0]?.quad }, 'key-1');
    expect(send).toHaveBeenNthCalledWith(2, 'POST', '/api/teach/t-1/confirm', { name: 'Wood screws #8 x 2 in', unit: 'box of 100', sku: 'OC-1008-200', searchPhrase: '#8 x 2 wood screws', zoneId: 'z-screws', quad: where.quad }, 'key-1');
    cleanup();
    // A box that will not save stops the confirm, and says why.
    const refuse = vi.fn(async () => ({ ok: false, status: 404, data: null, message: 'No zone z-glue.' }));
    render(<TeachForm teach={teach} s={t} send={refuse as never} bearer="key-1" place={() => where} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByText('No zone z-glue.')).toBeTruthy());
    expect(refuse).toHaveBeenCalledTimes(1);
  });

  it('a new box left on the teach spot is the teach spot, as before, with its corners when they were dragged', () => {
    const t = mockSnapshot('teach');
    const teach = t.teach as TeachState;
    const spot = t.zones.find((z) => z.id === 'z-screws')?.quad as [number, number][];
    // Untouched: the part takes the zone it was seen on, and nothing else is sent.
    expect(placeFor(t, teach, {})).toEqual({ moved: [], zoneId: 'z-screws' });
    // Fitted to the part but still over the middle of the spot: the spot takes those corners.
    const fitted: [number, number][] = [[0.2, 0.15], [0.4, 0.15], [0.4, 0.4], [0.2, 0.4]];
    expect(placeFor(t, teach, { [FRESH]: fitted })).toEqual({ moved: [{ id: 'z-screws', quad: fitted }], zoneId: 'z-screws' });
    // With no teach spot on the hub the part always gets a box of its own.
    expect(placeFor({ ...t, zones: [] }, { ...teach, zoneId: null }, {})).toEqual({ moved: [], zoneId: 'z-new', quad: START });
    expect(inside(spot, ...centre(spot))).toBe(true);
    expect(inside(spot, 0.9, 0.9)).toBe(false);
    expect(inside([...spot].reverse(), ...centre(spot))).toBe(true);
  });

  it('the frame takes the shape of the picture, so all of it shows', () => {
    expect(frameFor(1, 320, 320)).toEqual({ width: 320, height: 320 });
    expect(frameFor(569 / 640, 320, 320)).toEqual({ width: 288, height: 320 });
    expect(frameFor(2, 320, 320)).toEqual({ width: 320, height: 178 });
    expect(frameFor(Number.NaN, 320, 320)).toEqual({ width: 289, height: 320 });
  });

  it('when naming failed the plate asks for a name in a text field, and has none while it is still naming', () => {
    const failed: Snapshot = { ...teaching, teach: { ...(teaching.teach as TeachState), status: 'failed', suggestion: null, error: 'Naming is not set up. Type a name to add it.' } };
    const { unmount } = render(<Teach live={{ ...live('teach'), snapshot: failed }} bearer="key-1" />);
    expect(screen.getByText('Type its name.')).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Not a part' })).toBeTruthy();
    unmount();
    const naming: Snapshot = { ...teaching, teach: { ...(teaching.teach as TeachState), status: 'naming', suggestion: null } };
    render(<Teach live={{ ...live('teach'), snapshot: naming }} bearer="key-1" />);
    expect(screen.getByText('Naming it.')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  it('the order screen says yes with a click on Approve or with Enter, and has neither without a key', async () => {
    const s = mockSnapshot('order');
    const order = s.orders[0] as Order;
    const send = vi.fn(async () => ok(order));
    const { unmount, container } = render(<ApproveHere order={order} k="key-1" send={send as never} />);
    fireEvent.click(screen.getByRole('button', { name: APPROVE }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('POST', `/api/orders/${order.id}/approve`, { by: 'keyboard' }, 'key-1'));
    expect(send).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      fireEvent.keyDown(window, { key: 'Enter' });
      expect(send).toHaveBeenCalledTimes(2);
    });
    // Enter typed into a field is not a yes, and neither is another key or a held one. Enter on a button is that button's own click.
    const field = document.body.appendChild(document.createElement('input'));
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyDown(window, { key: 'Enter', repeat: true });
    fireEvent.keyDown(screen.getByRole('button', { name: APPROVE }), { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(2);
    field.remove();
    unmount();
    const none = render(<ApproveHere order={order} k={null} send={send as never} />);
    expect(none.container.innerHTML).toBe('');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(container).toBeTruthy();
  });

  it('a second click while the hub is answering does not say yes twice', async () => {
    const order = mockSnapshot('order').orders[0] as Order;
    let answer: (r: Reply<Order>) => void = () => undefined;
    const send = vi.fn(() => new Promise<Reply<Order>>((resolve) => { answer = resolve; }));
    render(<ApproveHere order={order} k="key-1" send={send as never} />);
    const button = screen.getByRole('button', { name: APPROVE }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => answer(ok(order)));
    expect(button.disabled).toBe(false);
  });

  it('the order screen says why when the hub says no', async () => {
    const s = mockSnapshot('order');
    const send = vi.fn(async () => ({ ok: false, status: 409, data: null, message: 'This order is over the spend cap.' }));
    render(<ApproveHere order={s.orders[0] as Order} k="key-1" send={send as never} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('This order is over the spend cap.')).toBeTruthy());
  });

  it('the line names only what can say yes right now', () => {
    expect(howToSayYes(true, false)).toBe('Press the wooden button to place the order.');
    expect(howToSayYes(true, true)).toBe('Press the wooden button to place the order.');
    // A screen that can say yes and has no shelf node: the button is the line, nothing is written above it.
    expect(howToSayYes(false, true)).toBeNull();
    expect(howToSayYes(false, false)).toBe('Say yes from a phone to place the order.');
  });
});

describe('the phone', () => {
  const s = mockSnapshot('order');
  const order = s.orders[0] as Order;

  it('approve posts by phone with the key', async () => {
    const send = vi.fn(async () => ok(order));
    render(<ApproveBand order={order} s={s} send={send as never} k="key-1" first />);
    expect(screen.getByText('8 boxes')).toBeTruthy();
    expect(screen.getByText('With tax · arrives Tuesday · PO RU-1042')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('POST', `/api/orders/${order.id}/approve`, { by: 'phone' }, 'key-1'));
  });

  it('says this phone cannot approve when it has no key, without calling the hub', () => {
    const send = vi.fn();
    render(<ApproveBand order={order} s={s} send={send as never} k={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByText(NO_KEY)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('the teach form posts a TeachConfirmBody, and Not a part cancels', async () => {
    const t = mockSnapshot('teach');
    const teach = t.teach as TeachState;
    const send = vi.fn(async () => ok({}));
    render(<TeachForm teach={teach} s={t} send={send as never} bearer="key-1" />);
    expect(screen.getByText('Looks like Wood screws #8 x 2 in. Fairly sure.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('One unit is'), { target: { value: 'box of 50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('POST', '/api/teach/t-1/confirm', { name: 'Wood screws #8 x 2 in', unit: 'box of 50', sku: 'OC-1008-200', searchPhrase: '#8 x 2 wood screws', zoneId: 'z-screws' }, 'key-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Not a part' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('POST', '/api/teach/t-1/cancel', undefined, 'key-1'));
  });
});

describe('the operator page', () => {
  const s = mockSnapshot('shop');

  it('save posts the zones as a ZonesBody, after an edit', async () => {
    const send = vi.fn(async () => ok({ ok: true }));
    render(<ZoneEditor s={s} ops="ops-1" send={send as never} />);
    expect((screen.getByRole('button', { name: 'Save zones' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Rows'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save zones' }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    const [method, path, body, token] = send.mock.calls[0] as unknown as [string, string, { zones: Snapshot['zones'] }, string];
    expect([method, path, token]).toEqual(['PUT', '/api/zones', 'ops-1']);
    expect(body.zones).toHaveLength(s.zones.length);
    expect(body.zones[0]).toMatchObject({ id: 'z-screws', rows: 3, cols: 6 });
    await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
  });

  it('set camera position tells the eye where the camera sits now', async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetched);
    try {
      render(<ZoneEditor s={s} ops="ops-1" send={vi.fn() as never} />);
      fireEvent.click(screen.getByRole('button', { name: 'Set camera position' }));
      await waitFor(() => expect(screen.getByText('Camera position saved. Check that every zone still sits on its ledge.')).toBeTruthy());
      expect(fetched.mock.calls[0]).toEqual(['http://192.168.1.20:8089/anchor/board', { method: 'POST' }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('capture full board asks the eye and says what each open zone holds', async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ ok: true, zones: { 'z-glue': { units: 4, cells: 820 } }, skipped: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetched);
    try {
      render(<ZoneEditor s={s} ops="ops-1" send={vi.fn() as never} />);
      fireEvent.click(screen.getByRole('button', { name: 'Capture full board' }));
      await waitFor(() => expect(screen.getByText('Full board captured: Wood glue 4.')).toBeTruthy());
      expect(fetched.mock.calls[0]).toEqual(['http://192.168.1.20:8089/full/board', { method: 'POST' }]);
      fetched.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, code: 'conflict', message: 'Save the empty board for that camera first.' }), { status: 409 }));
      fireEvent.click(screen.getByRole('button', { name: 'Capture full board' }));
      await waitFor(() => expect(screen.getByText('Save the empty board for that camera first.')).toBeTruthy());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reset asks for confirmation first', async () => {
    const send = vi.fn(async () => ok(s));
    render(<Controls s={s} ops="ops-1" send={send as never} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset demo' }));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Press again to reset' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('POST', '/api/demo/reset', undefined, 'ops-1'));
  });

  it('posts the season factor, the replay switch, a manual order and a cancel', async () => {
    const send = vi.fn(async () => ok({ ok: true }));
    render(<Controls s={s} ops="ops-1" send={send as never} />);
    fireEvent.click(screen.getByRole('button', { name: 'Busy' }));
    fireEvent.click(screen.getByRole('button', { name: 'cart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order RU-1042' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    expect(send.mock.calls.map((c) => (c as unknown[]).slice(0, 3))).toEqual([
      ['POST', '/api/demo/season', { label: 'Busy', factor: 1.4 }],
      ['POST', '/api/demo/replay', { kind: 'cart', on: true }],
      ['POST', '/api/orders', { productId: 'p-screws' }],
      ['POST', '/api/orders/o-1/cancel', undefined],
    ]);
  });
});
