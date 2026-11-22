/** Shelf: the live board in the frame, a selection per part, the index of counts, one sentence. */
import type { Count, Snapshot, Zone as ZoneT } from '@reup/contracts';
import { useEffect, useRef, useState } from 'react';
import { cx, Frame, Plate, Tag, Word } from '../../components';
import { clock, partRows, shelfMoment, zoneBox, type Moment, type PartRow } from '../../lib/view';
import type { LiveState } from '../../store/reduce';
import { alertText, PartLine, TopBar } from '../common';
import { LEDGES_HINT, LEDGES_SAVE, type LedgeEdit, useLedges } from './ledges';

export const WATCHING = 'Watching the board. Every part is above its reorder point.';
export const NO_PARTS = 'No parts yet. Put one on the teach spot.';
export const NO_FEED = 'Camera feed unavailable. Showing counts.';

/** zoneId is there when the part sits in another part's box: the box it is in. */
export interface Outline { productId: string | null; points: [number, number][]; zoneId?: string | null }

/**
 * One line for a part that sits in another part's box, or null when every part is at home.
 * "1 from hex bolts is in the washers box. Not counted."
 */
export function wrongBox(s: Snapshot, outlines: readonly Outline[]): string | null {
  const first = outlines.find((o) => o.zoneId && o.productId);
  if (!first) return null;
  const part = s.products.find((p) => p.id === first.productId);
  const there = s.zones.find((z) => z.id === first.zoneId);
  if (!part || !there) return null;
  const home = s.zones.find((z) => z.id === part.zoneId && z.productId === part.id);
  const n = outlines.filter((o) => o.zoneId === first.zoneId && o.productId === first.productId).length;
  return `${n} from ${(home?.name ?? part.name).toLowerCase()} ${n === 1 ? 'is' : 'are'} in the ${there.name.toLowerCase()} box. Not counted.`;
}

/** How long a picture that would not load is left alone before it is tried again, while the eye answers. */
export const FEED_RETRY_MS = 3000;

/**
 * The eye serves item outlines next to its stream, and the same poll says whether the eye is there at all.
 * The outlines are a nicety: any failure just means none are drawn.
 *
 * turn counts the times the picture has to be opened again: the eye was gone and is back, or the picture would not
 * load (failed) and the eye has answered for a few seconds since. A stream that has ended keeps its last frame and
 * says nothing, and one that failed to load was never tried again, so the board sat on a stale or missing picture
 * until someone reloaded the page.
 */
export function useEye(streamUrl: string | null, on: boolean, failed: boolean, fetcher: typeof fetch = fetch): { outlines: Outline[]; turn: number } {
  const [items, setItems] = useState<Outline[]>([]);
  const [turn, setTurn] = useState(0);
  const failedRef = useRef(failed);
  failedRef.current = failed;
  useEffect(() => {
    if (!on || !streamUrl) return setItems([]);
    let stop = false;
    let away = false;
    let failedSince: number | null = null;
    const url = streamUrl.replace(/\/stream\/(\w+)\.mjpg.*$/, '/outlines/$1.json');
    const tick = async () => {
      try {
        const res = await fetcher(url);
        const data = (await res.json()) as { items?: Outline[] };
        if (stop) return;
        if (Array.isArray(data.items)) setItems(data.items);
        const now = Date.now();
        failedSince = failedRef.current ? (failedSince ?? now) : null;
        if (away || (failedSince != null && now - failedSince >= FEED_RETRY_MS)) {
          away = false;
          failedSince = null;
          setTurn((n) => n + 1);
        }
      } catch {
        if (stop) return;
        away = true;
        setItems([]);
      }
    };
    void tick();
    const t = setInterval(tick, 700);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [streamUrl, on, fetcher]);
  return { outlines: items, turn };
}

/** The stream's address for one opening of it. A new address is what makes the browser connect again. */
export const feedUrl = (streamUrl: string, turn: number) => (turn === 0 ? streamUrl : `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}turn=${turn}`);

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

export function shelfCredit(s: Snapshot): string | null {
  if (!s.node.online || s.node.level < 1) return null;
  return s.node.level >= 2 ? 'Counted by the shelf node on QNX' : 'Hands seen by the shelf node on QNX';
}

/** ledges: the boxes are being moved on this screen. note: one line about what the menu just did, shown where an alert goes. */
export function Shelf({ live, moment: forced, ledges, note, eyeFetch }: { live: LiveState; moment?: Moment; ledges?: LedgeEdit; note?: string | null; eyeFetch?: typeof fetch }) {
  const s = live.snapshot as Snapshot;
  const rows = partRows(s).slice(0, 6);
  const moment = forced ?? shelfMoment(s);
  const board = s.cameras.find((c) => c.id === 'board');
  // The opening of the stream that would not load. The eye is asked whenever there is a stream to show, so a picture
  // that failed or went stale is opened again by itself.
  const [failedTurn, setFailedTurn] = useState<number | null>(null);
  const hasStream = !live.mock && board != null && board.streamUrl != null;
  const eye = useEye(board?.streamUrl ?? null, hasStream, failedTurn != null, eyeFetch);
  const failed = failedTurn === eye.turn;
  const showFeed = hasStream && board.online && !failed;
  const outlines = showFeed ? eye.outlines : [];
  useEffect(() => {
    // A new opening: the old failure is not about this one.
    setFailedTurn((t) => (t != null && t !== eye.turn ? null : t));
  }, [eye.turn]);
  const alert = alertText(live) ?? note ?? wrongBox(s, outlines) ?? (!live.mock && !showFeed && s.products.length > 0 ? NO_FEED : null);
  // The tag says what the shelf node on QNX is doing for this board right now: counting it, or watching the hands
  // that reach for it. The eye counting with no node is the plain case and gets no tag.
  const credit = shelfCredit(s);
  const edit = useLedges(s, ledges, live.mock);
  const zones = edit.zones.filter((z) => z.camera === 'board');

  return (
    <Plate tone={moment.plate} label="Shelf">
      <TopBar credit={credit} alert={alert} meta={clock(s.now)} />

      <Frame settle label="Live parts board" style={{ left: 96, top: 118, width: 1150, height: 662 }} waiting={s.products.length === 0}>
        <div className="fill mat feed" ref={edit.box} onPointerMove={edit.on ? edit.move : undefined} onPointerUp={edit.on ? edit.up : undefined} onPointerLeave={edit.on ? edit.up : undefined}>
          {showFeed && board?.streamUrl ? <img key={eye.turn} src={feedUrl(board.streamUrl, eye.turn)} alt="The parts board, live" onError={() => setFailedTurn(eye.turn)} /> : null}
          {showFeed && outlines.length > 0 ? (
            <svg className="outlines" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
              {outlines.map((o, i) => <polygon key={i} className={o.zoneId ? 'outline wrong' : 'outline'} points={o.points.map((p) => p.join(',')).join(' ')} />)}
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
