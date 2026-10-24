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
import { organizePalette, suggestOutlineIndex } from "./palette.js";

export { organizePalette };

export const MAX_BIG_SIDE = 1024;
export const PAINTER_TIMEOUT_MS = 2000;

function checkColor(c, where) {
  if (!Array.isArray(c) || c.length < 3 || c.length > 4 || c.some((v) => typeof v !== "number" || !isFinite(v))) {
    throw new Error(`${where}: color must be an array [r, g, b, a?] of numbers`);
  }
}

/** Normalize an RGB or RGBA painter color to [r, g, b, a]. */
function rgba(c) {
  return c.length === 4 ? c : [c[0], c[1], c[2], 255];
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
    const ca = rgba(a);
    const cb = rgba(b);
    return ca.map((v, i) => v + (cb[i] - v) * t);
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
  const extRgb = extracted.map((c) => {
    const parsed = parseColor(c);
    // extractPalette() only returns #rrggbb, so this is unreachable unless the
    // extractor itself regresses. Fail loudly instead of silently painting
    // transparent black and producing invisible art.
    if (!parsed) throw new Error(`internal error: palette extractor returned invalid color "${c}"`);
    return parsed;
  });

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
  // index 1 is not necessarily dark in a generated palette; make the outline
  // default follow the actual palette.
  sprite.outlineIndex = suggestOutlineIndex(palette);
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const a = assign[y * gridSize + x];
      sprite.grid[y][x] = a < 0 ? 0 : remap[a];
    }
  }
  return { sprite, logs, big: png, small };
}
