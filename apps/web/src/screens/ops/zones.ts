// Zone editing as pure functions: the page only turns pointer moves into calls here.
import type { Point, Zone } from '@reup/contracts';

const clamp = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;

/** Moves one corner of one zone. Points stay inside the frame. */
export function moveCorner(zones: readonly Zone[], zoneId: string, corner: number, x: number, y: number): Zone[] {
  return zones.map((z) => (z.id !== zoneId ? z : { ...z, quad: z.quad.map((p, i) => (i === corner ? ([clamp(x), clamp(y)] as Point) : p)) }));
}

/** Moves a whole zone by a delta, stopping at the frame's edges so its shape is kept. */
export function moveZone(zones: readonly Zone[], zoneId: string, dx: number, dy: number): Zone[] {
  return zones.map((z) => {
    if (z.id !== zoneId) return z;
    const xs = z.quad.map((p) => p[0]);
    const ys = z.quad.map((p) => p[1]);
    const mx = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), dx));
    const my = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), dy));
    return { ...z, quad: z.quad.map((p) => [clamp(p[0] + mx), clamp(p[1] + my)] as Point) };
  });
}

export function addZone(zones: readonly Zone[], camera: Zone['camera'] = 'board'): Zone[] {
  let n = zones.length + 1;
  while (zones.some((z) => z.id === `z-${n}`)) n += 1;
  return [...zones, { id: `z-${n}`, name: `Zone ${n}`, kind: 'open', camera, quad: [[0.35, 0.35], [0.65, 0.35], [0.65, 0.65], [0.35, 0.65]], rows: null, cols: null, productId: null }];
}

export function patchZone(zones: readonly Zone[], zoneId: string, patch: Partial<Zone>): Zone[] {
  return zones.map((z) => {
    if (z.id !== zoneId) return z;
    const next = { ...z, ...patch };
    // Only pocket zones have a grid.
    if (next.kind === 'pockets') return { ...next, rows: Math.max(1, next.rows ?? 2), cols: Math.max(1, next.cols ?? 3) };
    return { ...next, rows: null, cols: null };
  });
}
