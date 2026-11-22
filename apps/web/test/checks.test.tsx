import { CountCheck, ServerMessage } from '@reup/contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import check from '../../../contracts/mocks/count-check.json';
import { shelfMoment } from '../src/lib/view';
import { CheckBand, NO_KEY } from '../src/screens/phone';
import { zoneTag } from '../src/screens/shelf';
import { mockSnapshot } from '../src/store/mock';
import { apply, initial } from '../src/store/reduce';
import { partRows } from '../src/lib/view';

const ck = CountCheck.parse(check);
const ok = { ok: true, status: 200, data: { ok: true }, message: null };

describe('count checks on the screens', () => {
  it('the checks message replaces the open checks', () => {
    const state = { ...initial, snapshot: mockSnapshot('shelf') };
    const msg = ServerMessage.parse({ type: 'checks', checks: [ck] });
    const next = apply(state, msg);
    expect(next.snapshot?.checks).toEqual([ck]);
    expect(apply(next, ServerMessage.parse({ type: 'checks', checks: [] })).snapshot?.checks).toEqual([]);
  });

  it('the Shelf says Check while one is open, and the zone tag says so', () => {
    const s = { ...mockSnapshot('shelf'), checks: [ck] };
    expect(shelfMoment(s)).toEqual({ plate: 'wine', word: 'Check' });
    const zone = s.zones.find((z) => z.id === 'z-screws');
    const row = partRows(s).find((r) => r.product.id === 'p-screws');
    if (!zone) throw new Error('no zone');
    expect(zoneTag(zone, row, true)).toMatch(/ · check$/);
    expect(zoneTag(zone, row, false)).not.toMatch(/check/);
  });

  it('the phone answers right or miscount with the key', async () => {
    const s = mockSnapshot('shelf');
    const send = vi.fn(async () => ok);
    render(<CheckBand check={ck} s={s} send={send as never} k="key-1" />);
    expect(screen.getByText(ck.text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'That is right' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('POST', `/api/checks/${ck.id}`, { answer: 'right' }, 'key-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Miscount' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('POST', `/api/checks/${ck.id}`, { answer: 'miscount' }, 'key-1'));
  });

  it('says this phone cannot answer when it has no key, without calling the hub', () => {
    const send = vi.fn();
    render(<CheckBand check={ck} s={mockSnapshot('shelf')} send={send as never} k={null} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'That is right' }).at(-1) as HTMLElement);
    expect(screen.getByText(NO_KEY)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });
});
