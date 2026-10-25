import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSprite, stageDraw, addAnimation, baseGrid } from "../src/model.js";
import { Storage } from "../src/storage.js";
import { drawAndSave } from "../src/draw.js";

function tmpStorage() {
  return new Storage(fs.mkdtempSync(path.join(os.tmpdir(), "sprite-draw-")));
}

function withAnimation(storage, name, animName = "idle") {
  const sprite = storage.get(name);
  addAnimation(sprite, animName, 2, 5);
  storage.save(sprite);
  return sprite;
}

const validOps = [
  { type: "rect", x: 2, y: 2, w: 4, h: 4, color: 5 },
  { type: "pixels", pixels: [{ x: 8, y: 8, color: 9 }] },
];
const failingOps = [
  { type: "rect", x: 2, y: 2, w: 4, h: 4, color: 5 },
  { type: "rect", x: 15, y: 0, w: 4, h: 1, color: 1 }, // out of bounds
];

test("failed base draw leaves grid, file, version, history, and events untouched", () => {
  const storage = tmpStorage();
  const sprite = storage.create("d", 16, 16);
  const version = sprite.version;
  const snapshot = JSON.stringify(sprite);
  const file = fs.readFileSync(storage.spritePath("d"), "utf8");
  let events = 0;
  storage.onChange(() => events++);

  assert.throws(() => drawAndSave(storage, "d", { ops: failingOps }), /out of bounds/);

  const current = storage.get("d");
  assert.equal(JSON.stringify(current), snapshot);
  assert.equal(fs.readFileSync(storage.spritePath("d"), "utf8"), file);
  assert.equal(current.version, version);
  assert.equal(events, 0);
  assert.equal(storage.history.get("d"), undefined);
  assert.throws(() => storage.undo("d"), /nothing to undo/);
});

test("failed animation-frame draw leaves the frame and base grid untouched", () => {
  const storage = tmpStorage();
  storage.create("d", 16, 16);
  withAnimation(storage, "d");
  const sprite = storage.get("d");
  const baseBefore = JSON.stringify(baseGrid(sprite));
  const frameBefore = JSON.stringify(sprite.animations.idle.frames[1]);
  const version = sprite.version;
  let events = 0;
  storage.onChange(() => events++);

  assert.throws(
    () => drawAndSave(storage, "d", { frame: { anim: "idle", index: 1 }, ops: failingOps }),
    /out of bounds/
  );

  assert.equal(JSON.stringify(baseGrid(sprite)), baseBefore);
  assert.equal(JSON.stringify(sprite.animations.idle.frames[1]), frameBefore);
  assert.equal(sprite.version, version);
  assert.equal(events, 0);
  assert.equal(storage.history.get("d"), undefined);
});

test("failed draw targeting a missing animation creates no history", () => {
  const storage = tmpStorage();
  storage.create("d", 16, 16);
  let events = 0;
  storage.onChange(() => events++);
  assert.throws(
    () => drawAndSave(storage, "d", { frame: { anim: "nope", index: 0 }, ops: validOps }),
    /no animation/
  );
  assert.equal(events, 0);
  assert.equal(storage.history.get("d"), undefined);
});

test("successful multi-op draw commits once: version, event, undo snapshot", () => {
  const storage = tmpStorage();
  const sprite = storage.create("d", 16, 16);
  const version = sprite.version;
  let events = 0;
  storage.onChange(() => events++);

  const { grid } = drawAndSave(storage, "d", { ops: validOps });

  assert.equal(grid[2][2], 5);
  assert.equal(grid[8][8], 9);
  assert.equal(sprite.version, version + 1);
  assert.equal(events, 1);
  assert.equal(storage.history.get("d").undo.length, 1);
  assert.equal(storage.history.get("d").redo.length, 0);
  assert.deepEqual(baseGrid(storage.get("d")), grid);
});

test("undo after a successful draw restores the whole pre-draw state", () => {
  const storage = tmpStorage();
  const sprite = storage.create("d", 16, 16);
  const before = JSON.stringify(baseGrid(sprite));
  drawAndSave(storage, "d", { ops: validOps });
  assert.notEqual(JSON.stringify(baseGrid(storage.get("d"))), before);

  const restored = storage.undo("d");
  assert.equal(JSON.stringify(baseGrid(restored)), before);
  assert.equal(baseGrid(restored)[2][2], 0);
  assert.equal(baseGrid(restored)[8][8], 0);
});

test("mirror applies to the staged grid and commits to the intended target", () => {
  const storage = tmpStorage();
  storage.create("d", 16, 16);
  drawAndSave(storage, "d", { ops: [{ type: "pixels", pixels: [{ x: 2, y: 5, color: 3 }] }], mirror: true });
  const base = storage.get("d");
  assert.equal(baseGrid(base)[5][2], 3);
  assert.equal(baseGrid(base)[5][13], 3);

  withAnimation(storage, "d");
  drawAndSave(storage, "d", {
    frame: { anim: "idle", index: 1 },
    ops: [{ type: "pixels", pixels: [{ x: 1, y: 1, color: 7 }] }],
    mirror: true,
  });
  assert.equal(storage.get("d").animations.idle.frames[1][1][1], 7);
  assert.equal(storage.get("d").animations.idle.frames[1][1][14], 7);
  assert.equal(baseGrid(storage.get("d"))[1][1], 0); // base not touched
});

test("stageDraw without commit never mutates the source grid", () => {
  const sprite = createSprite("s", 16, 16);
  baseGrid(sprite)[0][0] = 4;
  const before = JSON.stringify(baseGrid(sprite));
  const staged = stageDraw(sprite, undefined, [{ type: "rect", x: 2, y: 2, w: 2, h: 2, color: 7 }]);

  assert.equal(JSON.stringify(baseGrid(sprite)), before);
  assert.equal(baseGrid(sprite)[2][2], 0);
  assert.equal(staged.grid[2][2], 7);
  assert.notEqual(staged.grid, baseGrid(sprite));

  staged.commit();
  assert.equal(baseGrid(sprite)[2][2], 7);
  assert.equal(baseGrid(sprite)[0][0], 4);
});

test("stageDraw stages an animation frame without touching the original frame", () => {
  const sprite = createSprite("s", 16, 16);
  addAnimation(sprite, "run", 2, 8);
  sprite.animations.run.frames[1][3][3] = 6;
  const before = JSON.stringify(sprite.animations.run.frames[1]);
  const staged = stageDraw(sprite, { anim: "run", index: 1 }, [{ type: "rect", x: 0, y: 0, w: 1, h: 1, color: 2 }]);

  assert.equal(JSON.stringify(sprite.animations.run.frames[1]), before);
  staged.commit();
  assert.equal(sprite.animations.run.frames[1][0][0], 2);
  assert.equal(sprite.animations.run.frames[1][3][3], 6);
  assert.equal(baseGrid(sprite)[0][0], 0); // base unaffected
});
