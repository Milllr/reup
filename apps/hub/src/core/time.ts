// Time helpers. The hub runs in UTC; people read local days and local weekday names.

/** ISO 8601 with the zone's offset, for example 2026-11-21T09:14:03-05:00. */
export function isoIn(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const offset = get('timeZoneName').replace('GMT', '') || '+00:00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset === '' ? '+00:00' : offset}`;
}

/** The local calendar day, YYYY-MM-DD. */
export function dayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Move a YYYY-MM-DD day by whole days. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The n days before the given day, oldest first. */
export function daysBefore(day: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(day, i - n));
}

export function weekdayIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, weekday: 'long' }).format(new Date(iso));
}

/** Calendar days from now, skipping Saturday and Sunday, at 5 PM local. Used for a delivery date. */
export function businessDaysFrom(now: Date, days: number, timeZone: string): Date {
  const d = new Date(now.getTime());
  let left = Math.max(0, Math.round(days));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(d);
    if (wd !== 'Sat' && wd !== 'Sun') left--;
  }
  return d;
}
