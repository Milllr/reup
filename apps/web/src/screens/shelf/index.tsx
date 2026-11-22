/** Shelf: the live board in the frame, a selection per part, the index of counts, one sentence. */
import type { Count, Snapshot, Zone as ZoneT } from '@reup/contracts';
import { useEffect, useState } from 'react';
import { cx, Frame, Plate, Tag, Word } from '../../components';
import { clock, partRows, shelfMoment, zoneBox, type Moment, type PartRow } from '../../lib/view';
import type { LiveState } from '../../store/reduce';
import { alertText, PartLine, TopBar } from '../common';
import { LEDGES_HINT, LEDGES_SAVE, type LedgeEdit, useLedges } from './ledges';

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

/** "Hex bolts  3 of 3": the name, a wide gap, the count. The gap is two spaces that a browser does not fold into one. */
const GAP = '\u00a0\u00a0';
export function zoneTag(zone: ZoneT, row: PartRow | undefined, checking = false): string {
  if (!row) return zone.name;
  return `${zone.name}${GAP}${row.count}${row.capacity != null ? ` of ${row.capacity}` : ''}${checking ? `${GAP}check` : ''}`;
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

/** ledges: the boxes are being moved on this screen. note: one line about what the menu just did, shown where an alert goes. */
export function Shelf({ live, moment: forced, ledges, note }: { live: LiveState; moment?: Moment; ledges?: LedgeEdit; note?: string | null }) {
  const s = live.snapshot as Snapshot;
  const rows = partRows(s).slice(0, 6);
  const moment = forced ?? shelfMoment(s);
  const board = s.cameras.find((c) => c.id === 'board');
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showFeed = !live.mock && board != null && board.online && board.streamUrl != null && failedUrl !== board.streamUrl;
  const outlines = useOutlines(board?.streamUrl ?? null, showFeed);
  const alert = alertText(live) ?? note ?? (!live.mock && !showFeed && s.products.length > 0 ? NO_FEED : null);
  // The tag is there when the shelf node on QNX does the counting. The eye counting is the plain case and gets no tag.
  const credit = s.node.online && s.node.level >= 2 ? 'Counted by the shelf node on QNX' : null;
  const edit = useLedges(s, ledges, live.mock);
  const zones = edit.zones.filter((z) => z.camera === 'board');

  return (
    <Plate tone={moment.plate} label="Shelf">
      <TopBar credit={credit} alert={alert} meta={clock(s.now)} />

      <Frame settle label="Live parts board" style={{ left: 96, top: 118, width: 1150, height: 662 }} waiting={s.products.length === 0}>
        <div className="fill mat feed" ref={edit.box} onPointerMove={edit.on ? edit.move : undefined} onPointerUp={edit.on ? edit.up : undefined} onPointerLeave={edit.on ? edit.up : undefined}>
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
              <div key={zone.id} className={cx('zone', (row?.low || checking) && 'low', reaching && 'reach', edit.on && 'editing quad')} style={zoneBox(zone.quad)} onPointerDown={edit.on ? (e) => edit.down(e, zone.id, null) : undefined}>
                {edit.on ? null : <><i className="h tl" /><i className="h tr" /><i className="h bl" /><i className="h br" /></>}
                <Tag tone={row?.low || checking ? 'alert' : 'cream'}>{zoneTag(zone, row, checking)}</Tag>
                {showFeed ? null : <ZoneDrawing zone={zone} count={s.counts.find((c) => c.zoneId === zone.id)} />}
              </div>
            );
          })}
          {edit.on ? (
            <svg className="outlines" viewBox="0 0 1 1" preserveAspectRatio="none" style={{ pointerEvents: 'none' }} aria-hidden="true">
              {zones.map((z) => <polygon key={z.id} className="outline ledge" points={z.quad.map((p) => p.join(',')).join(' ')} />)}
            </svg>
          ) : null}
          {edit.on ? zones.flatMap((z) => z.quad.map((p, i) => (
            <i key={`${z.id}-${i}`} className="corner" role="slider" tabIndex={0} aria-label={`Corner ${i + 1} of ${z.name}`} aria-valuenow={Math.round(p[0] * 100)}
              style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }} onPointerDown={(e) => edit.down(e, z.id, i)} />
          ))) : null}
        </div>
      </Frame>

      <section className={cx('abs stack index', rows.length > 4 && 'dense')} style={{ left: 1326, top: 122, width: 560, gap: rows.length > 4 ? 16 : 26 }} aria-label="Parts">
        {rows.map((row) => <PartLine key={row.product.id} row={row} />)}
        {edit.on && ledges ? (
          <>
            <p className="copy" style={{ marginTop: 14 }}>{LEDGES_HINT}</p>
            <div className="wrap" style={{ gap: 16 }}>
              <button type="button" className="btn" disabled={edit.busy} onClick={() => void edit.save()}>{LEDGES_SAVE}</button>
              <button type="button" className="btn quiet" onClick={ledges.done}>Cancel</button>
            </div>
            {edit.note ? <p className="copy small" role="alert">{edit.note}</p> : null}
          </>
        ) : <p className="copy" style={{ marginTop: 14 }}>{sentence(s)}</p>}
      </section>

      <Word text={moment.word} quiet={moment.quiet || (!live.connected && !live.mock)} />
    </Plate>
  );
}
