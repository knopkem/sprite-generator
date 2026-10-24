// Procedural generation: sandboxed painter JS paints a big RGBA canvas
// (gridSize x scale), which is downsampled (alpha-weighted) to the grid and
// quantized into a palette-indexed sprite. This is the medium path for
// organic, gradient-heavy art where hand-placed ops get expensive.
//
// The extracted palette is organized into ramp families (same-hue shades,
// light -> dark, matching DEFAULT_PALETTE's convention) so shading ops like
// litEllipse compose on generated sprites: ramp: [i, i+1, i+2] within a family.
//
// Trust model: sprite-studio is a localhost single-user dev tool. The painter
// runs in a node:vm context with no require/process/fs and a hard CPU timeout.
// node:vm is an isolation convenience, NOT a security boundary — never expose
// the daemon beyond localhost.

import vm from "node:vm";
import { PNG } from "pngjs";
import { createSprite, GRID_SIZES } from "./model.js";
import { parseColor } from "./render.js";
import { resizeAvg, extractPalette } from "./reference.js";

export const MAX_BIG_SIDE = 1024;
export const PAINTER_TIMEOUT_MS = 2000;

const HUE_GAP = 28; // degrees; a larger hue jump starts a new family
const NEUTRAL_SAT = 0.18; // below this saturation a color joins the neutral family
const HUE_NAMES = [
  [15, "red"], [48, "orange"], [68, "yellow"], [150, "green"], [180, "teal"],
  [200, "cyan"], [250, "blue"], [285, "purple"], [330, "pink"], [361, "red"],
];

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hueName(h) {
  for (const [limit, name] of HUE_NAMES) if (h < limit) return name;
  return "red";
}

/**
 * Organize extracted palette hexes into ramp families: same-hue shades become
 * adjacent, ordered light -> dark (the DEFAULT_PALETTE ramp convention, so
 * litEllipse ramp: [i, i+1, i+2] picks shading neighbors). Families are
 * ordered by pixel usage, most-used first; low-saturation colors form a
 * "neutral" family. Hue is circular — reds at both ends merge.
 * @returns {{ palette: string[], families: Array<{name, from, to}>, remap: number[] }}
 *   palette includes transparent at index 0; families use palette indices;
 *   remap maps extracted-color index -> final palette index.
 */
export function organizePalette(hexes, counts) {
  const entries = hexes.map((hex, i) => {
    const [r, g, b] = parseColor(hex) ?? [0, 0, 0, 0];
    return { hex, ...rgbToHsl(r, g, b), count: counts?.[i] ?? 1, old: i };
  });
  const neutral = entries.filter((e) => e.s < NEUTRAL_SAT);
  const chromatic = entries.filter((e) => e.s >= NEUTRAL_SAT).sort((a, b) => a.h - b.h);

  let clusters = [];
  for (const e of chromatic) {
    const last = clusters.at(-1);
    if (!last || e.h - last.at(-1).h > HUE_GAP) clusters.push([]);
    clusters.at(-1).push(e);
  }
  // hue is circular: merge the two end clusters when they wrap (e.g. reds)
  if (clusters.length > 1) {
    const first = clusters[0], last = clusters.at(-1);
    if (first[0].h + 360 - last.at(-1).h <= HUE_GAP) {
      clusters = [[...last, ...first], ...clusters.slice(1, -1)];
    }
  }
  if (neutral.length) clusters.push(neutral);

  // light -> dark within a family; families by usage
  for (const c of clusters) c.sort((a, b) => b.l - a.l);
  clusters.sort((a, b) => b.reduce((s, e) => s + e.count, 0) - a.reduce((s, e) => s + e.count, 0));

  // merge adjacent families that share a name (hue gap split one family)
  const merged = [];
  for (const c of clusters) {
    const name = c[0].s < NEUTRAL_SAT ? "neutral" : hueName(c[0].h);
    const prev = merged.at(-1);
    if (prev && prev.name === name) prev.entries.push(...c);
    else merged.push({ name, entries: [...c] });
  }
  for (const f of merged) f.entries.sort((a, b) => b.l - a.l);

  const palette = ["#00000000"];
  const families = [];
  const remap = new Array(hexes.length).fill(0);
  for (const f of merged) {
    const from = palette.length;
    for (const e of f.entries) {
      remap[e.old] = palette.length;
      palette.push(e.hex);
    }
    families.push({ name: f.name, from, to: palette.length - 1 });
  }
  return { palette, families, remap };
}

function checkColor(c, where) {
  if (!Array.isArray(c) || c.length < 3 || c.length > 4 || c.some((v) => typeof v !== "number" || !isFinite(v))) {
    throw new Error(`${where}: color must be an array [r, g, b, a?] of numbers`);
  }
}

/**
 * Run painter code in a sandbox. Available globals inside the code:
 *   W, H            canvas size
 *   px(x, y, c)     set pixel, c = [r,g,b,a?]
 *   over(x, y, c)   alpha-composite c over the existing pixel
 *   mix(a, b, t)    per-channel lerp between two colors
 *   clamp01(v), smooth(e0, e1, v)   math helpers
 *   rng()           seeded deterministic PRNG in [0, 1)
 *   log(...)        captured into the result (debugging)
 * @returns {{ png: PNG, logs: string[] }}
 */
export function runPainter(code, W, H, seed = 1) {
  const data = new Uint8ClampedArray(W * H * 4);

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const mix = (a, b, t) => {
    checkColor(a, "mix(a, ...)");
    checkColor(b, "mix(b, ...)");
    return a.map((v, i) => v + (b[i] - v) * t);
  };
  const smooth = (e0, e1, v) => {
    const t = clamp01((v - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  };
  const px = (x, y, c) => {
    checkColor(c, "px");
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
    data[i + 3] = c.length > 3 ? c[3] : 255;
  };
  const over = (x, y, c) => {
    checkColor(c, "over");
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    const sa = (c.length > 3 ? c[3] : 255) / 255;
    const da = data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    data[i] = (c[0] * sa + data[i] * da * (1 - sa)) / oa;
    data[i + 1] = (c[1] * sa + data[i + 1] * da * (1 - sa)) / oa;
    data[i + 2] = (c[2] * sa + data[i + 2] * da * (1 - sa)) / oa;
    data[i + 3] = oa * 255;
  };
  // xorshift32 — deterministic across runs for the same seed
  let rs = (seed >>> 0) || 1;
  const rng = () => {
    rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0;
    return rs / 4294967296;
  };
  const logs = [];
  const log = (...args) => logs.push(args.map(String).join(" "));

  const sandbox = { W, H, px, over, mix, clamp01, smooth, rng, log };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: PAINTER_TIMEOUT_MS });

  const png = new PNG({ width: W, height: H });
  Buffer.from(data.buffer).copy(png.data);
  return { png, logs };
}

/**
 * Paint big -> downsample -> quantize into a new sprite object (not persisted;
 * the caller owns storage.beginEdit/save).
 * @returns {{ sprite: object, logs: string[], big: PNG, small: PNG }}
 */
export function generateSprite({ name, code, gridSize = 48, scale = 4, colors = 12, seed = 1 }) {
  if (!GRID_SIZES.includes(gridSize)) {
    throw new Error(`gridSize must be one of ${GRID_SIZES.join("/")} (got ${gridSize})`);
  }
  if (!Number.isInteger(scale) || scale < 2 || scale > 8) {
    throw new Error(`scale must be an integer 2..8 (got ${scale})`);
  }
  if (!Number.isInteger(colors) || colors < 2 || colors > 30) {
    throw new Error(`colors must be an integer 2..30 (got ${colors})`);
  }
  const big = gridSize * scale;
  if (big > MAX_BIG_SIDE) {
    throw new Error(`canvas ${big}px exceeds the ${MAX_BIG_SIDE}px cap — lower gridSize or scale`);
  }
  const { png, logs } = runPainter(code, big, big, seed);
  const small = resizeAvg(png, gridSize, gridSize);

  const extracted = extractPalette(small, colors);
  const extRgb = extracted.map((c) => parseColor(c) ?? [0, 0, 0, 0]);

  // one nearest-color pass: assignment into the extracted palette + usage counts
  const assign = new Int16Array(gridSize * gridSize).fill(-1);
  const counts = new Array(extracted.length).fill(0);
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const i = (y * gridSize + x) * 4;
      if (small.data[i + 3] < 128) continue;
      const r = small.data[i], g = small.data[i + 1], b = small.data[i + 2];
      let best = 0, bd = Infinity;
      for (let p = 0; p < extRgb.length; p++) {
        const d = (extRgb[p][0] - r) ** 2 + (extRgb[p][1] - g) ** 2 + (extRgb[p][2] - b) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
      assign[y * gridSize + x] = best;
      counts[best]++;
    }
  }

  const { palette, families, remap } = organizePalette(extracted, counts);

  const sprite = createSprite(name, gridSize, gridSize);
  sprite.palette = palette;
  sprite.rampFamilies = families; // palette-indexed ramp map, surfaced by get_palette
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const a = assign[y * gridSize + x];
      sprite.grid[y][x] = a < 0 ? 0 : remap[a];
    }
  }
  return { sprite, logs, big: png, small };
}
