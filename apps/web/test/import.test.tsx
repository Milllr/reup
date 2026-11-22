import { reorderPoint } from '@reup/brain';
import { Catalog, ProductAddBody, type Snapshot } from '@reup/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import catalogMock from '../../../contracts/mocks/catalog.json';
import importMock from '../../../contracts/mocks/product-import.json';
import sample from '../../../docs/samples/inventory-export.csv?raw';
import type { Reply } from '../src/lib/hub';
import { ALREADY_HERE, EMPTY_FILE, MAX_ROWS, NO_NAME_COLUMN, parseCsv, readExport, rowBody, TWICE, useColumn } from '../src/screens/analytics/export';
import { IMPORT_HINT, NO_USE_COLUMN } from '../src/screens/analytics/import';
import { Items, ITEMS_MOCK } from '../src/screens/analytics/items';
import { mockSnapshot } from '../src/store/mock';
import { initial, type LiveState } from '../src/store/reduce';

const catalog = Catalog.parse(catalogMock).items;
const s = mockSnapshot('shelf');
const ok = <T,>(data: T): Reply<T> => ({ ok: true, status: 200, data, message: null });
const live = (patch: Partial<LiveState> = {}): LiveState => ({ ...initial, snapshot: s, connected: true, mock: false, ...patch });
const hub = (answer: (method: string, path: string, body: unknown) => Reply<unknown> = () => ok({})) =>
  vi.fn(async (method: string, path: string, body?: unknown, _key?: string | null) => (method === 'GET' && path === '/api/catalog' ? ok(catalogMock) : answer(method, path, body)));
const writes = (send: ReturnType<typeof hub>) => send.mock.calls.filter(([method]) => method !== 'GET');
const choose = (text: string, name = 'export.csv') => fireEvent.change(screen.getByLabelText('Inventory export'), { target: { files: [new File([text], name, { type: 'text/csv' })] } });

describe('reading an inventory export', () => {
  it('reads CSV with quoted cells, either line ending, a byte order mark and another separator', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n1,2\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['1', '2']]);
    expect(parseCsv('Name;Qty\n"Tape;blue";3')).toEqual([['Name', 'Qty'], ['Tape;blue', '3']]);
    expect(parseCsv('Name\tQty\nTape\t3')).toEqual([['Name', 'Qty'], ['Tape', '3']]);
    expect(parseCsv('')).toEqual([]);
  });

  it('finds the use column and the days its heading covers, and leaves prices and units alone', () => {
    expect(useColumn(['Item Name', 'Usage unit', 'Quantity Sold (30 days)'])).toMatchObject({ index: 2, days: 30 });
    expect(useColumn(['Name', 'Used per day'])).toMatchObject({ index: 1, days: 1 });
    expect(useColumn(['Name', 'Weekly usage'])?.days).toBe(7);
    expect(useColumn(['Name', 'Sold last 90 days'])?.days).toBe(90);
    expect(useColumn(['Name', 'Annual demand'])?.days).toBe(365);
    expect(useColumn(['Name', 'Quantity Sold'])?.days).toBe(30);
    expect(useColumn(['Name', 'Selling Price', 'Usage unit', 'Stock On Hand'])).toBeNull();
  });

  it('turns the sample export into items: the unit, what is on hand, use a day and the reorder point that use gives', () => {
    const read = readExport(sample, s, catalog);
    expect(read.problem).toBeNull();
    expect(read.use).toBe('"Quantity Sold (30 days)" is read as units in 30 days.');
    expect(read.rows.map((r) => r.name)).toEqual(['#8 x 2 in Wood Screws, Robertson', 'Corner brackets 2 in', '5 in Sanding Discs, 220 Grit', "Painter's Tape 24 mm x 55 m", 'Shop towels', '9V batteries']);
    const [screws, brackets, , tape, towels] = read.rows;
    // The store sells it under the same name: it is matched, and the store's 1 day of delivery draws its line.
    expect(screws).toMatchObject({ unit: 'box of 100', sku: 'OC-1008-200', count: 24, usePerDay: 1.5, skip: null });
    expect(screws?.reorderAt).toBe(reorderPoint(1.5 * s.season.factor, 1, undefined, undefined, 24));
    expect(tape).toMatchObject({ sku: 'OC-3610', count: 18, usePerDay: 0.2 });
    expect(towels?.sku).toBeNull();
    // Not used at all: never reordered. On the board already: left out.
    expect(towels).toMatchObject({ usePerDay: 0, reorderAt: 0, skip: null });
    expect(brackets?.skip).toBe(ALREADY_HERE);
    // Every row the hub would be sent is a valid body, and so is the contract's own example.
    for (const r of read.rows) ProductAddBody.parse(rowBody(r));
    expect(rowBody({ ...(screws as NonNullable<typeof screws>), name: importMock.name, sku: null })).toEqual(importMock);
  });

  it('reads the headings other systems use, matches the store by code or by name, and says what it could not read', () => {
    const store = catalog[0];
    if (!store) throw new Error('no catalog');
    const cin7 = readExport(`SKU,ProductName,UOM,Available\n${store.sku},Anything,,"1,250"\nX-1,"${store.name.toUpperCase()}",bag,7\nX-1,Anything,bag,7`, s, catalog);
    expect(cin7.use).toBeNull();
    expect(cin7.rows[0]).toMatchObject({ name: 'Anything', sku: store.sku, unit: store.unit, count: 1250, usePerDay: null, reorderAt: null });
    expect(cin7.rows[1]).toMatchObject({ sku: store.sku, unit: 'bag', count: 7 });
    expect(cin7.rows[2]?.skip).toBe(TWICE);
    expect(rowBody(cin7.rows[0] as NonNullable<(typeof cin7.rows)[0]>)).not.toHaveProperty('usePerDay');
    const fishbowl = readExport('PartNumber,PartDescription,UOM,Qty,Used per day\nB201,Brake cable,ea,-4,2.5\nB202,,ea,1,1', s, catalog);
    expect(fishbowl.rows).toHaveLength(1);
    expect(fishbowl.rows[0]).toMatchObject({ name: 'Brake cable', sku: null, unit: 'ea', count: 0, usePerDay: 2.5 });
    expect(readExport('Code,Qty\nA,1', s, catalog).problem).toBe(NO_NAME_COLUMN);
    expect(readExport('Name,Qty\n', s, catalog).problem).toBe(EMPTY_FILE);
    const long = readExport(`Name\n${Array.from({ length: MAX_ROWS + 5 }, (_, i) => `Part ${i}`).join('\n')}`, s, catalog);
    expect(long.rows).toHaveLength(MAX_ROWS);
    expect(long.left).toBe(5);
  });
});

describe('Import a list on the dashboard', () => {
  it('shows what the file holds, then adds each new item with its use a day, one at a time', async () => {
    const send = hub();
    render(<Items live={live()} k="key-1" send={send as never} />);
    expect(screen.getByText(IMPORT_HINT)).toBeTruthy();
    expect(screen.queryByLabelText('Items in the file')).toBeNull();
    choose(sample);
    const table = within(await screen.findByLabelText('Items in the file'));
    expect(table.getAllByRole('row')).toHaveLength(7);
    expect(within(table.getByText('Corner brackets 2 in').closest('tr') as HTMLElement).getByText(ALREADY_HERE)).toBeTruthy();
    expect(within(table.getByText('Shop towels').closest('tr') as HTMLElement).getByText('Never, not used')).toBeTruthy();
    expect(screen.getByText(/"Quantity Sold \(30 days\)" is read as units in 30 days\./)).toBeTruthy();
    const fresh = readExport(sample, s, catalog).rows.filter((r) => r.skip == null);
    // The store's catalog arrives after the page: the rows it sells are matched once it is in.
    await waitFor(() => expect(within(table.getByText("Painter's Tape 24 mm x 55 m").closest('tr') as HTMLElement).getByText('OC-3610')).toBeTruthy());
    const add = screen.getByRole('button', { name: /^Add \d+ items$/ });
    expect(add.textContent).toBe(`Add ${fresh.length} items`);
    fireEvent.click(add);
    await waitFor(() => expect(writes(send)).toHaveLength(fresh.length));
    expect(writes(send).map((c) => [c[0], c[1], c[3]])).toEqual(fresh.map(() => ['POST', '/api/products', 'key-1']));
    expect(writes(send).map((c) => ProductAddBody.parse(c[2]))).toEqual(fresh.map(rowBody));
    expect(writes(send)[0]?.[2]).toMatchObject({ zoneId: null, count: 24, usePerDay: 1.5 });
    // All in: the file is put away and the last line says so.
    await waitFor(() => expect(screen.queryByLabelText('Items in the file')).toBeNull());
    expect(screen.getByText(`${fresh.length} of ${fresh.length} added.`)).toBeTruthy();
  });

  it('stops at the first item the hub refuses and shows why, says so when the file has no use, and Clear puts the file away', async () => {
    let n = 0;
    const send = hub(() => (++n === 2 ? { ok: false, status: 409, data: null, message: 'There is already an item called Sanding discs.' } : ok({})));
    render(<Items live={live()} k="" send={send as never} />);
    choose(sample);
    fireEvent.click(await screen.findByRole('button', { name: /^Add \d+ items$/ }));
    expect(await screen.findByText('There is already an item called Sanding discs.')).toBeTruthy();
    expect(writes(send)).toHaveLength(2);
    expect(screen.getByLabelText('Items in the file')).toBeTruthy();
    choose('Name,On Hand\nZip ties,40');
    expect(await screen.findByText(new RegExp(NO_USE_COLUMN.slice(0, 40)))).toBeTruthy();
    expect(screen.getByText('From sample use')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add 1 item' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByLabelText('Items in the file')).toBeNull();
    choose('Code,Qty\nA,1');
    expect((await screen.findByRole('alert')).textContent).toBe(NO_NAME_COLUMN);
  });

  it('on the sample board the file is read and nothing is sent, and a screen with no key is not offered it', async () => {
    const send = hub();
    const { unmount } = render(<Items live={live({ mock: true })} k="key-1" send={send as never} />);
    choose(sample);
    fireEvent.click(await screen.findByRole('button', { name: /^Add \d+ items$/ }));
    expect(await screen.findByText(ITEMS_MOCK)).toBeTruthy();
    expect(writes(send)).toHaveLength(0);
    unmount();
    render(<Items live={live()} k={null} send={send as never} />);
    expect(screen.queryByLabelText('Inventory export')).toBeNull();
  });
});
