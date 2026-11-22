import type { AskResult, HistoryResult, Order, Snapshot, TeachState } from '@reup/contracts';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import history from '../../../contracts/mocks/history.json';
import type { Reply } from '../src/lib/hub';
import { Menu, pageHref } from '../src/screens/menu';
import { ApproveHere, howToSayYes, Order as OrderScreen } from '../src/screens/order';
import { Controls, ZoneEditor } from '../src/screens/ops';
import { ApproveBand, NO_KEY, TeachForm } from '../src/screens/phone';
import { NO_FEED, NO_PARTS, Shelf, WATCHING } from '../src/screens/shelf';
import { panes, Shop, shopSentence } from '../src/screens/shop';
import { Teach } from '../src/screens/teach';
import { Tv } from '../src/screens/tv';
import { ASK_EMPTY, ASK_FALLBACK, ASK_WAIT, AskReup, Chart, scales, sourceLine, Why } from '../src/screens/why';
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
    expect(screen.getByText('Wood screws · 6 of 12')).toBeTruthy();
    expect(screen.getByText('Wood glue · 3 of 4')).toBeTruthy();
    expect(container.querySelectorAll('.feed .zone')).toHaveLength(4);
    expect(container.querySelectorAll('.pocket.full')).toHaveLength(6 + 5);
    expect(screen.getByText('Reorder at 4 · 11 days of cover')).toBeTruthy();
    expect(screen.getByText(WATCHING)).toBeTruthy();
    expect(screen.getByText('Counted by the shelf node on QNX')).toBeTruthy();
  });

  it('cuts to the wine plate and Reorder at the reorder point', () => {
    const { container } = render(<Shelf live={live('low')} />);
    expect(plate(container)).toContain('wine');
    expect(word(container)).toBe('Reorder');
    expect(screen.getByText('Wood screws · 4 of 12').className).toContain('alert');
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

  it('tags the count only when the shelf node on QNX does it, and the mono line is the time alone', () => {
    const node = render(<Shelf live={live('shelf')} />);
    expect(screen.getByText('Counted by the shelf node on QNX')).toBeTruthy();
    expect(node.container.querySelector('.meta.abs')?.textContent).toBe('Sat 9:14 AM');
    node.unmount();
    const l = live('shelf');
    (l.snapshot as Snapshot).node.level = 1;
    const eye = render(<Shelf live={l} />);
    expect(eye.container.querySelector('.tag.center')).toBeNull();
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
    expect(screen.getByText('Your supplier · Offcut Supply')).toBeTruthy();
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
    expect(shopSentence(s, list, order)).toBe('Filling a cart at Offcut Supply. 2 of 2 price checks came back. Nothing is bought until someone says yes.');
    const done = panes(s, { ...order, total: 67.71 }, product)[2];
    expect([done?.state, done?.figure, done?.meta]).toEqual(['done', '$67.71', '8 boxes in the cart · with tax']);
  });

  it('shows loading before any step, a replay tag for a recording, and says when a local stand in shopped', () => {
    const bare: Snapshot = { ...s, runs: [], quotes: [] };
    expect(panes(bare, order, product).map((p) => [p.state, p.figure, p.meta])).toEqual(Array(3).fill(['loading', 'Starting', 'Opening a browser.']));
    const replayed: Snapshot = { ...s, runs: s.runs.map((r) => ({ ...r, replay: true, engine: 'local' as const })) };
    expect(panes(replayed, order, product).map((p) => p.tag)).toEqual(['Price check · Retailer A · replay', 'Blocked · Retailer B · replay', 'Your supplier · Offcut Supply · replay']);
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
    expect(screen.getByText('Or click Approve, press Enter, or say yes from a phone. Nothing is bought until then.')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Approve']);
    expect(screen.getByText('8 boxes fills the board and arrives before it runs out. Retailer A is $1.20 more per box.')).toBeTruthy();
    expect(screen.getByText('Waiting for a yes · PO RU-1042 · spend cap $150 an order')).toBeTruthy();
    expect(container.querySelector('.frame.waiting')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'A box of Wood screws #8 x 1-1/4 in' })).toBeTruthy();
  });

  it('hides the market note when there is none', () => {
    const l = live('order');
    (l.snapshot as Snapshot).orders = (l.snapshot as Snapshot).orders.map((o) => ({ ...o, marketNote: null }));
    render(<OrderScreen live={l} />);
    expect(screen.getByText('8 boxes fills the board and arrives before it runs out.')).toBeTruthy();
  });

  it('placing is wine with the live pane; placed is olive with the confirmation; failed and cancelled say nothing was bought', () => {
    let r = at('placing');
    expect([plate(r.container).includes('wine'), word(r.container)]).toEqual([true, 'Placing']);
    expect(screen.getByText('Placing the order at Offcut Supply.')).toBeTruthy();
    expect(screen.getByText('Approved with the wooden button · PO RU-1042')).toBeTruthy();
    r.unmount();
    r = at('placed');
    expect([plate(r.container).includes('olive'), word(r.container)]).toEqual([true, 'Ordered']);
    expect(screen.getByText('OC-58213')).toBeTruthy();
    expect(screen.getByText('Ordered. Arrives Tuesday.')).toBeTruthy();
    expect(screen.getByText('Confirmation · arrives Tuesday · $67.71')).toBeTruthy();
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
});

describe('Ask reup', () => {
  const result = (patch: Partial<AskResult> = {}): AskResult => ({ answer: 'Wood screws, 14 boxes in the last 7 days.', source: 'gemini', facts: ['a', 'b'], ...patch });
  const askOnce = (q = 'What did we use most this week?') => {
    fireEvent.change(screen.getByPlaceholderText('What did we use most this week?'), { target: { value: q } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  };

  it('starts empty with a hint, and Ask waits for a question', () => {
    render(<AskReup ask={vi.fn()} />);
    expect(screen.getByText(ASK_EMPTY)).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
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
    fireEvent.keyDown(screen.getByRole('button', { name: 'Approve' }), { key: 'Enter' });
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
    const button = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
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
    expect(howToSayYes(true, false).line).toBe('Press the wooden button to place the order.');
    expect(howToSayYes(true, true)).toEqual({ line: 'Press the wooden button to place the order.', also: 'Or click Approve, press Enter, or say yes from a phone. Nothing is bought until then.' });
    expect(howToSayYes(false, true)).toEqual({ line: 'Approve to place the order.', also: 'Click it or press Enter. A phone can say yes too. Nothing is bought until then.' });
    expect(howToSayYes(false, false)).toEqual({ line: 'Say yes from a phone to place the order.', also: 'Nothing is bought until then.' });
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
    fireEvent.click(screen.getByRole('button', { name: 'Busy week' }));
    fireEvent.click(screen.getByRole('button', { name: 'cart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order RU-1042' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    expect(send.mock.calls.map((c) => (c as unknown[]).slice(0, 3))).toEqual([
      ['POST', '/api/demo/season', { label: 'Busy week', factor: 1.4 }],
      ['POST', '/api/demo/replay', { kind: 'cart', on: true }],
      ['POST', '/api/orders', { productId: 'p-screws' }],
      ['POST', '/api/orders/o-1/cancel', undefined],
    ]);
  });
});
