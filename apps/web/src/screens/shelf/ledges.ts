/** Moving the ledge boxes on the board: a corner is dragged to fit a box to its ledge, the middle moves the whole box. */
import type { Camera, Snapshot, Zone } from '@reup/contracts';
import { type PointerEvent, useEffect, useRef, useState } from 'react';
import { call } from '../../lib/hub';
import { moveCorner, moveZone } from '../ops/zones';

export const LEDGES_HINT = 'Drag a corner to fit a box to its ledge. Drag the middle to move the whole box.';
export const LEDGES_SAVE = 'Save the boxes';
export const EYE_AWAY = 'The eye is not reachable from this screen.';
export const LOOKING = 'Looking at the teach spot.';

export interface LedgeEdit {
  /** The key this screen changes things with. Empty on a hub that takes changes from any screen. */
  k: string;
  /** Leaves the edit, saved or not. */
  done: () => void;
  send?: typeof call;
}

type Drag = { zoneId: string; corner: number | null; x: number; y: number };

const sameQuad = (a: Zone['quad'], b: Zone['quad']) => a.every((p, i) => p[0] === b[i]?.[0] && p[1] === b[i]?.[1]);

/** The boxes as they are being dragged. They start from the hub's and stay this screen's own until saved or dropped. */
export function useLedges(s: Snapshot, edit: LedgeEdit | undefined, mock: boolean) {
  const on = edit != null;
  const [zones, setZones] = useState<Zone[]>(s.zones);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  // Each edit starts from where the hub has the boxes now.
  useEffect(() => {
    if (!on) return;
    setZones(s.zones);
    setNote(null);
    // The hub's zones while the edit is open are not taken: the boxes on screen are the ones being dragged.
  }, [on]);

  useEffect(() => {
    if (!edit) return;
    const onKey = (e: KeyboardEvent) => {
      // With the menu open, Escape shuts the menu and the boxes stay as they are being dragged.
      if (e.key === 'Escape' && !document.querySelector('.menu nav')) edit.done();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [edit]);

  const at = (e: PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } : null;
  };
  const down = (e: PointerEvent, zoneId: string, corner: number | null) => {
    const p = at(e);
    if (!p) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { zoneId, corner, ...p };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    const p = d ? at(e) : null;
    if (!d || !p) return;
    setZones((zs) => (d.corner == null ? moveZone(zs, d.zoneId, p.x - d.x, p.y - d.y) : moveCorner(zs, d.zoneId, d.corner, p.x, p.y)));
    setNote(null);
    drag.current = { ...d, ...p };
  };
  const up = () => {
    drag.current = null;
  };

  const save = async () => {
    if (!edit || busy) return;
    const moved = zones.filter((z) => {
      const was = s.zones.find((o) => o.id === z.id);
      return was != null && !sameQuad(was.quad, z.quad);
    });
    // The sample board has no hub behind it: the boxes go back when the edit is left.
    if (mock || moved.length === 0) return edit.done();
    setBusy(true);
    for (const z of moved) {
      const res = await (edit.send ?? call)('POST', `/api/zones/${z.id}/quad`, { quad: z.quad }, edit.k);
      if (!res.ok) {
        setBusy(false);
        return setNote(res.message ?? 'Could not save the boxes.');
      }
    }
    setBusy(false);
    edit.done();
  };

  return { on, zones: on ? zones : s.zones, note, busy, box, down, move, up, save };
}

/**
 * Asks the eye to name whatever is on the teach spot now, for a part it did not find by itself.
 * Returns the line to show: what the eye is doing, or why it could not.
 */
export async function nameTeachSpot(cameras: readonly Camera[], fetcher: typeof fetch = fetch): Promise<string> {
  const stream = cameras.find((c) => c.streamUrl)?.streamUrl;
  if (!stream) return EYE_AWAY;
  try {
    const res = await fetcher(stream.replace(/\/stream\/(\w+)\.mjpg.*$/, '/teach'), { method: 'POST' });
    if (res.ok) return LOOKING;
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    return body?.message ?? 'The eye could not look at the teach spot.';
  } catch {
    return EYE_AWAY;
  }
}
