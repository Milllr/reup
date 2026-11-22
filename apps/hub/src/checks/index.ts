// Count checks: a drop far bigger than normal use, all at once, is more likely a misread than a real take.
// reup holds the order and asks a person to look. The orders folder decides when to raise one and what an answer does.
import { unitsText } from '@reup/brain';
import type { CountCheck, CountSource } from '@reup/contracts';
import type { RoomCore } from '../core/room';

/** A drop smaller than this is never held: a judge may take two boxes, or a handful, and that must shop at once. */
export const MIN_UNUSUAL_DROP = 5;
/** A drop is unusual when it is more than this many days of normal use. */
export const UNUSUAL_DAYS = 3;

const perDay = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

/** Normal use per day after the season factor. */
export function usualPerDay(room: RoomCore, productId: string): number {
  const policy = room.policy(productId);
  return policy ? policy.ratePerDay * policy.seasonFactor : 0;
}

/** True when a drop from a camera is too big to trust without a look. Manual and seed counts are a person, so they are never held. */
export function unusualDrop(room: RoomCore, productId: string, before: number, after: number, source: CountSource | null): boolean {
  if (source !== 'eye' && source !== 'node') return false;
  const drop = before - after;
  return drop >= MIN_UNUSUAL_DROP && drop > UNUSUAL_DAYS * usualPerDay(room, productId);
}

export function checks(room: RoomCore): CountCheck[] {
  return room.s.checks ?? [];
}

export function openCheckFor(room: RoomCore, productId: string): CountCheck | undefined {
  return checks(room).find((c) => c.productId === productId);
}

function publish(room: RoomCore, list: CountCheck[]): void {
  room.s.checks = list;
  room.emit({ type: 'checks', checks: list });
}

export function raiseCheck(room: RoomCore, productId: string, zoneId: string, before: number, after: number): CountCheck | null {
  const product = room.product(productId);
  if (!product) return null;
  const name = room.zone(product.zoneId)?.name ?? product.name;
  const usual = usualPerDay(room, productId);
  const check: CountCheck = {
    id: room.id('ck'),
    productId,
    zoneId,
    before,
    after,
    usualPerDay: Math.round(usual * 100) / 100,
    text: `${unitsText(before - after, product.unit)} of ${name.toLowerCase()} gone at once. Usually about ${perDay(usual)} a day. Holding the order until someone looks.`,
    ts: room.iso(),
  };
  publish(room, [...checks(room), check]);
  room.activity('attention', check.text);
  return check;
}

export function closeCheck(room: RoomCore, id: string): CountCheck | undefined {
  const check = checks(room).find((c) => c.id === id);
  if (check) publish(room, checks(room).filter((c) => c.id !== id));
  return check;
}

/** Reset: every check goes. */
export function clearChecks(room: RoomCore): void {
  if (checks(room).length > 0) publish(room, []);
  else room.s.checks = [];
}
