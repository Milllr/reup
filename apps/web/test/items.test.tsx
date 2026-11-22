import { ProductAddBody, ProductCountBody, ProductEditBody, type Snapshot } from '@reup/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import catalog from '../../../contracts/mocks/catalog.json';
import type { Reply } from '../src/lib/hub';
import { AnalyticsView } from '../src/screens/analytics';
import { BY_HAND, countedBy, freeZones, Items, ITEMS_MOCK, ITEMS_NO_KEY } from '../src/screens/analytics/items';
import { mockSnapshot } from '../src/store/mock';
import { initial, type LiveState } from '../src/store/reduce';

const ok = <T,>(data: T): Reply<T> => ({ ok: true, status: 200, data, message: null });
/** The sample board with one more zone that holds nothing: the teach spot, as on the station. */
const board = (at = 'shelf'): Snapshot => {
  const s = mockSnapshot(at);
  return { ...s, zones: [...s.zones, { id: 'z-teach', name: 'Teach spot', kind: 'open', camera: 'board', quad: [[0.8, 0.6], [0.9, 0.6], [0.9, 0.8], [0.8, 0.8]], rows: null, cols: null, productId: null }] };
};
const live = (patch: Partial<LiveState> = {}): LiveState => ({ ...initial, snapshot: board(), connected: true, mock: false, ...patch });
/** A hub that serves the catalog and says yes to everything else, unless told what to say. */
const hub = (answer: (method: string, path: string, body: unknown) => Reply<unknown> = () => ok({})) =>
  vi.fn(async (method: string, path: string, body?: unknown, _key?: string | null) => (method === 'GET' && path === '/api/catalog' ? ok(catalog) : answer(method, path, body)));
const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
const writes = (send: ReturnType<typeof hub>) => send.mock.calls.filter(([method]) => method !== 'GET');

describe('items on the dashboard', () => {
  it('lists every item with what it is bought as, how it is counted and its count', async () => {
    const s = board();
    render(<Items live={live()} k="key-1" send={hub() as never} />);
    for (const p of s.products) expect(screen.getByText(p.name)).toBeTruthy();
    const screws = s.products.find((p) => p.id === 'p-screws');
    if (!screws) throw new Error('no screws in the mock');
    expect(countedBy(s, screws)).toBe('Camera · Wood screws');
    expect(countedBy(s, { ...screws, zoneId: null })).toBe('By hand');
    expect(within(row(screws.name)).getByText('OC-1008-114')).toBeTruthy();
    expect((within(row(screws.name)).getByLabelText(`Count of ${screws.name}`) as HTMLInputElement).value).toBe('6');
    // The teach spot is the free zone here. A zone with a new part waiting on it is not free.
    expect(freeZones(s).map((z) => z.id)).toEqual(['z-teach']);
    const waiting = board('teach');
    expect(freeZones({ ...waiting, teach: waiting.teach ? { ...waiting.teach, zoneId: 'z-teach' } : null })).toEqual([]);
    await waitFor(() => expect(screen.getAllByRole('option', { name: /OC-3473/ }).length).toBeGreaterThan(0));
  });

  it('with no key it only shows the items, and on the sample board nothing is sent', async () => {
    const send = hub();
    const { unmount } = render(<Items live={live()} k={null} send={send as never} />);
    expect(screen.getByText(ITEMS_NO_KEY)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Add an item')).toBeNull();
    unmount();
    render(<Items live={live({ mock: true })} k="key-1" send={send as never} />);
    const name = mockSnapshot('shelf').products[0]?.name ?? '';
    fireEvent.click(within(row(name)).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(row(name)).getByRole('button', { name: 'Press again to remove' }));
    await waitFor(() => expect(screen.getByText(ITEMS_MOCK)).toBeTruthy());
    expect(writes(send)).toHaveLength(0);
  });

  it('sets a count by hand with the key, only when it is a new whole number', async () => {
    const send = hub();
    render(<Items live={live()} k="key-1" send={send as never} />);
    const glue = within(row('Wood glue 473 mL'));
    const field = glue.getByLabelText('Count of Wood glue 473 mL') as HTMLInputElement;
    const set = glue.getByRole('button', { name: 'Set' }) as HTMLButtonElement;
    expect(set.disabled).toBe(true);
    for (const bad of ['', '-1', '2.5', field.value]) {
      fireEvent.change(field, { target: { value: bad } });
      expect(set.disabled).toBe(true);
    }
    fireEvent.change(field, { target: { value: '1' } });
    expect(set.disabled).toBe(false);
    fireEvent.click(set);
    await waitFor(() => expect(writes(send)).toHaveLength(1));
    expect(writes(send)[0]).toEqual(['POST', '/api/products/p-glue/count', { count: 1 }, 'key-1']);
    expect(ProductCountBody.parse(writes(send)[0]?.[2])).toEqual({ count: 1 });
    await waitFor(() => expect(screen.getByText('Wood glue 473 mL: 1 on the shelf.')).toBeTruthy());
  });

  it('edits the details in place and sends a valid ProductEditBody', async () => {
    const send = hub();
    render(<Items live={live()} k="key-1" send={send as never} />);
    await waitFor(() => expect(screen.getAllByRole('option', { name: /OC-3473/ }).length).toBeGreaterThan(0));
    fireEvent.click(within(row('Wood glue 473 mL')).getByRole('button', { name: 'Edit' }));
    const form = within(screen.getByLabelText('Change Wood glue 473 mL'));
    fireEvent.change(form.getByLabelText('Name'), { target: { value: '  Wood glue, small  ' } });
    fireEvent.change(form.getByLabelText('Bought as'), { target: { value: 'OC-2202' } });
    fireEvent.change(form.getByLabelText('Search words for retailers'), { target: { value: '' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(send)).toHaveLength(1));
    const [method, path, body, key] = writes(send)[0] ?? [];
    expect([method, path, key]).toEqual(['PUT', '/api/products/p-glue', 'key-1']);
    // The name is trimmed, and with no search words the name is searched for.
    expect(ProductEditBody.parse(body)).toEqual({ name: 'Wood glue, small', unit: 'each', sku: 'OC-2202', searchPhrase: 'Wood glue, small' });
    // Saved: the row is a row again.
    await waitFor(() => expect(screen.queryByLabelText('Change Wood glue 473 mL')).toBeNull());
    // Cancel sends nothing.
    fireEvent.click(within(row('Wood glue 473 mL')).getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(writes(send)).toHaveLength(1);
  });

  it('removes only on the second press, and shows the hub\'s own words when it says no', async () => {
    const send = hub(() => ({ ok: false, status: 409, data: null, message: 'Order RU-1042 for Wood screws #8 x 1-1/4 in is being placed. Remove the item once it is done.' }));
    render(<Items live={live()} k="key-1" send={send as never} />);
    const screws = within(row('Wood screws #8 x 1-1/4 in'));
    fireEvent.click(screws.getByRole('button', { name: 'Remove' }));
    expect(writes(send)).toHaveLength(0);
    // Looking away disarms it.
    fireEvent.blur(screws.getByRole('button', { name: 'Press again to remove' }));
    expect(screws.getByRole('button', { name: 'Remove' })).toBeTruthy();
    fireEvent.click(screws.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screws.getByRole('button', { name: 'Press again to remove' }));
    await waitFor(() => expect(writes(send)).toEqual([['POST', '/api/products/p-screws/remove', undefined, 'key-1']]));
    await waitFor(() => expect(screen.getByText(/is being placed\. Remove the item once it is done\./)).toBeTruthy());
    expect(screen.getByText(/is being placed/).className).toContain('alert');
  });

  it('a removed item is just gone: nothing on the page says it was removed', async () => {
    const send = hub();
    const { container } = render(<Items live={live()} k="key-1" send={send as never} />);
    const screws = within(row('Wood screws #8 x 1-1/4 in'));
    fireEvent.click(screws.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screws.getByRole('button', { name: 'Press again to remove' }));
    await waitFor(() => expect(writes(send)).toEqual([['POST', '/api/products/p-screws/remove', undefined, 'key-1']]));
    await waitFor(() => expect(screws.getByRole('button', { name: 'Remove' })).toBeTruthy());
    expect(container.textContent).not.toMatch(/removed/i);
    expect(container.querySelector('[aria-live] .tag')).toBeNull();
  });

  it('adds an item: picking a store item fills its name and unit, and it goes on a free ledge or is counted by hand', async () => {
    const send = hub();
    render(<Items live={live()} k="key-1" send={send as never} />);
    const form = within(screen.getByLabelText('Add an item'));
    const add = form.getByRole('button', { name: 'Add item' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await waitFor(() => expect(form.getAllByRole('option', { name: /OC-7009/ }).length).toBe(1));
    fireEvent.change(form.getByLabelText('Bought as'), { target: { value: 'OC-7009' } });
    const item = catalog.items.find((i) => i.sku === 'OC-7009');
    expect((form.getByLabelText('Name') as HTMLInputElement).value).toBe(item?.name);
    expect((form.getByLabelText('Unit') as HTMLInputElement).value).toBe(item?.unit);
    expect(within(form.getByLabelText('Counted')).getAllByRole('option').map((o) => o.textContent)).toEqual(['By hand', 'By the camera, on Teach spot']);
    expect((form.getByLabelText('Counted') as HTMLSelectElement).value).toBe(BY_HAND);
    fireEvent.change(form.getByLabelText('On the shelf now'), { target: { value: '5' } });
    fireEvent.click(add);
    await waitFor(() => expect(writes(send)).toHaveLength(1));
    expect(writes(send)[0]?.slice(0, 2)).toEqual(['POST', '/api/products']);
    expect(ProductAddBody.parse(writes(send)[0]?.[2])).toEqual({ name: item?.name, unit: item?.unit, sku: 'OC-7009', zoneId: null, count: 5 });
    // Added: the form is empty again.
    await waitFor(() => expect((form.getByLabelText('Name') as HTMLInputElement).value).toBe(''));
    // A typed item on the free ledge, matched to nothing in the store.
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Zip ties' } });
    fireEvent.change(form.getByLabelText('Unit'), { target: { value: 'bag of 100' } });
    fireEvent.change(form.getByLabelText('Counted'), { target: { value: 'z-teach' } });
    fireEvent.click(add);
    await waitFor(() => expect(writes(send)).toHaveLength(2));
    expect(ProductAddBody.parse(writes(send)[1]?.[2])).toEqual({ name: 'Zip ties', unit: 'bag of 100', sku: null, zoneId: 'z-teach', count: 1 });
  });

  it('sits on the Analytics page, and says so when there are no items', () => {
    const { unmount } = render(<AnalyticsView live={live({ mock: true })} a={null} />);
    expect(screen.queryByLabelText('Items')).toBeNull();
    unmount();
    const empty: Snapshot = { ...mockSnapshot('shelf'), products: [], counts: [], policies: [] };
    render(<Items live={live({ snapshot: empty })} k="key-1" send={hub() as never} />);
    expect(screen.getByText('No items yet. Add one below, or put a part on the teach spot.')).toBeTruthy();
    expect(screen.getByLabelText('Add an item')).toBeTruthy();
  });
});
