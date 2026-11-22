/** Shelf: the live board in the frame, a selection per part, the index of counts, one sentence. */
import type { Count, Snapshot, Zone as ZoneT } from '@reup/contracts';
import { useEffect, useState } from 'react';
import { cx, Frame, Plate, Tag, Word } from '../../components';
import { clock, partRows, shelfMoment, zoneBox, type Moment, type PartRow } from '../../lib/view';
import type { LiveState } from '../../store/reduce';
import { alertText, PartLine, TopBar } from '../common';

export const WATCHING = 'Watching the board. Every part is above its reorder point.';
export const NO_PARTS = 'No parts yet. Put one on the teach spot.';
export const NO_FEED = 'Camera feed unavailable. Showing counts.';

interface Outline { productId: string | null; points: [number, number][] }

/** The eye serves item outlines next to its stream. They are a nicety: any failure just means none are drawn. */
function useOutlines(streamUrl: string | null, on: boolean): Outline[] {
  const [items, setItems] = useState<Outline[]>([]);
  useEffect(() => {
    if (!on || !streamUrl) return setItems([]);
    let stop = false;
    const url = streamUrl.replace(/\/stream\/(\w+)\.mjpg.*$/, '/outlines/$1.json');
    const tick = async () => {
      try {
        const res = await fetch(url);
        const data = (await res.json()) as { items?: Outline[] };
        if (!stop && Array.isArray(data.items)) setItems(data.items);
      } catch {
        if (!stop) setItems([]);
      }
    };
    void tick();
    const t = setInterval(tick, 700);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [streamUrl, on]);
  return items;
}

/** A zone drawn from its count, for when there is no picture: pockets full or empty, loose items as blocks, a bin as a level. */
export function ZoneDrawing({ zone, count }: { zone: ZoneT; count: Count | undefined }) {
  const n = count?.count ?? 0;
  if (zone.kind === 'pockets' && zone.rows != null && zone.cols != null) {
    const total = zone.rows * zone.cols;
    const full = count?.pockets?.length === total ? count.pockets : Array.from({ length: total }, (_, i) => i < n);
    return (
      <div className="pockets" style={{ gridTemplateColumns: `repeat(${zone.cols}, 1fr)`, gridTemplateRows: `repeat(${zone.rows}, 1fr)` }}>
        {full.map((f, i) => <div key={i} className={f ? 'pocket full' : 'pocket'} />)}
      </div>
    );
  }
  if (zone.kind === 'bin') return <div className="level" style={{ height: `${Math.round((count?.level ?? 0) * 100)}%` }} />;
  return <div className="pile">{Array.from({ length: Math.min(n, 12) }, (_, i) => <i key={i} />)}</div>;
}

export function zoneTag(zone: ZoneT, row: PartRow | undefined, checking = false): string {
  if (!row) return zone.name;
  return `${zone.name} · ${row.count}${row.capacity != null ? ` of ${row.capacity}` : ''}${checking ? ' · check' : ''}`;
}

export function sentence(s: Snapshot): string {
  if (s.products.length === 0) return NO_PARTS;
  const recent = s.activity.slice(-2);
  const last = recent.at(-1);
  if (!last) return WATCHING;
  const prev = recent.length > 1 ? recent[0] : undefined;
  const together = prev && Date.parse(last.ts) - Date.parse(prev.ts) < 10_000;
  return together ? `${prev.text} ${last.text}` : last.text;
}

export function Shelf({ live, moment: forced }: { live: LiveState; moment?: Moment }) {
  const s = live.snapshot as Snapshot;
  const rows = partRows(s).slice(0, 6);
  const moment = forced ?? shelfMoment(s);
  const board = s.cameras.find((c) => c.id === 'board');
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showFeed = !live.mock && board != null && board.online && board.streamUrl != null && failedUrl !== board.streamUrl;
  const outlines = useOutlines(board?.streamUrl ?? null, showFeed);
  const alert = alertText(live) ?? (!live.mock && !showFeed && s.products.length > 0 ? NO_FEED : null);
  // The tag is there when the shelf node on QNX does the counting. The eye counting is the plain case and gets no tag.
  const credit = s.node.online && s.node.level >= 2 ? 'Counted by the shelf node on QNX' : null;
  const zones = s.zones.filter((z) => z.camera === 'board');

  return (
    <Plate tone={moment.plate} label="Shelf">
      <TopBar credit={credit} alert={alert} meta={clock(s.now)} />

      <Frame settle label="Live parts board" style={{ left: 96, top: 118, width: 1150, height: 662 }} waiting={s.products.length === 0}>
        <div className="fill mat feed">
          {showFeed && board?.streamUrl ? <img src={board.streamUrl} alt="The parts board, live" onError={() => setFailedUrl(board.streamUrl)} /> : null}
          {showFeed && outlines.length > 0 ? (
            <svg className="outlines" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
              {outlines.map((o, i) => <polygon key={i} className="outline" points={o.points.map((p) => p.join(',')).join(' ')} />)}
            </svg>
          ) : null}
          {zones.map((zone) => {
            const row = rows.find((r) => r.product.id === zone.productId);
            const reaching = live.reaching[zone.id] === true || live.reaching['*'] === true;
            const checking = s.checks?.some((c) => c.zoneId === zone.id) === true;
            return (
              <div key={zone.id} className={cx('zone', (row?.low || checking) && 'low', reaching && 'reach')} style={zoneBox(zone.quad)}>
                <i className="h tl" /><i className="h tr" /><i className="h bl" /><i className="h br" />
                <Tag tone={row?.low || checking ? 'alert' : 'cream'}>{zoneTag(zone, row, checking)}</Tag>
                {showFeed ? null : <ZoneDrawing zone={zone} count={s.counts.find((c) => c.zoneId === zone.id)} />}
              </div>
            );
          })}
        </div>
      </Frame>

      <section className={cx('abs stack index', rows.length > 4 && 'dense')} style={{ left: 1326, top: 122, width: 560, gap: rows.length > 4 ? 16 : 26 }} aria-label="Parts">
        {rows.map((row) => <PartLine key={row.product.id} row={row} />)}
        <p className="copy" style={{ marginTop: 14 }}>{sentence(s)}</p>
      </section>

      <Word text={moment.word} quiet={moment.quiet || (!live.connected && !live.mock)} />
    </Plate>
  );
}
