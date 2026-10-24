import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { resizeAvg, upscaleNn, extractPalette, extractPaletteDetailed, prepareReference, fetchReference } from "../src/reference.js";

function makePng(w, h, paint) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * w + x) * 4;
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a;
    }
  }
  return png;
}

test("resizeAvg averages 2x2 blocks down to 1", () => {
  // left half black, right half white -> 2x1 result averages each column pair
  const src = makePng(4, 2, (x) => (x < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const out = resizeAvg(src, 2, 1);
  const i0 = 0, i1 = 4;
  assert.deepEqual([out.data[i0], out.data[i0 + 1], out.data[i0 + 2]], [0, 0, 0]);
  assert.deepEqual([out.data[i1], out.data[i1 + 1], out.data[i1 + 2]], [255, 255, 255]);
  // uniform quad -> averaged
  const mix = makePng(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const one = resizeAvg(mix, 1, 1);
  assert.deepEqual([one.data[0], one.data[1], one.data[2]], [64, 64, 64]); // round(255/4)
});

test("resizeAvg alpha-weights color: transparent black cannot darken edges", () => {
  // one opaque red pixel + three fully transparent pixels -> 1x1
  const src = makePng(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  const out = resizeAvg(src, 1, 1);
  assert.deepEqual([out.data[0], out.data[1], out.data[2]], [255, 0, 0]); // pure red, not [64, 0, 0]
  assert.equal(out.data[3], 64); // alpha stays coverage-averaged: round(255/4)
});

test("upscaleNn repeats pixels exactly", () => {
  const src = makePng(2, 2, (x, y) => [x * 100, y * 100, 0, 255]);
  const out = upscaleNn(src, 3);
  assert.equal(out.width, 6);
  const i = (4 * 6 + 4) * 4; // pixel (4,4) -> source (1,1)
  assert.deepEqual([out.data[i], out.data[i + 1]], [100, 100]);
});

/** The pre-fractional implementation, kept only to prove integer-ratio parity. */
function legacyResizeAvg(src, tw, th) {
  const at = (x, y) => {
    const i = (y * src.width + x) * 4;
    return [src.data[i], src.data[i + 1], src.data[i + 2], src.data[i + 3]];
  };
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
          const p = at(xx, yy);
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

test("resizeAvg is byte-identical to whole-pixel averaging for integer ratios", () => {
  const src = makePng(8, 6, (x, y) => [
    (x * 37 + y * 11) % 256,
    (x * 19 + y * 53) % 256,
    (x * 71 + y * 7) % 256,
    (x + y) % 3 === 0 ? 0 : (x * 97 + y * 31) % 256,
  ]);
  for (const [tw, th] of [[4, 3], [2, 2], [8, 3], [4, 6]]) {
    const now = resizeAvg(src, tw, th);
    const legacy = legacyResizeAvg(src, tw, th);
    assert.deepEqual(Buffer.from(now.data), Buffer.from(legacy.data), `${tw}x${th} changed`);
  }
});

test("resizeAvg uses exact fractional source-pixel coverage", () => {
  // 3x1 -> 2x1: destination 0 covers source pixels 0 (full) and 1 (half);
  // destination 1 covers source pixel 1 (half) and 2 (full).
  const src = makePng(3, 1, (x) => [[10, 10, 10, 255], [20, 20, 20, 255], [30, 30, 30, 255]][x]);
  const out = resizeAvg(src, 2, 1);
  assert.deepEqual([out.data[0], out.data[4]], [13, 27]);
  assert.deepEqual([out.data[3], out.data[7]], [255, 255]);
  // old floored boundaries would have produced 10 and 25 instead.

  // coverage-weighted alpha, with transparent RGB never muddying the color
  const withAlpha = makePng(3, 1, (x) =>
    x === 0 ? [255, 0, 0, 255] : x === 1 ? [0, 0, 0, 0] : [0, 0, 255, 255]
  );
  const a = resizeAvg(withAlpha, 2, 1);
  assert.deepEqual([a.data[0], a.data[1], a.data[2]], [255, 0, 0]);
  assert.deepEqual([a.data[4], a.data[5], a.data[6]], [0, 0, 255]);
  // alpha = 255 * 1 / 1.5
  assert.equal(a.data[3], 170);
  assert.equal(a.data[7], 170);
});

test("prepareReference resizes rectangular targets without distortion", () => {
  const src = makePng(40, 20, (x, y) => [x * 6 % 256, y * 12, (x + y) % 256, 255]);
  const prep = prepareReference(src, { width: 32, height: 16, colors: 4 });
  assert.equal(prep.pixelated.width, 32);
  assert.equal(prep.pixelated.height, 16);
  assert.equal(prep.scale, 16); // floor(512 / max(32, 16))
  assert.equal(prep.display.width, 32 * 16);
  assert.equal(prep.display.height, 16 * 16);
  // original is under the 512px cap, so it is returned unchanged
  assert.equal(prep.original.width, 40);
  assert.equal(prep.original.height, 20);

  assert.ok(prep.extracted.colors.length > 0 && prep.extracted.colors.length <= 4);
  assert.equal(prep.extracted.colors.length, prep.extracted.counts.length);
  const { colors, outlineIndex, rampFamilies } = prep.suggestion;
  assert.ok(colors.length >= 1);
  for (const c of colors) assert.match(c, /^#[0-9a-f]{6}$/);
  assert.ok(outlineIndex >= 1 && outlineIndex <= colors.length); // includes prepended transparent slot
  for (const f of rampFamilies) {
    assert.ok(f.from >= 1 && f.to >= f.from && f.to <= colors.length);
  }

  assert.throws(() => prepareReference(src, { width: 20, height: 20 }), /one of 16\/24\/32\/48\/64/);
});

test("extractPalette uses few-color images verbatim, frequency ordered", () => {
  const png = makePng(4, 4, (x, y) => (x < 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
  const pal = extractPalette(png, 12);
  assert.equal(pal.length, 2);
  assert.ok(pal.includes("#ff0000") && pal.includes("#00ff00"));
  // transparent pixels ignored
  const withClear = makePng(2, 2, (x) => (x === 0 ? [9, 9, 9, 255] : [255, 255, 255, 0]));
  assert.deepEqual(extractPalette(withClear, 12), ["#090909"]);
});

test("extractPalette median-cuts rich images to maxColors", () => {
  // 16 distinct colors across a 4x4
  const png = makePng(4, 4, (x, y) => [x * 60, y * 60, (x + y) * 30, 255]);
  const pal = extractPalette(png, 4);
  assert.equal(pal.length, 4);
  for (const c of pal) assert.match(c, /^#[0-9a-f]{6}$/);
});

test("extractPalette does not stop early on a dominant singleton bucket", () => {
  // 28 columns of one flat color + 12 distinct accent colors. The dominant
  // color splits off alone first; old code then picked it again as the
  // "largest" bucket, saw it was unsplittable, and stopped at 2 colors.
  const accents = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0],
    [255, 0, 255], [0, 255, 255], [128, 0, 0], [0, 128, 0],
    [0, 0, 128], [128, 128, 0], [0, 128, 128], [128, 0, 128],
  ];
  const png = makePng(32, 32, (x, y) => {
    if (x < 28) return [16, 16, 16, 255];
    return [...accents[(x - 28) + 4 * (y % 3)], 255];
  });
  const pal = extractPalette(png, 8);
  assert.equal(pal.length, 8);
  for (const c of pal) assert.match(c, /^#[0-9a-f]{6}$/);
});

test("extractPalette handles heavily unbalanced extremes without empty buckets", () => {
  const bands = [
    { c: [0, 0, 0], n: 240 },
    { c: [255, 255, 255], n: 4 },
    { c: [1, 0, 0], n: 4 },
    { c: [0, 1, 0], n: 4 },
    { c: [0, 0, 1], n: 4 },
    { c: [255, 0, 0], n: 4 },
  ];
  const total = bands.reduce((s, b) => s + b.n, 0);
  const png = makePng(20, Math.ceil(total / 20), (x, y) => {
    let i = y * 20 + x;
    for (const b of bands) {
      if (i < b.n) return [...b.c, 255];
      i -= b.n;
    }
    return [7, 7, 7, 0]; // padding: transparent, ignored
  });
  const pal = extractPalette(png, 5);
  assert.equal(pal.length, 5);
  for (const c of pal) {
    assert.match(c, /^#[0-9a-f]{6}$/);
    assert.doesNotMatch(c, /nan/i);
  }
});

test("extractPalette results are frequency ordered and valid across a sweep", () => {
  for (let seed = 0; seed < 7; seed++) {
    const png = makePng(9, 7, (x, y) => {
      const v = (x * 31 + y * 47 + seed * 13) % 23;
      return [v * 11, (v * 7) % 256, (v * 19) % 256, v === 0 ? 0 : 255];
    });
    for (const maxColors of [2, 3, 5, 9]) {
      const { colors, counts } = extractPaletteDetailed(png, maxColors);
      assert.ok(colors.length > 0);
      assert.ok(colors.length <= Math.min(maxColors, 22));
      for (const c of colors) assert.match(c, /^#[0-9a-f]{6}$/);
      for (let i = 1; i < counts.length; i++) assert.ok(counts[i - 1] >= counts[i]);
    }
  }
});

test("extractPaletteDetailed counts are ordered by represented population", () => {
  // 200 pixels: 100 / 50 / 30 / 15 / 5 in five distinct single-channel colors
  const bands = [
    { c: [17, 17, 17], n: 100 },
    { c: [34, 34, 34], n: 50 },
    { c: [51, 51, 51], n: 30 },
    { c: [68, 68, 68], n: 15 },
    { c: [85, 85, 85], n: 5 },
  ];
  const png = makePng(20, 10, (x, y) => {
    let i = y * 20 + x;
    for (const b of bands) {
      if (i < b.n) return [...b.c, 255];
      i -= b.n;
    }
    return [0, 0, 0, 0];
  });
  const { colors, counts } = extractPaletteDetailed(png, 3);
  assert.equal(colors.length, 3);
  assert.equal(colors[0], "#111111"); // most represented bucket
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i - 1] >= counts[i]);
  assert.equal(counts[0], 100);
});

test("fetchReference validates URL and decodes PNG (injected fetch)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refs-"));
  await assert.rejects(() => fetchReference("not-a-url", dir), /invalid URL/);
  await assert.rejects(() => fetchReference("ftp://x/y.png", dir), /http/);

  const pngBuf = PNG.sync.write(makePng(2, 2, () => [1, 2, 3, 255]));
  const fakeFetch = async () =>
    new Response(pngBuf, { status: 200, headers: { "content-length": String(pngBuf.length) } });
  const { png, path: p } = await fetchReference("https://example.com/ref.png", dir, fakeFetch);
  assert.equal(png.width, 2);
  assert.ok(fs.existsSync(p));

  const badFetch = async () => new Response("nope", { status: 404 });
  await assert.rejects(() => fetchReference("https://example.com/x.png", dir, badFetch), /404/);
});
