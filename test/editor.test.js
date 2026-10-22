import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSprite, applyOps, addAnimation, insertFrame, deleteFrame, moveFrame, setFps } from "../src/model.js";
import { Storage } from "../src/storage.js";

function tmpStorage() {
  return new Storage(fs.mkdtempSync(path.join(os.tmpdir(), "sprite-test-")));
}

test("fill flood-fills a connected region only", () => {
  const s = createSprite("t", 16, 16);
  // two separate regions of color 5
  applyOps(s, s.grid, [
    { type: "rect", x: 2, y: 2, w: 3, h: 3, color: 5 },
    { type: "rect", x: 10, y: 10, w: 2, h: 2, color: 5 },
  ]);
  applyOps(s, s.grid, [{ type: "fill", x: 3, y: 3, color: 9 }]);
  assert.equal(s.grid[2][2], 9);
  assert.equal(s.grid[4][4], 9);
  // second region untouched
  assert.equal(s.grid[10][10], 5);
  // fill to transparent works
  applyOps(s, s.grid, [{ type: "fill", x: 10, y: 10, color: 0 }]);
  assert.equal(s.grid[11][11], 0);
});

test("frame ops: insert/duplicate/delete/move with bounds", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [{ type: "pixels", pixels: [{ x: 0, y: 0, color: 7 }] }]);
  addAnimation(s, "run", 3, 10);

  insertFrame(s, "run", 0, true); // duplicate frame 0 after index 0
  assert.equal(s.animations.run.frames.length, 4);
  assert.equal(s.animations.run.frames[1][0][0], 7);

  insertFrame(s, "run", 1, false); // blank frame at index 2
  assert.equal(s.animations.run.frames[2][0][0], 0);

  moveFrame(s, "run", 4, 0); // 5 frames now; move last to front
  assert.equal(s.animations.run.frames.length, 5);

  deleteFrame(s, "run", 0);
  assert.equal(s.animations.run.frames.length, 4);

  assert.throws(() => moveFrame(s, "run", 0, 99), /out of range/);
  setFps(s, "run", 12);
  assert.equal(s.animations.run.fps, 12);
  assert.throws(() => setFps(s, "run", 0), /fps/);
  assert.throws(() => insertFrame(s, "nope", 0, false), /no animation/);
});

test("undo/redo restores snapshots and moves version forward", () => {
  const storage = tmpStorage();
  const s = storage.create("u", 16, 16);

  storage.beginEdit("u");
  applyOps(s, s.grid, [{ type: "pixels", pixels: [{ x: 1, y: 1, color: 3 }] }]);
  storage.save(s);
  assert.equal(s.grid[1][1], 3);

  const undone = storage.undo("u");
  assert.equal(undone.grid[1][1], 0);
  assert.ok(undone.version > s.version - 1); // versions move forward

  const redone = storage.redo("u");
  assert.equal(redone.grid[1][1], 3);

  assert.throws(() => storage.redo("u"), /nothing to redo/);
  storage.undo("u");
  assert.throws(() => storage.undo("u"), /nothing to undo/);

  // new edit clears the redo stack
  const cur = storage.get("u");
  storage.beginEdit("u");
  applyOps(cur, cur.grid, [{ type: "pixels", pixels: [{ x: 5, y: 5, color: 8 }] }]);
  storage.save(cur);
  assert.throws(() => storage.redo("u"), /nothing to redo/);
});
