// Totals and dates. Money is CAD dollars as a number, rounded to cents at every step a person can see.
export const HST = 0.13;
export const FREE_SHIPPING_AT = 50;
export const SHIPPING = 9.95;

export const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const money = (n: number) => `$${cents(n).toFixed(2)}`;

export interface Totals {
  subtotal: number;
  tax: number;
  shipping: number;
  total: number;
}

export function totals(lines: readonly { price: number; qty: number }[]): Totals {
  const subtotal = cents(lines.reduce((sum, l) => sum + l.price * l.qty, 0));
  const tax = cents(subtotal * HST);
  const shipping = subtotal === 0 || subtotal >= FREE_SHIPPING_AT ? 0 : SHIPPING;
  return { subtotal, tax, shipping, total: cents(subtotal + tax + shipping) };
}

const local = (d: Date, timeZone: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-CA', { timeZone, ...options }).format(d);

/** The day an order placed now arrives: that many business days from today, skipping Saturday and Sunday. YYYY-MM-DD. */
export function deliveryDay(now: Date, businessDays: number, timeZone: string): string {
  const d = new Date(`${local(now, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' })}T12:00:00Z`);
  let left = Math.max(1, Math.round(businessDays));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

/** "Tuesday, Nov 24" */
export function dayText(day: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(`${day}T12:00:00Z`));
}

/** 5 PM local on that day, as ISO 8601 with the zone's offset. This is the eta sent to reup. */
export function etaIso(day: string, timeZone: string): string {
  const probe = new Date(`${day}T22:00:00Z`);
  const offset = new Intl.DateTimeFormat('en-CA', { timeZone, timeZoneName: 'longOffset' }).formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00';
  return `${day}T17:00:00${offset}`;
}
