/**
 * Reading a list exported from an inventory system (Zoho Inventory, Cin7 Core, Fishbowl) or any sheet saved as CSV.
 * reup takes four things from it: the name, the unit, what is on hand and what was used. Nothing is written back.
 * The inventory onboarding is where this comes from: bring the shop's own records in, and recommend a reorder point from them.
 */
import { reorderPoint } from '@reup/brain';
import type { CatalogItem, ProductAddBody, Snapshot } from '@reup/contracts';

export const MAX_ROWS = 40;
export const NO_NAME_COLUMN = 'No column with the item names. reup looks for Item Name, Product Name, Name, Description or Part.';
export const EMPTY_FILE = 'That file has no rows under its heading.';
export const ALREADY_HERE = 'Already here';
export const TWICE = 'Twice in the file';

export interface ImportRow {
  name: string;
  unit: string;
  /** The Offcut Supply SKU it is bought as, when the store has it under the same code or the same name. */
  sku: string | null;
  count: number;
  /** Units used a day, or null when the file has no column for use. */
  usePerDay: number | null;
  /** Where reup would reorder, from the use. Null with no use column: the hub sets it from what is on hand, like a part on the board. */
  reorderAt: number | null;
  /** Why this row is left out, or null. */
  skip: string | null;
}

export interface ExportRead {
  rows: ImportRow[];
  /** Why nothing could be read, or null. */
  problem: string | null;
  /** How the use column was read, in words, or null when there is none. */
  use: string | null;
  /** Rows past MAX_ROWS that were not read. */
  left: number;
}

/** CSV as rows of cells. Quoted cells may hold the separator, a line break and "" for a quote. Comma, semicolon or tab. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].map((c) => [c, first.split(c).length] as const).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some((v) => v !== ''));
}

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
// Each list is in the order reup prefers, for a file that has more than one of them.
const NAME = ['itemname', 'productname', 'name', 'product', 'partdescription', 'description', 'part', 'item'];
const SKU = ['sku', 'partnumber', 'partnum', 'productcode', 'itemcode', 'code', 'num'];
const ON_HAND = ['stockonhand', 'quantityonhand', 'qtyonhand', 'onhand', 'quantityavailable', 'qtyavailable', 'availablestock', 'available', 'stock', 'quantity', 'qty'];
const UNIT = ['usageunit', 'unit', 'uom', 'unitofmeasure', 'defaultunitofmeasure'];

const find = (heads: string[], names: string[]) => names.map((n) => heads.indexOf(n)).find((i) => i >= 0) ?? -1;
const amount = (v: string | undefined) => {
  const n = Number((v ?? '').replace(/[,\s]/g, ''));
  return (v ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
};
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The column that says how much was used or sold, and over how many days its heading says. A bare "Quantity Sold" is read as 30 days. */
export function useColumn(headings: string[]): { index: number; days: number; heading: string } | null {
  const index = headings.findIndex((h) => {
    const k = key(h);
    return /(sold|usage|used|consumed|demand|issued)/.test(k) && !/(unit|price|rate|cost|value|amount)/.test(k);
  });
  if (index < 0) return null;
  const k = key(headings[index] ?? '');
  const days = /(perday|daily|aday)/.test(k) ? 1 : /(week|7d)/.test(k) ? 7 : /90/.test(k) ? 90 : /(year|annual|365|12m)/.test(k) ? 365 : 30;
  return { index, days, heading: headings[index] ?? '' };
}

const period = (days: number) => (days === 1 ? 'units a day' : days === 7 ? 'units in a week' : days === 365 ? 'units in a year' : `units in ${days} days`);

/** The rows of an export as items reup could add, with the reorder point each one's use gives. */
export function readExport(text: string, s: Snapshot, catalog: readonly CatalogItem[]): ExportRead {
  const [headings, ...lines] = parseCsv(text);
  const none = { rows: [], use: null, left: 0 };
  if (!headings || lines.length === 0) return { ...none, problem: EMPTY_FILE };
  const heads = headings.map(key);
  const [iName, iSku, iOnHand, iUnit] = [find(heads, NAME), find(heads, SKU), find(heads, ON_HAND), find(heads, UNIT)];
  if (iName < 0) return { ...none, problem: NO_NAME_COLUMN };
  const use = useColumn(headings);
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  for (const line of lines.slice(0, MAX_ROWS)) {
    const name = (line[iName] ?? '').slice(0, 80).trim();
    if (name === '') continue;
    const theirs = iSku >= 0 ? (line[iSku] ?? '') : '';
    const match = catalog.find((i) => theirs !== '' && same(i.sku, theirs)) ?? catalog.find((i) => same(i.name, name));
    const count = Math.min(9999, Math.max(0, Math.round(amount(line[iOnHand]) ?? 0)));
    const used = use ? amount(line[use.index]) : null;
    const usePerDay = use ? Math.min(999, Math.round((Math.max(0, used ?? 0) / use.days) * 1000) / 1000) : null;
    const id = name.toLowerCase();
    const skip = s.products.some((p) => same(p.name, name)) ? ALREADY_HERE : seen.has(id) ? TWICE : null;
    seen.add(id);
    rows.push({
      name,
      unit: ((iUnit >= 0 ? line[iUnit] : '') || match?.unit || 'each').slice(0, 40),
      sku: match?.sku ?? null,
      count,
      usePerDay,
      // The same line the hub draws: the store's delivery time, the season, and never at or over what the shelf holds.
      reorderAt: usePerDay == null ? null : reorderPoint(usePerDay * s.season.factor, match?.leadDays ?? 2, undefined, undefined, count > 0 ? count : null),
      skip,
    });
  }
  if (rows.length === 0) return { ...none, problem: EMPTY_FILE };
  return { rows, problem: null, use: use ? `"${use.heading}" is read as ${period(use.days)}.` : null, left: Math.max(0, lines.length - MAX_ROWS) };
}

/** What the hub is sent for one row. */
export function rowBody(row: ImportRow): ProductAddBody {
  return { name: row.name, unit: row.unit, sku: row.sku, zoneId: null, count: row.count, ...(row.usePerDay != null ? { usePerDay: row.usePerDay } : {}) };
}
