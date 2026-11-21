/** Pieces more than one TV screen uses. */
import { unitsText } from '@reup/brain';
import type { Run } from '@reup/contracts';
import { useEffect, useState, type CSSProperties } from 'react';
import { Tag, Units, Wordmark } from '../components';
import { shortTime, type PartRow } from '../lib/view';
import type { LiveState } from '../store/reduce';

/** The one thing wrong that the screen should say, most important first. Null when all is well. */
export function alertText(live: LiveState): string | null {
  const s = live.snapshot;
  if (!s) return null;
  if (!live.connected && !live.mock) return `Hub unreachable. Showing the last counts from ${shortTime(live.syncedAt ?? s.now)}.`;
  if (s.node.level > 0 && !s.node.online) return 'Shelf node offline.';
  return null;
}

/** Olive and wine plates: wordmark top left, one tag top centre (the credit, or an alert in its place), a meta line top right. */
export function TopBar({ credit, alert, meta }: { credit: string; alert: string | null; meta?: string }) {
  return (
    <>
      <Wordmark className="abs" style={{ left: 48, top: 40 }} />
      <Tag center tone={alert ? 'alert' : undefined} style={{ top: 42 }}>{alert ?? credit}</Tag>
      {meta ? <span className="meta abs" style={{ right: 48, top: 52 }}>{meta}</span> : null}
    </>
  );
}

/** Paper plates: wordmark bottom left, one tag bottom right. */
export function BottomBar({ credit, alert }: { credit: string | null; alert: string | null }) {
  const text = alert ?? credit;
  return (
    <>
      <Wordmark className="abs" style={{ left: 48, bottom: 40 }} />
      {text ? <Tag className="abs" tone={alert ? 'alert' : undefined} style={{ right: 48, bottom: 44 }}>{text}</Tag> : null}
    </>
  );
}

/** A part as type on the plate: its count, its name, its squares, one mono line. */
export function PartLine({ row, meta, style }: { row: PartRow; meta?: string; style?: CSSProperties }) {
  return (
    <div className="row" style={style}>
      <span className={row.low ? 'figure low' : 'figure'}>{row.count}</span>
      <div className="stack" style={{ gap: 8, paddingBottom: 4 }}>
        <span className="name">{row.product.name}</span>
        <Units count={row.count} capacity={row.capacity} />
        <span className="meta">{meta ?? row.meta}</span>
      </div>
    </div>
  );
}

/** What a browser pane shows once there is no live picture: the agent's last steps, as a log. */
export function Steps({ run, empty }: { run: Run | undefined; empty: string }) {
  const steps = run?.steps.slice(-6) ?? [];
  return (
    <div className="fill mat pane">
      {steps.length === 0 ? <span className="meta">{empty}</span> : steps.map((s, i) => <span className="meta" key={i}>{s.purpose}</span>)}
    </div>
  );
}

/** Re-renders when a moment in the future arrives. */
export function useUntil(untilMs: number): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const left = untilMs - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => bump((n) => n + 1), left + 20);
    return () => clearTimeout(t);
  }, [untilMs]);
  return untilMs > Date.now();
}

export const ordering = (units: number, unit: string) => `Ordering ${unitsText(units, unit)}`;
