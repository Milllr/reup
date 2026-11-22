/**
 * Where a new part sits: the board's picture with every box on it. The new part has a box of its own, in orange,
 * that is dragged to where the part will live. Every other box can be fitted here too, to make room for it.
 */
import type { CameraId, Point, Snapshot, TeachState, Zone } from '@reup/contracts';
import { type CSSProperties, type PointerEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { cx, Frame, Tag } from '../../components';
import { zoneBox } from '../../lib/view';
import type { LiveState } from '../../store/reduce';
import { moveCorner, moveZone } from '../ops/zones';
import { feedUrl, useEye, ZoneDrawing } from '../shelf';

type Quad = Zone['quad'];

/** The new part's box, before it is anyone's zone. */
export const FRESH = 'new-part';
export const WHERE = 'Where it sits';
/** Where the new box starts when the hub has no teach spot to start it on. */
export const START: Quad = [[0.4, 0.35], [0.6, 0.35], [0.6, 0.65], [0.4, 0.65]];

/** What Confirm does with the boxes: the ones to save first, then the zone the part takes, or the new box it gets. */
export interface Place {
  moved: { id: string; quad: Quad }[];
  zoneId: string;
  quad?: Quad;
}

const same = (a: Quad, b: Quad) => a.length === b.length && a.every((p, i) => p[0] === b[i]?.[0] && p[1] === b[i]?.[1]);

/** The middle of a box. */
export function centre(quad: readonly Point[]): Point {
  return [quad.reduce((sum, p) => sum + p[0], 0) / quad.length, quad.reduce((sum, p) => sum + p[1], 0) / quad.length];
}

/** True when a point is inside a four cornered box, whichever way round its corners run. */
export function inside(quad: readonly Point[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < quad.length; i += 1) {
    const [ax, ay] = quad[i] as Point;
    const [bx, by] = quad[(i + 1) % quad.length] as Point;
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross === 0) continue;
    if (sign !== 0 && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

/**
 * What the boxes come to. The new box still on the teach spot: the part takes the teach spot's zone, as it always
 * has, and the spot takes the new box's corners when they were dragged. The new box anywhere else: the part gets a
 * zone of its own there, and the teach spot stays free for the next part.
 */
export function placeFor(s: Snapshot, teach: TeachState, local: Record<string, Quad>): Place {
  const spot = s.zones.find((z) => z.id === teach.zoneId);
  const fresh = local[FRESH] ?? spot?.quad ?? START;
  const onSpot = spot != null && inside(fresh, ...centre(spot.quad));
  const moved = s.zones.flatMap((z) => {
    const quad = local[z.id];
    return quad && !same(quad, z.quad) && !(onSpot && z.id === spot.id) ? [{ id: z.id, quad }] : [];
  });
  if (onSpot) return { moved: same(fresh, spot.quad) ? moved : [...moved, { id: spot.id, quad: fresh }], zoneId: spot.id };
  return { moved, zoneId: spot?.id ?? s.zones[0]?.id ?? 'z-new', quad: fresh };
}

export interface Boxes {
  camera: CameraId;
  /** The station's boxes as they are shown: the hub's, with what was dragged here. Not the teach spot while the new box is on it. */
  zones: Zone[];
  fresh: Zone;
  box: RefObject<HTMLDivElement | null>;
  down: (e: PointerEvent, id: string, corner: number | null) => void;
  move: (e: PointerEvent) => void;
  up: () => void;
  place: () => Place;
}

/** The boxes while a new part waits for its yes. Nothing is saved until Confirm. */
export function useBoxes(s: Snapshot, teach: TeachState): Boxes {
  const [local, setLocal] = useState<Record<string, Quad>>({});
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; corner: number | null; x: number; y: number } | null>(null);
  const spot = s.zones.find((z) => z.id === teach.zoneId);
  const camera: CameraId = spot?.camera ?? 'board';
  const fresh: Zone = { id: FRESH, name: 'New part', kind: 'open', camera, quad: local[FRESH] ?? spot?.quad ?? START, rows: null, cols: null, productId: null };
  const onSpot = spot != null && inside(fresh.quad, ...centre(spot.quad));
  const zones = s.zones.filter((z) => z.camera === camera && !(onSpot && z.id === spot.id)).map((z) => ({ ...z, quad: local[z.id] ?? z.quad }));

  const at = (e: PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } : null;
  };
  const down = (e: PointerEvent, id: string, corner: number | null) => {
    const p = at(e);
    if (!p) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id, corner, ...p };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    const p = d ? at(e) : null;
    if (!d || !p) return;
    const now = [...zones, fresh].find((z) => z.id === d.id);
    if (!now) return;
    const next = (d.corner == null ? moveZone([now], d.id, p.x - d.x, p.y - d.y) : moveCorner([now], d.id, d.corner, p.x, p.y))[0];
    if (next) setLocal((l) => ({ ...l, [d.id]: next.quad }));
    drag.current = { ...d, ...p };
  };
  const up = () => {
    drag.current = null;
  };

  return { camera, zones, fresh, box, down, move, up, place: () => placeFor(s, teach, local) };
}

/** The frame: the board's picture, live when the eye is there, with every box and its corners to drag. */
export function BoxMaker({ live, boxes, style, eyeFetch }: { live: LiveState; boxes: Boxes; style: CSSProperties; eyeFetch?: typeof fetch }) {
  const s = live.snapshot as Snapshot;
  const cam = s.cameras.find((c) => c.id === boxes.camera);
  const [failedTurn, setFailedTurn] = useState<number | null>(null);
  const hasStream = !live.mock && cam != null && cam.streamUrl != null;
  const eye = useEye(cam?.streamUrl ?? null, hasStream, failedTurn != null, eyeFetch);
  const showFeed = hasStream && cam.online && failedTurn !== eye.turn;
  useEffect(() => {
    // A new opening of the stream: the old failure is not about this one.
    setFailedTurn((t) => (t != null && t !== eye.turn ? null : t));
  }, [eye.turn]);
  const all = [...boxes.zones, boxes.fresh];

  return (
    <Frame label={WHERE} tag={<Tag>{WHERE}</Tag>} style={style}>
      <div className="fill mat feed boxes" ref={boxes.box} onPointerMove={boxes.move} onPointerUp={boxes.up} onPointerLeave={boxes.up}>
        {showFeed && cam?.streamUrl ? <img key={eye.turn} src={feedUrl(cam.streamUrl, eye.turn)} alt="The parts board, live" draggable={false} onError={() => setFailedTurn(eye.turn)} /> : null}
        {all.map((zone) => {
          const mine = zone.id === FRESH;
          return (
            <div key={zone.id} className={cx('zone editing quad', mine && 'fresh')} style={zoneBox(zone.quad)} onPointerDown={(e) => boxes.down(e, zone.id, null)}>
              <Tag tone={mine ? 'alert' : 'cream'}>{zone.name}</Tag>
              {showFeed || mine ? null : <ZoneDrawing zone={zone} count={s.counts.find((c) => c.zoneId === zone.id)} />}
            </div>
          );
        })}
        <svg className="outlines" viewBox="0 0 1 1" preserveAspectRatio="none" style={{ pointerEvents: 'none' }} aria-hidden="true">
          {all.map((z) => <polygon key={z.id} className={cx('outline ledge', z.id === FRESH ? 'fresh' : 'other')} points={z.quad.map((p) => p.join(',')).join(' ')} />)}
        </svg>
        {all.flatMap((z) => z.quad.map((p, i) => (
          <i key={`${z.id}-${i}`} className={cx('corner', z.id !== FRESH && 'other')} role="slider" tabIndex={0} aria-label={`Corner ${i + 1} of ${z.id === FRESH ? 'the new part' : z.name}`} aria-valuenow={Math.round(p[0] * 100)}
            style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }} onPointerDown={(e) => boxes.down(e, z.id, i)} />
        )))}
      </div>
    </Frame>
  );
}
