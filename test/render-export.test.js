import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { createSprite, applyOps, addAnimation, copyFrame } from "../src/model.js";
import { renderPng, renderOnionSkin, parseColor } from "../src/render.js";
import { exportSprite } from "../src/export.js";
import { Storage } from "../src/storage.js";

function tmpStorage() {
  return new Storage(fs.mkdtempSync(path.join(os.tmpdir(), "sprite-test-")));
}

test("parseColor handles rgb/rgba/transparent", () => {
  assert.deepEqual(parseColor("#ff0000"), [255, 0, 0, 255]);
  assert.deepEqual(parseColor("#00ff0080"), [0, 255, 0, 128]);
  assert.equal(parseColor("#00000000"), null);
  assert.equal(parseColor("garbage"), null);
});

test("renderPng produces a valid PNG of expected size", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [{ type: "rect", x: 4, y: 4, w: 4, h: 4, color: 3 }]);
  const buf = renderPng(s.grid, s.palette);
  const png = PNG.sync.read(buf);
  assert.equal(png.width, 512);
  assert.equal(png.height, 512);
  // pixel (5,5) in grid coords is inside the rect; png coords = 5*32+16 = 176
  const idx = (176 * png.width + 176) * 4;
  assert.deepEqual([png.data[idx], png.data[idx + 1], png.data[idx + 2]], [0xb1, 0x3e, 0x53]);
});

test("renderPng respects explicit scale", () => {
  const s = createSprite("t", 16, 16);
  const png = PNG.sync.read(renderPng(s.grid, s.palette, { scale: 4 }));
  assert.equal(png.width, 64);
});

test("onion skin renders and tints neighbors", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [{ type: "pixels", pixels: [{ x: 2, y: 2, color: 1 }] }]);
  addAnimation(s, "run", 3, 8);
  copyFrame(s, "run", 0, 1);
  applyOps(s, s.animations.run.frames[1], [{ type: "pixels", pixels: [{ x: 5, y: 5, color: 2 }] }]);
  const buf = renderOnionSkin([s.animations.run.frames[0], s.animations.run.frames[1], s.animations.run.frames[2]], s.palette);
  const png = PNG.sync.read(buf);
  assert.equal(png.width, 512);
});

test("exportSprite writes sheet PNG + aseprite JSON", () => {
  const storage = tmpStorage();
  const s = storage.create("wiz", 16, 16);
  applyOps(s, s.grid, [{ type: "rect", x: 0, y: 0, w: 4, h: 4, color: 5 }]);
  addAnimation(s, "run", 3, 10);
  storage.save(s);

  const { pngPath, jsonPath, frames } = exportSprite(s, storage, { layout: "grid" });
  assert.ok(fs.existsSync(pngPath));
  assert.ok(fs.existsSync(jsonPath));
  assert.equal(frames.length, 4); // base + 3 run frames

  const png = PNG.sync.read(fs.readFileSync(pngPath));
  assert.equal(png.height, 2 * 16); // two rows: base + run
  assert.equal(png.width, 3 * 16); // max cols = 3

  const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(meta.frames.length, 4);
  assert.equal(meta.meta.frameTags.length, 2);
  assert.equal(meta.meta.frameTags[1].name, "run");
  assert.equal(meta.meta.frameTags[1].from, 1);

  // strip layout, single animation
  const strip = exportSprite(s, storage, { layout: "strip", anim: "run" });
  const spng = PNG.sync.read(fs.readFileSync(strip.pngPath));
  assert.equal(spng.height, 16);
  assert.equal(spng.width, 48);
});

test("storage persists and lists sprites", () => {
  const storage = tmpStorage();
  storage.create("a", 16, 16);
  storage.create("b", 32, 32);
  assert.deepEqual(storage.list(), ["a", "b"]);
  const fresh = new Storage(storage.root);
  assert.equal(fresh.get("a").width, 16);
  assert.throws(() => storage.create("a", 16, 16), /already exists/);
  storage.delete("a");
  assert.deepEqual(storage.list(), ["b"]);
});
