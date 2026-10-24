// Reference image pipeline: download -> pixelate to grid size -> extract palette.
// Pure functions take/return pngjs PNG objects or Buffers; fetch is the only
// impure part (injectable for tests).

import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { GRID_SIZES } from "./model.js";
import { organizePalette, suggestOutlineIndex } from "./palette.js";

const MAX_BYTES = 5 * 1024 * 1024;

function px(png, x, y) {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

/**
 * Area-average resize with fractional source-pixel coverage. Each destination
 * pixel integrates the exact source rectangle [x0,x1) x [y0,y1); a source pixel
 * contributes only its overlapping area. Color channels are alpha-weighted
 * (premultiplied semantics): transparent pixels' RGB must not darken
 * partially-covered output pixels — otherwise sprites/references with
 * transparent backgrounds get muddy dark edges. Alpha is coverage-averaged
 * (alpha * area / destination area), so coverage still fades correctly.
 * Integer ratios produce byte-identical output to whole-pixel averaging.
 */
export function resizeAvg(src, tw, th) {
  const out = new PNG({ width: tw, height: th });
  const sx = src.width / tw;
  const sy = src.height / th;
  for (let y = 0; y < th; y++) {
    const fy0 = y * sy;
    const fy1 = (y + 1) * sy;
    const y0 = Math.max(0, Math.floor(fy0));
    const y1 = Math.min(src.height, Math.ceil(fy1));
    for (let x = 0; x < tw; x++) {
      const fx0 = x * sx;
      const fx1 = (x + 1) * sx;
      const x0 = Math.max(0, Math.floor(fx0));
      const x1 = Math.min(src.width, Math.ceil(fx1));
      const destArea = (fx1 - fx0) * (fy1 - fy0);
      let r = 0, g = 0, b = 0, alphaWeight = 0, alphaArea = 0;
      for (let yy = y0; yy < y1; yy++) {
        const oy = Math.min(fy1, yy + 1) - Math.max(fy0, yy);
        if (oy <= 0) continue;
        for (let xx = x0; xx < x1; xx++) {
          const ox = Math.min(fx1, xx + 1) - Math.max(fx0, xx);
          if (ox <= 0) continue;
          const area = ox * oy;
          const p = px(src, xx, yy);
          const w = p[3] * area;
          r += p[0] * w; g += p[1] * w; b += p[2] * w;
          alphaWeight += w;
          alphaArea += w;
        }
      }
      const i = (y * tw + x) * 4;
      out.data[i] = alphaWeight ? Math.round(r / alphaWeight) : 0;
      out.data[i + 1] = alphaWeight ? Math.round(g / alphaWeight) : 0;
      out.data[i + 2] = alphaWeight ? Math.round(b / alphaWeight) : 0;
      out.data[i + 3] = Math.round(alphaArea / destArea);
    }
  }
  return out;
}

/** Nearest-neighbor upscale (for crisp display of a pixelated image). */
export function upscaleNn(src, scale) {
  const out = new PNG({ width: src.width * scale, height: src.height * scale });
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const p = px(src, Math.floor(x / scale), Math.floor(y / scale));
      const i = (y * out.width + x) * 4;
      out.data[i] = p[0]; out.data[i + 1] = p[1]; out.data[i + 2] = p[2]; out.data[i + 3] = p[3];
    }
  }
  return out;
}

function hex(r, g, b) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Represented pixel count of a bucket. */
function bucketWeight(bucket) {
  return bucket.reduce((s, e) => s + e.count, 0);
}

/** Widest RGB channel in a bucket (ties prefer r, then g, then b). */
function widestChannel(bucket) {
  let best = "r";
  let bestRange = -1;
  for (const ch of ["r", "g", "b"]) {
    let min = Infinity, max = -Infinity;
    for (const e of bucket) {
      if (e[ch] < min) min = e[ch];
      if (e[ch] > max) max = e[ch];
    }
    const range = max - min;
    if (range > bestRange) { bestRange = range; best = ch; }
  }
  return best;
}

/**
 * Extract a palette of at most maxColors from a PNG.
 * Real pixel art (few unique colors) is used verbatim, ordered by frequency.
 * Rich images are median-cut quantized. Fully transparent pixels are ignored.
 * @returns {string[]} hex colors, most frequent first
 */
export function extractPalette(png, maxColors = 12) {
  return extractPaletteDetailed(png, maxColors).colors;
}

/**
 * Same as extractPalette(), plus the represented pixel count for each returned
 * color. Counts refer to source pixels in the quantized bucket (or the exact
 * count on the few-color fast path).
 * @returns {{ colors: string[], counts: number[] }}
 */
export function extractPaletteDetailed(png, maxColors = 12) {
  const counts = new Map(); // "r,g,b" -> count
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const p = px(png, x, y);
      if (p[3] < 128) continue;
      const key = `${p[0]},${p[1]},${p[2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  // Map preserves scan order, so the stable sort below keeps deterministic
  // source order for frequency ties.
  const entries = [...counts.entries()].map(([k, count]) => {
    const [r, g, b] = k.split(",").map(Number);
    return { r, g, b, count };
  });
  entries.sort((a, b) => b.count - a.count);
  if (entries.length <= maxColors) {
    return { colors: entries.map((e) => hex(e.r, e.g, e.b)), counts: entries.map((e) => e.count) };
  }

  // median cut: only splittable buckets (>= 2 entries) participate, so a
  // dominant single color can never terminate extraction early.
  let buckets = [entries];
  while (buckets.length < maxColors) {
    let pick = -1;
    let pickWeight = -1;
    let pickRange = -1;
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      if (bucket.length < 2) continue;
      const weight = bucketWeight(bucket);
      const ch = widestChannel(bucket);
      const range = Math.max(...bucket.map((e) => e[ch])) - Math.min(...bucket.map((e) => e[ch]));
      // largest represented weight; ties by widest channel range; then the
      // earlier bucket (stable original order) wins.
      if (weight > pickWeight || (weight === pickWeight && range > pickRange)) {
        pick = i;
        pickWeight = weight;
        pickRange = range;
      }
    }
    if (pick < 0) break; // no bucket is splittable any more

    const bucket = buckets[pick];
    const ch = widestChannel(bucket);
    // Stable sort: equal channel values keep source order.
    const sorted = [...bucket].sort((a, b) => a[ch] - b[ch]);
    const total = bucketWeight(sorted);
    const half = total / 2;
    // Choose the boundary whose left-side weight is closest to half. split is
    // always in 1..length-1, so both slices are nonempty by construction.
    let acc = 0;
    let split = 1;
    let bestDiff = Infinity;
    for (let i = 1; i < sorted.length; i++) {
      acc += sorted[i - 1].count;
      const diff = Math.abs(acc - (total - acc));
      if (diff < bestDiff) { bestDiff = diff; split = i; }
    }
    buckets.splice(pick, 1, sorted.slice(0, split), sorted.slice(split));
  }

  const result = buckets.map((bucket) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const e of bucket) { r += e.r * e.count; g += e.g * e.count; b += e.b * e.count; n += e.count; }
    return { hex: hex(Math.round(r / n), Math.round(g / n), Math.round(b / n)), count: n };
  });
  // Frequency ordered, stable for equal populations.
  result.sort((a, b) => b.count - a.count);
  return { colors: result.map((r) => r.hex), counts: result.map((r) => r.count) };
}

/**
 * Prepare a downloaded reference for a target grid without any I/O:
 *  - original view capped at 512px on the long edge
 *  - pixelated image at the exact target width x height (no forced square)
 *  - nearest-neighbor display image scaled for inspection
 *  - extracted colors + represented counts
 *  - suggested set_palette arguments (colors, outlineIndex, rampFamilies)
 *
 * The suggested palette is organized into light->dark ramp families rather
 * than frequency ordered. That is safe for the research workflow because it is
 * applied before drawing; it is not meant to reorder an existing sprite.
 */
export function prepareReference(png, { width, height, colors = 12 } = {}) {
  if (!GRID_SIZES.includes(width) || !GRID_SIZES.includes(height)) {
    throw new Error(`reference target must be one of ${GRID_SIZES.join("/")} (got ${width}x${height})`);
  }
  const cap = 512 / Math.max(png.width, png.height);
  const original = cap < 1 ? resizeAvg(png, Math.round(png.width * cap), Math.round(png.height * cap)) : png;
  const pixelated = resizeAvg(png, width, height);
  const scale = Math.max(1, Math.floor(512 / Math.max(width, height)));
  const display = upscaleNn(pixelated, scale);
  const extracted = extractPaletteDetailed(pixelated, colors);
  const organized = organizePalette(extracted.colors, extracted.counts);
  const suggestion = {
    colors: organized.palette.slice(1),
    outlineIndex: suggestOutlineIndex(organized.palette),
    rampFamilies: organized.families,
  };
  return {
    width,
    height,
    scale,
    original,
    pixelated,
    display,
    extracted,
    suggestion,
  };
}

/**
 * Download a PNG reference. Throws agent-friendly errors.
 * @param {typeof fetch} fetchFn injectable for tests
 */
export async function fetchReference(url, refsDir, fetchFn = fetch) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL "${url}"`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("only http(s) URLs are supported");

  const res = await fetchFn(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error(`image too large (${Math.round(len / 1e6)}MB, cap is 5MB)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`image too large (cap is 5MB)`);

  let png;
  try {
    png = PNG.sync.read(buf);
  } catch {
    throw new Error("only PNG images are supported (Kenney and OpenGameArt assets are PNG) — the downloaded file did not decode");
  }

  fs.mkdirSync(refsDir, { recursive: true });
  const base = path.basename(parsed.pathname).replace(/[^\w.-]/g, "").slice(0, 60) || "reference";
  const file = path.join(refsDir, `${Date.now()}-${base}${base.endsWith(".png") ? "" : ".png"}`);
  fs.writeFileSync(file, PNG.sync.write(png));
  return { png, path: file };
}
