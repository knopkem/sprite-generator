import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSprite, applyOps, addAnimation, insertFrame, deleteFrame, moveFrame, setFps, resizeSprite, contentBounds } from "../src/model.js";
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

test("resizeSprite grows bottom-centered and remaps all frames", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [{ type: "pixels", pixels: [{ x: 0, y: 15, color: 4 }, { x: 15, y: 0, color: 6 }] }]);
  addAnimation(s, "idle", 2, 5);
  resizeSprite(s, 32, 32);

  assert.equal(s.width, 32);
  assert.equal(s.height, 32);
  // x=0 -> 8, x=15 -> 23 (centered); y=15 -> 31, y=0 -> 16 (bottom-aligned)
  assert.equal(s.grid[31][8], 4);
  assert.equal(s.grid[16][23], 6);
  assert.equal(s.animations.idle.frames.length, 2);
  assert.equal(s.animations.idle.frames[0].length, 32);
  // animation frame 0 was a copy of the base, so it has the same pixel
  assert.equal(s.animations.idle.frames[0][31][8], 4);

  // shrink back: crops the added margin
  resizeSprite(s, 16, 16);
  assert.equal(s.grid[15][0], 4);
  assert.throws(() => resizeSprite(s, 20, 20), /grid size/);
});

test("line draws horizontal, vertical, diagonal; thickness clips at edges", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [
    { type: "line", x0: 0, y0: 0, x1: 5, y1: 0, color: 1 }, // horizontal
    { type: "line", x0: 8, y0: 2, x1: 8, y1: 7, color: 2 }, // vertical
    { type: "line", x0: 10, y0: 10, x1: 14, y1: 14, color: 3 }, // diagonal
  ]);
  for (let x = 0; x <= 5; x++) assert.equal(s.grid[0][x], 1);
  for (let y = 2; y <= 7; y++) assert.equal(s.grid[y][8], 2);
  for (let i = 0; i <= 4; i++) assert.equal(s.grid[10 + i][10 + i], 3);

  // thick line near the edge must not throw, spillover clipped
  applyOps(s, s.grid, [{ type: "line", x0: 0, y0: 0, x1: 0, y1: 3, color: 4, thickness: 2 }]);
  assert.equal(s.grid[2][0], 4);

  assert.throws(() => applyOps(s, s.grid, [{ type: "line", x0: 0, y0: 0, x1: 16, y1: 0, color: 1 }]), /out of bounds/);
});

test("ellipse filled and ring", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [{ type: "ellipse", cx: 8, cy: 8, rx: 3, ry: 2, color: 5 }]);
  assert.equal(s.grid[8][8], 5); // center filled
  assert.equal(s.grid[8][11], 5); // right edge
  assert.equal(s.grid[8][4], 0); // outside rx

  applyOps(s, s.grid, [{ type: "clear" }, { type: "ellipse", cx: 8, cy: 8, rx: 3, ry: 3, color: 6, filled: false }]);
  assert.equal(s.grid[8][11], 6); // ring boundary
  assert.equal(s.grid[8][8], 0); // interior hollow
});

test("block pastes variable-width RLE rows with bounds checks", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [{ type: "block", x: 4, y: 5, rows: "2:7,1:0,1:8;4:9" }]);
  assert.equal(s.grid[5][4], 7);
  assert.equal(s.grid[5][5], 7);
  assert.equal(s.grid[5][6], 0);
  assert.equal(s.grid[5][7], 8);
  assert.equal(s.grid[6][4], 9);
  assert.equal(s.grid[6][7], 9);

  assert.throws(() => applyOps(s, s.grid, [{ type: "block", x: 14, y: 0, rows: "3:1" }]), /exceeds grid width/);
  assert.throws(() => applyOps(s, s.grid, [{ type: "block", x: 0, y: 15, rows: "1:1;1:1" }]), /out of bounds/);
  assert.throws(() => applyOps(s, s.grid, [{ type: "block", x: 0, y: 0, rows: "x:1" }]), /block row 0/);
});

test("contentBounds measures headroom and handles empty grids", () => {
  const s = createSprite("t", 16, 16);
  assert.equal(contentBounds(s.grid), null);
  applyOps(s, s.grid, [{ type: "rect", x: 3, y: 4, w: 5, h: 6, color: 2 }]);
  assert.deepEqual(contentBounds(s.grid), { minX: 3, minY: 4, maxX: 7, maxY: 9 });
  // touching an edge shows up as 0 headroom for consumers of this helper
  applyOps(s, s.grid, [{ type: "pixels", pixels: [{ x: 15, y: 0, color: 1 }] }]);
  assert.deepEqual(contentBounds(s.grid), { minX: 3, minY: 0, maxX: 15, maxY: 9 });
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
