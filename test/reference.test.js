import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { resizeAvg, upscaleNn, extractPalette, fetchReference } from "../src/reference.js";

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
