// Sprite data model: pure operations on sprite objects, no I/O.
//
// Sprite shape:
// {
//   name, width, height,
//   palette: string[]            // hex colors, index 0 = transparent
//   grid: number[][]             // palette indices, [y][x]
//   animations: { [name]: { fps: number, frames: number[][][] } },
//   version: number
// }

import { decodeRow, decodeRuns } from "./rle.js";

export const GRID_SIZES = [16, 24, 32, 48, 64];
export const MAX_PIXELS_PER_OP = 512;

// Ramp-based palette: outline + white + 3-shade ramps per hue family.
// Ramps are adjacent index triples (light, mid, dark) so shading = index ± 1.
export const DEFAULT_PALETTE = [
  "#00000000", // 0 transparent (required)
  "#1a1c2c", // 1 outline / near-black
  "#f4f4f4", // 2 white
  "#94b0c2", // 3 light gray
  "#566c86", // 4 dark gray
  "#ffcd75", // 5 skin light
  "#ef7d57", // 6 skin mid
  "#a15c48", // 7 skin dark
  "#d95763", // 8 red light
  "#b13e53", // 9 red mid
  "#6e2f45", // 10 red dark
  "#e8a13c", // 11 gold light
  "#b57e2e", // 12 gold dark
  "#a7f070", // 13 green light
  "#38b764", // 14 green mid
  "#257179", // 15 green dark / teal
  "#73eff7", // 16 cyan light
  "#41a6f6", // 17 azure
  "#3b5dc9", // 18 blue mid
  "#29366f", // 19 blue dark
  "#a464c2", // 20 purple light
  "#5d275d", // 21 purple dark
  "#8a5a3c", // 22 brown
  "#5c3a2e", // 23 brown dark
];

// Hue/ramp family labels for DEFAULT_PALETTE (index-aligned). Surfaced by
// get_palette so agents can see which indices are shading neighbors and which
// families are distinct — preventing "two props in the same hue" clashes.
export const PALETTE_FAMILIES = [
  "transparent",
  "outline",
  "neutral (white)",
  "neutral (light gray)",
  "neutral (dark gray)",
  "skin light",
  "skin mid",
  "skin dark",
  "red light",
  "red mid",
  "red dark",
  "gold light",
  "gold dark",
  "green light",
  "green mid",
  "green dark",
  "blue lightest (cyan)",
  "blue light",
  "blue mid",
  "blue dark",
  "purple light",
  "purple dark",
  "brown",
  "brown dark",
];

// Shading families of DEFAULT_PALETTE, in palette-index order. Guidance data
// for get_palette on legacy/custom sprites too; it never rewrites sprite JSON.
export const DEFAULT_RAMP_FAMILIES = [
  { name: "neutral", from: 2, to: 4 },
  { name: "skin", from: 5, to: 7 },
  { name: "red", from: 8, to: 10 },
  { name: "gold", from: 11, to: 12 },
  { name: "green", from: 13, to: 15 },
  { name: "blue", from: 16, to: 19 },
  { name: "purple", from: 20, to: 21 },
  { name: "brown", from: 22, to: 23 },
];

export function normalizeHex(hex) {
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex.trim());
  if (!m) throw new Error(`invalid hex color "${hex}", expected #rrggbb or #rrggbbaa`);
  return `#${m[1].toLowerCase()}${m[2] ? m[2].toLowerCase() : ""}`;
}

export function blankGrid(width, height) {
  return Array.from({ length: height }, () => new Array(width).fill(0));
}

export function createSprite(name, width, height) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`invalid sprite name "${name}": letters, digits, - and _ only`);
  }
  if (!GRID_SIZES.includes(width) || !GRID_SIZES.includes(height)) {
    throw new Error(`grid size must be one of ${GRID_SIZES.join("/")} (got ${width}x${height})`);
  }
  return {
    name,
    width,
    height,
    palette: [...DEFAULT_PALETTE],
    outlineIndex: 1,
    grid: blankGrid(width, height),
    animations: {},
    version: 1,
  };
}

/** Resolve which grid an operation targets: base grid or an animation frame. */
export function targetGrid(sprite, frame) {
  if (!frame) return sprite.grid;
  const anim = sprite.animations[frame.anim];
  if (!anim) throw new Error(`no animation "${frame.anim}" on sprite "${sprite.name}"`);
  if (frame.index < 0 || frame.index >= anim.frames.length) {
    throw new Error(`frame index ${frame.index} out of range (animation "${frame.anim}" has ${anim.frames.length} frames)`);
  }
  return anim.frames[frame.index];
}

function checkColor(sprite, color) {
  if (!Number.isInteger(color) || color < 0 || color >= sprite.palette.length) {
    throw new Error(`color index ${color} out of palette range 0..${sprite.palette.length - 1}`);
  }
}

function checkBounds(sprite, x, y) {
  if (x < 0 || x >= sprite.width || y < 0 || y >= sprite.height) {
    throw new Error(`pixel (${x},${y}) out of bounds for ${sprite.width}x${sprite.height} grid`);
  }
}

function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, p) {
  return (
    Math.abs(orient(a, b, p)) < 1e-9 &&
    p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])
  );
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)) return true;
  return false;
}

/** Even-odd point test at integer sample points, including pixels on an edge. */
function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    if (onSegment([xj, yj], [xi, yi], [x, y])) return true;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Apply a list of draw ops to a grid. Mutates `grid`.
 * Ops:
 *   { type: "rows", rows: "<rle>", y?: 0 }   — paste RLE rows starting at row y
 *   { type: "rect", x, y, w, h, color }
 *   { type: "pixels", pixels: [{x, y, color}, ...] }  — max MAX_PIXELS_PER_OP
 *   { type: "clear", color?: 0 }
 *   { type: "outline", color?: 1, diagonals?, scope?: "all"|"new" }  — "new" only wraps pixels added in this call
 *   { type: "curve", x0, y0, cx, cy, x1, y1, color, thickness? }  — quadratic bezier arc
 *   { type: "polygon", points: [[x, y], ...], color }  — filled simple polygon (3..16 on-grid vertices)
 *   { type: "taperedLine", x0, y0, x1, y1, w0, w1, color }  — round-capped capsule with width changing along its length
 *   { type: "litEllipse", cx, cy, rx, ry, ramp: [light, mid, dark], light?: [x, y], hi?, lo?, dither? }
 *   { type: "rampRect", x, y, w, h, ramp: [...], dir?: "v"|"h" }
 */
export function applyOps(sprite, grid, ops) {
  // State at call start, used by outline scope:"new" to tell freshly-added
  // pixels apart from the existing silhouette.
  const preCall = grid.map((r) => [...r]);
  for (const [i, op] of ops.entries()) {
    const where = `op ${i} (${op.type})`;
    switch (op.type) {
      case "rows": {
        const y0 = op.y ?? 0;
        const rows = op.rows.split(";").map((r) => {
          const row = decodeRowSafe(r, sprite.width, where);
          for (const v of row) checkColor(sprite, v);
          return row;
        });
        if (y0 < 0 || y0 + rows.length > sprite.height) {
          throw new Error(`${where}: ${rows.length} rows at y=${y0} exceed grid height ${sprite.height}`);
        }
        rows.forEach((row, dy) => {
          grid[y0 + dy] = row;
        });
        break;
      }
      case "rect": {
        checkColor(sprite, op.color);
        checkBounds(sprite, op.x, op.y);
        checkBounds(sprite, op.x + op.w - 1, op.y + op.h - 1);
        for (let y = op.y; y < op.y + op.h; y++) {
          for (let x = op.x; x < op.x + op.w; x++) grid[y][x] = op.color;
        }
        break;
      }
      case "pixels": {
        if (op.pixels.length > MAX_PIXELS_PER_OP) {
          throw new Error(`${where}: ${op.pixels.length} pixels exceeds limit ${MAX_PIXELS_PER_OP} — batch into multiple draw calls`);
        }
        for (const p of op.pixels) {
          checkBounds(sprite, p.x, p.y);
          checkColor(sprite, p.color);
          grid[p.y][p.x] = p.color;
        }
        break;
      }
      case "clear": {
        const c = op.color ?? 0;
        checkColor(sprite, c);
        for (let y = 0; y < sprite.height; y++) grid[y].fill(c);
        break;
      }
      case "outline": {
        // Wrap opaque pixels in an outline color. Computed from a snapshot
        // so the outline itself doesn't cascade.
        // scope "all" (default) wraps the whole silhouette; scope "new" only
        // wraps pixels that became opaque during THIS draw call — detail
        // passes can grow the shape without re-fattening existing thin
        // elements (bowstrings, weapon edges) with a second outline.
        const c = op.color ?? sprite.outlineIndex ?? 1;
        checkColor(sprite, c);
        const onlyNew = op.scope === "new";
        const snapshot = grid.map((r) => [...r]);
        const isAnchor = (x, y) => snapshot[y][x] !== 0 && (!onlyNew || preCall[y][x] === 0);
        for (let y = 0; y < sprite.height; y++) {
          for (let x = 0; x < sprite.width; x++) {
            if (snapshot[y][x] !== 0) continue;
            const touchesOpaque =
              (y > 0 && isAnchor(x, y - 1)) ||
              (y < sprite.height - 1 && isAnchor(x, y + 1)) ||
              (x > 0 && isAnchor(x - 1, y)) ||
              (x < sprite.width - 1 && isAnchor(x + 1, y)) ||
              (op.diagonals &&
                ((y > 0 && x > 0 && isAnchor(x - 1, y - 1)) ||
                  (y > 0 && x < sprite.width - 1 && isAnchor(x + 1, y - 1)) ||
                  (y < sprite.height - 1 && x > 0 && isAnchor(x - 1, y + 1)) ||
                  (y < sprite.height - 1 && x < sprite.width - 1 && isAnchor(x + 1, y + 1))));
            if (touchesOpaque) grid[y][x] = c;
          }
        }
        break;
      }
      case "line": {
        // Bresenham line; thickness paints a centered square brush (clipped at edges).
        checkColor(sprite, op.color);
        checkBounds(sprite, op.x0, op.y0);
        checkBounds(sprite, op.x1, op.y1);
        const th = op.thickness ?? 1;
        const off = Math.floor((th - 1) / 2);
        let [x0, y0] = [op.x0, op.y0];
        const dx = Math.abs(op.x1 - x0);
        const dy = -Math.abs(op.y1 - y0);
        const sx = x0 < op.x1 ? 1 : -1;
        const sy = y0 < op.y1 ? 1 : -1;
        let err = dx + dy;
        for (;;) {
          for (let oy = 0; oy < th; oy++) {
            for (let ox = 0; ox < th; ox++) {
              const px = x0 - off + ox;
              const py = y0 - off + oy;
              if (px >= 0 && px < sprite.width && py >= 0 && py < sprite.height) grid[py][px] = op.color;
            }
          }
          if (x0 === op.x1 && y0 === op.y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x0 += sx; }
          if (e2 <= dx) { err += dx; y0 += sy; }
        }
        break;
      }
      case "curve": {
        // Quadratic bezier from (x0,y0) to (x1,y1) bent toward control point
        // (cx,cy). Sampled densely and painted with the same centered square
        // brush as "line" — one op replaces hand-chained line segments for
        // arcs (bows, capes, tails). The control point is not bounds-checked:
        // a control off-grid is a legitimate way to get a shallow arc;
        // painting is clipped. Endpoints must be on-grid (same as "line").
        checkColor(sprite, op.color);
        checkBounds(sprite, op.x0, op.y0);
        checkBounds(sprite, op.x1, op.y1);
        const th = op.thickness ?? 1;
        const off = Math.floor((th - 1) / 2);
        const { x0, y0, cx, cy, x1, y1 } = op;
        const approxLen = Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy);
        const steps = Math.max(8, Math.ceil(approxLen * 2));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const u = 1 - t;
          const px = Math.round(u * u * x0 + 2 * u * t * cx + t * t * x1);
          const py = Math.round(u * u * y0 + 2 * u * t * cy + t * t * y1);
          for (let oy = 0; oy < th; oy++) {
            for (let ox = 0; ox < th; ox++) {
              const bx = px - off + ox;
              const by = py - off + oy;
              if (bx >= 0 && bx < sprite.width && by >= 0 && by < sprite.height) grid[by][bx] = op.color;
            }
          }
        }
        break;
      }
      case "ellipse": {
        // Filled ellipse (default) or 1px ring (filled: false), centered at (cx, cy).
        checkColor(sprite, op.color);
        const { cx, cy, rx, ry } = op;
        const inside = (x, y) => {
          const nx = (x - cx) / (rx + 0.5);
          const ny = (y - cy) / (ry + 0.5);
          return nx * nx + ny * ny <= 1;
        };
        for (let y = Math.max(0, cy - ry); y <= Math.min(sprite.height - 1, cy + ry); y++) {
          for (let x = Math.max(0, cx - rx); x <= Math.min(sprite.width - 1, cx + rx); x++) {
            if (!inside(x, y)) continue;
            if (op.filled === false) {
              const boundary = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
              if (!boundary) continue;
            }
            grid[y][x] = op.color;
          }
        }
        break;
      }
      case "taperedLine": {
        // Round-capped capsule from (x0,y0) to (x1,y1) whose diameter changes
        // linearly from w0 to w1. Paints when the integer sample point is
        // within w(t)/2 of the nearest centerline point (projection clamped to
        // the finite segment), so both ends get round caps.
        checkColor(sprite, op.color);
        checkBounds(sprite, op.x0, op.y0);
        checkBounds(sprite, op.x1, op.y1);
        for (const [name, value] of [["w0", op.w0], ["w1", op.w1]]) {
          if (!Number.isInteger(value) || value < 1 || value > 12) {
            throw new Error(`${where}: ${name} must be an integer 1..12 (got ${value})`);
          }
        }
        const tdx = op.x1 - op.x0;
        const tdy = op.y1 - op.y0;
        const len2 = tdx * tdx + tdy * tdy;
        if (len2 === 0) {
          throw new Error(`${where}: endpoints are coincident — use "ellipse" for a round stamp`);
        }
        const maxR = Math.max(op.w0, op.w1) / 2;
        const bx0 = Math.max(0, Math.floor(Math.min(op.x0, op.x1) - maxR));
        const bx1 = Math.min(sprite.width - 1, Math.ceil(Math.max(op.x0, op.x1) + maxR));
        const by0 = Math.max(0, Math.floor(Math.min(op.y0, op.y1) - maxR));
        const by1 = Math.min(sprite.height - 1, Math.ceil(Math.max(op.y0, op.y1) + maxR));
        for (let y = by0; y <= by1; y++) {
          for (let x = bx0; x <= bx1; x++) {
            const t = Math.max(0, Math.min(1, ((x - op.x0) * tdx + (y - op.y0) * tdy) / len2));
            const cx = op.x0 + t * tdx;
            const cy = op.y0 + t * tdy;
            const radius = (op.w0 + (op.w1 - op.w0) * t) / 2;
            const dx = x - cx;
            const dy = y - cy;
            if (dx * dx + dy * dy <= radius * radius) grid[y][x] = op.color;
          }
        }
        break;
      }
      case "polygon": {
        // Filled simple polygon, even-odd at integer grid sample points.
        // Vertices must be on-grid integers so coordinate mistakes fail loudly;
        // only the raster loop's bounding box is clipped.
        checkColor(sprite, op.color);
        const pts = op.points;
        if (!Array.isArray(pts) || pts.length < 3 || pts.length > 16) {
          throw new Error(`${where}: polygon needs 3..16 vertices (got ${Array.isArray(pts) ? pts.length : typeof pts})`);
        }
        for (const [i, p] of pts.entries()) {
          if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || !Number.isInteger(p[1])) {
            throw new Error(`${where}: vertex ${i} must be an integer [x, y]`);
          }
          checkBounds(sprite, p[0], p[1]);
          const next = pts[(i + 1) % pts.length];
          if (p[0] === next[0] && p[1] === next[1]) {
            throw new Error(`${where}: repeated adjacent vertex at index ${i} (vertices ${i} and ${(i + 1) % pts.length})`);
          }
        }
        let twiceArea = 0;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          twiceArea += a[0] * b[1] - b[0] * a[1];
        }
        if (Math.abs(twiceArea) < 1e-9) throw new Error(`${where}: polygon has zero area`);

        // O(n^2) self-intersection check (n <= 16). Adjacent edges share an
        // endpoint by design; non-adjacent edges must not touch or cross.
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          for (let j = i + 1; j < pts.length; j++) {
            if (j === i + 1 || (i === 0 && j === pts.length - 1)) continue;
            const c = pts[j];
            const d = pts[(j + 1) % pts.length];
            if (segmentsIntersect(a, b, c, d)) {
              throw new Error(`${where}: self-intersecting polygon (edges ${i} and ${j} cross or touch)`);
            }
          }
        }

        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const minX = Math.max(0, Math.min(...xs));
        const maxX = Math.min(sprite.width - 1, Math.max(...xs));
        const minY = Math.max(0, Math.min(...ys));
        const maxY = Math.min(sprite.height - 1, Math.max(...ys));
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            if (pointInPolygon(x, y, pts)) grid[y][x] = op.color;
          }
        }
        break;
      }
      case "litEllipse": {
        // Lambert-shaded ellipse: a per-pixel light term maps onto a 3-color
        // ramp [light, mid, dark]; ordered dither softens the band boundaries.
        // One op replaces a whole hand-placed shading pass. Unlike "ellipse",
        // cx/cy/rx/ry may be fractional (e.g. 15.5 centers on even grids).
        for (const c of op.ramp) checkColor(sprite, c);
        const [rl, rm, rd] = op.ramp;
        let [lx, ly] = op.light ?? [-0.6, -0.75];
        const len = Math.hypot(lx, ly);
        if (len < 1e-6) { lx = -0.6; ly = -0.75; } else { lx /= len; ly /= len; }
        const hi = op.hi ?? 0.42;
        const lo = op.lo ?? -0.38;
        const dither = op.dither !== false;
        const { cx, cy, rx, ry } = op;
        for (let y = Math.max(0, Math.floor(cy - ry - 1)); y <= Math.min(sprite.height - 1, Math.ceil(cy + ry + 1)); y++) {
          for (let x = Math.max(0, Math.floor(cx - rx - 1)); x <= Math.min(sprite.width - 1, Math.ceil(cx + rx + 1)); x++) {
            const nx = (x - cx) / (rx + 0.5);
            const ny = (y - cy) / (ry + 0.5);
            if (nx * nx + ny * ny > 1) continue;
            const lam = lx * nx + ly * ny;
            let c = lam > hi ? rl : lam < lo ? rd : rm;
            if (dither) {
              if (Math.abs(lam - hi) < 0.1 && (x + y) % 2 === 0) c = rl;
              else if (Math.abs(lam - lo) < 0.1 && (x + y) % 2 === 0) c = rd;
            }
            grid[y][x] = c;
          }
        }
        break;
      }
      case "rampRect": {
        // Gradient rect: ramp[0] at the top/left -> ramp[last] at bottom/right.
        checkBounds(sprite, op.x, op.y);
        checkBounds(sprite, op.x + op.w - 1, op.y + op.h - 1);
        for (const c of op.ramp) checkColor(sprite, c);
        const horizontal = op.dir === "h";
        const span = horizontal ? op.w : op.h;
        for (let i = 0; i < span; i++) {
          const c = op.ramp[Math.min(op.ramp.length - 1, Math.floor((i / span) * op.ramp.length))];
          for (let j = 0; j < (horizontal ? op.h : op.w); j++) {
            grid[horizontal ? op.y + j : op.y + i][horizontal ? op.x + i : op.x + j] = c;
          }
        }
        break;
      }
      case "block": {
        // RLE rows pasted at (x, y); each row has its own width (no full-grid sum).
        const rows = op.rows.split(";").map((r, i) => {
          let row;
          try {
            row = decodeRuns(r);
          } catch (e) {
            throw new Error(`${where}, block row ${i}: ${e.message}`);
          }
          for (const v of row) checkColor(sprite, v);
          return row;
        });
        for (const [dy, row] of rows.entries()) {
          const y = op.y + dy;
          if (y < 0 || y >= sprite.height) throw new Error(`${where}, block row ${dy}: y=${y} out of bounds (height ${sprite.height})`);
          if (op.x < 0 || op.x + row.length > sprite.width) {
            throw new Error(`${where}, block row ${dy}: x=${op.x} + width ${row.length} exceeds grid width ${sprite.width}`);
          }
          for (let dx = 0; dx < row.length; dx++) grid[y][op.x + dx] = row[dx];
        }
        break;
      }
      case "fill": {
        // Flood fill (4-connectivity) from (x, y), replacing the connected
        // region of the clicked color with `color`.
        checkBounds(sprite, op.x, op.y);
        checkColor(sprite, op.color);
        const from = grid[op.y][op.x];
        if (from === op.color) break;
        const stack = [[op.x, op.y]];
        while (stack.length) {
          const [x, y] = stack.pop();
          if (x < 0 || x >= sprite.width || y < 0 || y >= sprite.height) continue;
          if (grid[y][x] !== from) continue;
          grid[y][x] = op.color;
          stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
        break;
      }
      case "shift": {
        // Translate the whole grid by (dx, dy). Pixels shifted off-grid are
        // dropped; vacated cells become transparent. Great for animation bob.
        const dx = op.dx ?? 0;
        const dy = op.dy ?? 0;
        const snapshot = grid.map((r) => [...r]);
        for (let y = 0; y < sprite.height; y++) grid[y].fill(0);
        for (let y = 0; y < sprite.height; y++) {
          for (let x = 0; x < sprite.width; x++) {
            const v = snapshot[y][x];
            if (v === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < sprite.width && ny >= 0 && ny < sprite.height) grid[ny][nx] = v;
          }
        }
        break;
      }
      default:
        throw new Error(`${where}: unknown op type "${op.type}"`);
    }
  }
}

function decodeRowSafe(rle, width, where) {
  try {
    return decodeRow(rle, width);
  } catch (e) {
    throw new Error(`${where}: ${e.message}`);
  }
}

/**
 * Stage a draw without touching the sprite: resolve the target, clone its
 * rows, apply every op and the optional mirror to the clone. Returns the
 * staged grid plus a commit closure that swaps it into the intended base or
 * animation frame. commit() does no storage/history/version work — callers
 * call storage.beginEdit() immediately before it so one undo snapshot covers
 * the whole draw.
 *
 * Until commit() runs, the sprite's grid data is unchanged; a failing op
 * therefore leaves no hidden partial state anywhere.
 */
export function stageDraw(sprite, frame, ops, mirror = false) {
  const target = targetGrid(sprite, frame); // validate before cloning
  const stagedGrid = target.map((row) => [...row]);
  applyOps(sprite, stagedGrid, ops);
  if (mirror) mirrorHorizontal(sprite, stagedGrid);
  const commit = () => {
    if (frame) {
      const anim = sprite.animations[frame.anim];
      anim.frames[frame.index] = stagedGrid;
    } else {
      sprite.grid = stagedGrid;
    }
  };
  return { grid: stagedGrid, commit };
}

/** Mirror the left half of the grid onto the right half. */
export function mirrorHorizontal(sprite, grid) {
  for (let y = 0; y < sprite.height; y++) {
    for (let x = 0; x < Math.floor(sprite.width / 2); x++) {
      grid[y][sprite.width - 1 - x] = grid[y][x];
    }
  }
}

/** Bounding box of non-transparent content, or null if the grid is empty. */
export function contentBounds(grid) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      if (grid[y][x] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

export function addAnimation(sprite, name, frameCount, fps) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`invalid animation name "${name}"`);
  }
  if (sprite.animations[name]) throw new Error(`animation "${name}" already exists on "${sprite.name}"`);
  if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 16) {
    throw new Error(`frameCount must be an integer 2..16 (got ${frameCount})`);
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    throw new Error(`fps must be an integer 1..60 (got ${fps})`);
  }
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(i === 0 ? sprite.grid.map((r) => [...r]) : blankGrid(sprite.width, sprite.height));
  }
  sprite.animations[name] = { fps, frames };
}

export function copyFrame(sprite, animName, from, to) {
  const anim = sprite.animations[animName];
  if (!anim) throw new Error(`no animation "${animName}" on sprite "${sprite.name}"`);
  for (const idx of [from, to]) {
    if (idx < 0 || idx >= anim.frames.length) {
      throw new Error(`frame index ${idx} out of range (${anim.frames.length} frames)`);
    }
  }
  anim.frames[to] = anim.frames[from].map((r) => [...r]);
}

function getAnim(sprite, animName) {
  const anim = sprite.animations[animName];
  if (!anim) throw new Error(`no animation "${animName}" on sprite "${sprite.name}"`);
  return anim;
}

function checkFrameIndex(anim, index) {
  if (!Number.isInteger(index) || index < 0 || index >= anim.frames.length) {
    throw new Error(`frame index ${index} out of range (${anim.frames.length} frames)`);
  }
}

/** Insert a frame after `index`; copies that frame when copy=true, else blank. */
export function insertFrame(sprite, animName, index, copy) {
  const anim = getAnim(sprite, animName);
  checkFrameIndex(anim, index);
  if (anim.frames.length >= 16) throw new Error("animation already has the maximum of 16 frames");
  const frame = copy ? anim.frames[index].map((r) => [...r]) : blankGrid(sprite.width, sprite.height);
  anim.frames.splice(index + 1, 0, frame);
}

export function deleteFrame(sprite, animName, index) {
  const anim = getAnim(sprite, animName);
  checkFrameIndex(anim, index);
  if (anim.frames.length <= 1) throw new Error("cannot delete the last frame");
  anim.frames.splice(index, 1);
}

export function moveFrame(sprite, animName, from, to) {
  const anim = getAnim(sprite, animName);
  checkFrameIndex(anim, from);
  checkFrameIndex(anim, to);
  const [frame] = anim.frames.splice(from, 1);
  anim.frames.splice(to, 0, frame);
}

export function setFps(sprite, animName, fps) {
  const anim = getAnim(sprite, animName);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error(`fps must be an integer 1..60 (got ${fps})`);
  anim.fps = fps;
}

/**
 * Resize a sprite (and all animation frames) to a new grid size.
 * Content stays horizontally centered and bottom-aligned (feet-on-ground
 * convention), so growing the grid adds headroom for animation poses.
 */
export function resizeSprite(sprite, width, height) {
  if (!GRID_SIZES.includes(width) || !GRID_SIZES.includes(height)) {
    throw new Error(`grid size must be one of ${GRID_SIZES.join("/")} (got ${width}x${height})`);
  }
  if (width === sprite.width && height === sprite.height) return;

  const remap = (grid) => {
    const out = blankGrid(width, height);
    const dx = Math.round((width - sprite.width) / 2);
    const dy = height - sprite.height; // bottom-align
    for (let y = 0; y < sprite.height; y++) {
      for (let x = 0; x < sprite.width; x++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) out[ny][nx] = grid[y][x];
      }
    }
    return out;
  };

  sprite.grid = remap(sprite.grid);
  for (const anim of Object.values(sprite.animations)) {
    anim.frames = anim.frames.map(remap);
  }
  sprite.width = width;
  sprite.height = height;
}
