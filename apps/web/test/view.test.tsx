import type { Order, Zone } from '@reup/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bandWordSize, labelLines, Units, Word, wordSize } from '../src/components';
import { clock, duration, orderMoment, partRows, shelfMoment, shortTime, zoneBox, totalLabel } from '../src/lib/view';
import { addZone, moveCorner, moveZone, patchZone } from '../src/screens/ops/zones';
import { mockSnapshot } from '../src/store/mock';

describe('the plate and the word for each moment', () => {
  it('Shelf: Stocked, Reorder, On the way, Empty', () => {
    expect(shelfMoment(mockSnapshot('shelf'))).toEqual({ plate: 'olive', word: 'Stocked' });
    expect(shelfMoment(mockSnapshot('low'))).toEqual({ plate: 'wine', word: 'Reorder' });
    expect(shelfMoment(mockSnapshot('ontheway'))).toEqual({ plate: 'olive', word: 'On the way' });
    expect(shelfMoment(mockSnapshot('empty'))).toEqual({ plate: 'olive', word: 'Empty', quiet: true });
  });

  it('Order: the word is the order while it waits, then follows the state', () => {
    const s = mockSnapshot('order');
    const order = s.orders[0] as Order;
    const product = (id: string) => s.products.find((p) => p.id === id);
    const at = (state: Order['state']) => orderMoment({ ...order, state }, product('p-screws'));
    expect(at('awaiting_approval')).toEqual({ plate: 'paper', word: '8 boxes' });
    expect(at('approved')).toEqual({ plate: 'wine', word: 'Placing' });
    expect(at('placing')).toEqual({ plate: 'wine', word: 'Placing' });
    expect(at('placed')).toEqual({ plate: 'olive', word: 'Ordered' });
    expect(at('shipped')).toEqual({ plate: 'olive', word: 'Ordered' });
    expect(at('failed')).toEqual({ plate: 'wine', word: 'Stopped' });
    expect(at('cancelled')).toEqual({ plate: 'paper', word: 'Cancelled' });
    expect(orderMoment({ ...order, units: 3 }, product('p-brackets')).word).toBe('3 bags');
    expect(orderMoment({ ...order, units: 2 }, product('p-glue')).word).toBe('2 units');
    expect(orderMoment({ ...order, units: 1 }, product('p-discs')).word).toBe('1 pack');
  });

  it('writes each part row the way the mockups do', () => {
    const rows = partRows(mockSnapshot('shelf'));
    expect(rows.map((r) => r.meta)).toEqual(['11 days of cover', '4 weeks of cover', '6 weeks of cover', '5 weeks of cover']);
    expect(partRows(mockSnapshot('low'))[0]).toMatchObject({ low: true, meta: 'At the reorder point · 7 days of cover' });
    expect(partRows(mockSnapshot('ontheway'))[0]).toMatchObject({ low: false, onTheWay: true, meta: '8 boxes on the way · arrives Tuesday' });
    expect(partRows(mockSnapshot('order'))[0]?.meta).toBe('Ordering 8 boxes');
    // A delivery that is partly in: the row says how much, and the Shelf still says it is on the way.
    const arriving = mockSnapshot('ontheway');
    const coming = arriving.orders.find((o) => o.productId === 'p-screws');
    if (coming) coming.unitsReceived = 5;
    arriving.counts = arriving.counts.map((c) => (c.productId === 'p-screws' ? { ...c, count: 9 } : c));
    expect(partRows(arriving)[0]).toMatchObject({ low: false, onTheWay: true, meta: '5 of 8 in' });
    expect(shelfMoment(arriving).word).toBe('On the way');
    // A part that was only just taught has no use yet: counted, never low, even at zero.
    const taught = mockSnapshot('shelf');
    taught.products.push({ ...taught.products[0]!, id: 'p-tape', name: 'Masking tape', zoneId: 'z-teach', capacity: null });
    taught.counts.push({ ...taught.counts[0]!, productId: 'p-tape', zoneId: 'z-teach', count: 0, pockets: null });
    taught.policies.push({ ...taught.policies[0]!, productId: 'p-tape', ratePerDay: 0, reorderPoint: 0, daysOfCover: null });
    expect(partRows(taught).at(-1)).toMatchObject({ low: false, meta: 'Counting · not in use yet' });
    expect(shelfMoment(taught).word).toBe('Stocked');
  });

  it('formats times in Toronto', () => {
    expect(clock('2026-11-21T09:14:03-05:00')).toBe('Sat 9:14 AM');
    expect(shortTime('2026-11-21T14:14:03Z')).toBe('9:14');
    expect(duration({ startedAt: '2026-11-21T09:14:08-05:00', finishedAt: '2026-11-21T09:14:40-05:00' } as never, '')).toBe('32 s');
    expect(duration({ startedAt: '2026-11-21T09:14:00-05:00', finishedAt: null } as never, '2026-11-21T09:15:05-05:00')).toBe('1 min 5 s');
  });
});

describe('the word', () => {
  it('is sized to span the plate, between 260 and 540', () => {
    expect(wordSize(1864)).toBe(400);
    expect(wordSize(900)).toBe(540);
    expect(wordSize(4000)).toBe(260);
    expect(wordSize(0)).toBe(480);
    expect(bandWordSize(280, 390)).toBe(26.4);
    expect(bandWordSize(100, 390)).toBe(34);
  });

  it('sits higher at the bottom when it has letters that hang below the line', () => {
    render(<><Word text="Stocked" /><Word text="On the way" /><Word text="New part" at="top" /></>);
    expect(screen.getByText('Stocked').className).toBe('word bottom');
    expect(screen.getByText('On the way').className).toBe('word bottom tails');
    expect(screen.getByText('New part').className).toBe('word top');
  });

  it('splits a part name into two label lines', () => {
    expect(labelLines('Wood screws #8 x 1-1/4 in')).toEqual(['WOOD SCREWS', '#8 X 1-1/4 IN']);
    expect(labelLines('Wood glue 473 mL')).toEqual(['WOOD GLUE', '473 ML']);
    expect(labelLines('Painter tape')).toEqual(['PAINTER TAPE', '']);
  });
});

describe('Units', () => {
  it('draws one square per unit of capacity, hollow where one was taken', () => {
    const { container } = render(<Units count={4} capacity={12} />);
    expect(container.querySelectorAll('.units > i')).toHaveLength(12);
    expect(container.querySelectorAll('.units > i.gone')).toHaveLength(8);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('4 of 12 in stock');
  });

  it('draws what is there when there is no capacity, and nothing for zero', () => {
    expect(render(<Units count={3} capacity={null} />).container.querySelectorAll('.units > i')).toHaveLength(3);
    expect(render(<Units count={0} capacity={null} />).container.querySelector('.units')).toBeNull();
  });
});

describe('zones', () => {
  const zone: Zone = { id: 'z-1', name: 'A', kind: 'pockets', camera: 'board', quad: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.4], [0.1, 0.4]], rows: 2, cols: 3, productId: null };

  it('turns a quad into a box in percent', () => {
    expect(zoneBox(zone.quad)).toEqual({ left: '10%', top: '10%', width: '40%', height: '30%' });
  });

  it('dragging a corner updates the quad and clamps to 0..1', () => {
    expect(moveCorner([zone], 'z-1', 2, 0.62, 0.55)[0]?.quad[2]).toEqual([0.62, 0.55]);
    expect(moveCorner([zone], 'z-1', 0, -0.3, 1.7)[0]?.quad[0]).toEqual([0, 1]);
    expect(moveCorner([zone], 'other', 0, 0.9, 0.9)[0]).toBe(zone);
  });

  it('the total says when it carries shipping', () => {
    expect(totalLabel({ total: 67.71, unitPrice: 7.49, units: 8 })).toBe('Total with tax');
    expect(totalLabel({ total: 19.65, unitPrice: 4.29, units: 2 })).toBe('Total with tax and shipping');
    expect(totalLabel({ total: null, unitPrice: null, units: 2 })).toBe('Total with tax');
  });

  it('moving a zone keeps its shape and stops at the edge', () => {
    const moved = moveZone([zone], 'z-1', 0.9, -0.5)[0] as Zone;
    expect(moved.quad).toEqual([[0.6, 0], [1, 0], [1, 0.3], [0.6, 0.3]]);
  });

  it('adds a zone with a fresh id, and only pocket zones keep a grid', () => {
    const zones = addZone([zone]);
    expect(zones[1]).toMatchObject({ id: 'z-2', kind: 'open', rows: null });
    expect(patchZone(zones, 'z-2', { kind: 'pockets' })[1]).toMatchObject({ rows: 2, cols: 3 });
    expect(patchZone([zone], 'z-1', { kind: 'bin' })[0]).toMatchObject({ rows: null, cols: null });
  });
});
