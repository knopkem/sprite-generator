// Reference image pipeline: download -> pixelate to grid size -> extract palette.
// Pure functions take/return pngjs PNG objects or Buffers; fetch is the only
// impure part (injectable for tests).

import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const MAX_BYTES = 5 * 1024 * 1024;

function px(png, x, y) {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

/**
 * Area-average resize. Averaging (not nearest-neighbor) shows how detail
 * actually survives at the target size.
 * Color channels are alpha-weighted (premultiplied semantics): transparent
 * pixels' RGB must not darken partially-covered output pixels — otherwise
 * sprites/references with transparent backgrounds get muddy dark edges.
 * Alpha itself is averaged straight, so coverage still fades correctly.
 */
export function resizeAvg(src, tw, th) {
  const out = new PNG({ width: tw, height: th });
  const sx = src.width / tw;
  const sy = src.height / th;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0, g = 0, b = 0, a = 0, w = 0, n = 0;
      for (let yy = y0; yy < Math.min(y1, src.height); yy++) {
        for (let xx = x0; xx < Math.min(x1, src.width); xx++) {
          const p = px(src, xx, yy);
          r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3];
          a += p[3]; w += p[3]; n++;
        }
      }
      const i = (y * tw + x) * 4;
      out.data[i] = w ? Math.round(r / w) : 0;
      out.data[i + 1] = w ? Math.round(g / w) : 0;
      out.data[i + 2] = w ? Math.round(b / w) : 0;
      out.data[i + 3] = Math.round(a / n);
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

/**
 * Extract a palette of at most maxColors from a PNG.
 * Real pixel art (few unique colors) is used verbatim, ordered by frequency.
 * Rich images are median-cut quantized. Fully transparent pixels are ignored.
 * @returns {string[]} hex colors, most frequent first
 */
export function extractPalette(png, maxColors = 12) {
  const counts = new Map(); // "r,g,b" -> count
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const p = px(png, x, y);
      if (p[3] < 128) continue;
      const key = `${p[0]},${p[1]},${p[2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const entries = [...counts.entries()].map(([k, count]) => {
    const [r, g, b] = k.split(",").map(Number);
    return { r, g, b, count };
  });
  entries.sort((a, b) => b.count - a.count);
  if (entries.length <= maxColors) return entries.map((e) => hex(e.r, e.g, e.b));

  // median cut
  let buckets = [entries];
  while (buckets.length < maxColors) {
    buckets.sort((a, b) => b.reduce((s, e) => s + e.count, 0) - a.reduce((s, e) => s + e.count, 0));
    const bucket = buckets.shift();
    if (bucket.length < 2) { buckets.push(bucket); break; }
    const ranges = ["r", "g", "b"].map((ch) => ({
      ch,
      range: Math.max(...bucket.map((e) => e[ch])) - Math.min(...bucket.map((e) => e[ch])),
    }));
    ranges.sort((a, b) => b.range - a.range);
    const ch = ranges[0].ch;
    bucket.sort((a, b) => a[ch] - b[ch]);
    const half = bucket.reduce((s, e) => s + e.count, 0) / 2;
    let acc = 0, split = 1;
    for (; split < bucket.length; split++) {
      acc += bucket[split - 1].count;
      if (acc >= half) break;
    }
    buckets.push(bucket.slice(0, split), bucket.slice(split));
  }
  return buckets.map((bucket) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const e of bucket) { r += e.r * e.count; g += e.g * e.count; b += e.b * e.count; n += e.count; }
    return hex(Math.round(r / n), Math.round(g / n), Math.round(b / n));
  });
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
