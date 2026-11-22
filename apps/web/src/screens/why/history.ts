/**
 * A part's 30 days and its forecast, for the Forecast chart. The last one read is kept for each part, and the board
 * reads them all as soon as it has its parts, so the chart is there the moment the screen is opened.
 */
import { HistoryResult } from '@reup/contracts';
import { useEffect, useState } from 'react';
import { call } from '../../lib/hub';

export const HISTORY_WAIT = 'Reading 30 days of counts.';
export const HISTORY_RETRY = 'The hub did not answer. Asking again.';
const RETRY_MS = 2000;

type Send = typeof call;
const kept = new Map<string, HistoryResult>();

/** Reads one part's history from the hub and keeps it. Null when the hub did not answer with one. */
export async function readHistory(productId: string, send: Send = call): Promise<HistoryResult | null> {
  const res = await send<unknown>('GET', `/api/products/${encodeURIComponent(productId)}/history`);
  const parsed = res.ok ? HistoryResult.safeParse(res.data) : null;
  if (!parsed?.success) return null;
  kept.set(productId, parsed.data);
  return parsed.data;
}

/** Reads every part's history ahead of time. Failures are left for the screen to ask again. */
export function prefetchHistory(productIds: readonly string[], send: Send = call): void {
  for (const id of productIds) if (!kept.has(id)) void readHistory(id, send);
}

/** For tests: forget what was kept. */
export const forgetHistory = () => kept.clear();

/**
 * The history to draw. What was kept shows at once and is read again whenever again changes (a count, an order,
 * the season). While the hub does not answer it is asked again every 2 seconds, and failed says so.
 */
export function useHistory(productId: string | undefined, again: string, off: boolean, send: Send = call): { history: HistoryResult | null; failed: boolean } {
  const [history, setHistory] = useState<HistoryResult | null>(() => (productId ? (kept.get(productId) ?? null) : null));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!productId || off) return;
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Another part: show what is kept for it, or the waiting line, never the last part's chart.
    setHistory(kept.get(productId) ?? null);
    const read = async () => {
      const got = await readHistory(productId, send);
      if (stale) return;
      setFailed(got == null);
      if (got) setHistory(got);
      else timer = setTimeout(() => void read(), RETRY_MS);
    };
    void read();
    return () => {
      stale = true;
      if (timer) clearTimeout(timer);
    };
  }, [productId, again, off, send]);
  return { history, failed };
}
