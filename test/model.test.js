import test from "node:test";
import assert from "node:assert/strict";
import { encodeGrid, decodeGrid, encodeRow, decodeRow } from "../src/rle.js";
import { createSprite, applyOps, targetGrid, mirrorHorizontal, addAnimation, copyFrame } from "../src/model.js";

test("rle row roundtrip", () => {
  const row = [0, 0, 3, 3, 3, 0, 0, 0];
  assert.equal(encodeRow(row), "2:0,3:3,3:0");
  assert.deepEqual(decodeRow("2:0,3:3,3:0", 8), row);
});

test("rle grid roundtrip", () => {
  const grid = [
    [0, 0, 0, 0],
    [0, 5, 5, 0],
    [1, 1, 1, 1],
  ];
  const rle = encodeGrid(grid);
  assert.equal(rle, "4:0;1:0,2:5,1:0;4:1");
  assert.deepEqual(decodeGrid(rle, 4, 3), grid);
});

test("decodeRow rejects wrong width and malformed runs", () => {
  assert.throws(() => decodeRow("2:0,2:0", 8), /expected width 8/);
  assert.throws(() => decodeRow("x:0", 8), /malformed run/);
  assert.throws(() => decodeRow("0:3,8:0", 8), /zero count/);
});

test("createSprite validates name and size", () => {
  assert.throws(() => createSprite("bad name!", 16, 16), /invalid sprite name/);
  assert.throws(() => createSprite("ok", 20, 20), /grid size/);
  const s = createSprite("wiz", 32, 32);
  assert.equal(s.grid.length, 32);
  assert.equal(s.palette[0], "#00000000");
});

test("applyOps rows + rect + pixels + clear", () => {
  const s = createSprite("t", 16, 16);
  const grid = s.grid;
  applyOps(s, grid, [{ type: "rows", rows: "3:0,2:5,11:0", y: 4 }]);
  assert.equal(grid[4][3], 5);
  assert.equal(grid[4][4], 5);
  assert.equal(grid[4][5], 0);

  applyOps(s, grid, [{ type: "rect", x: 0, y: 0, w: 2, h: 2, color: 7 }]);
  assert.equal(grid[1][1], 7);

  applyOps(s, grid, [{ type: "pixels", pixels: [{ x: 15, y: 15, color: 2 }] }]);
  assert.equal(grid[15][15], 2);

  applyOps(s, grid, [{ type: "clear" }]);
  assert.equal(grid[1][1], 0);
  assert.equal(grid[15][15], 0);
});

test("applyOps validates color, bounds, pixel batch size", () => {
  const s = createSprite("t", 16, 16);
  assert.throws(() => applyOps(s, s.grid, [{ type: "rect", x: 0, y: 0, w: 1, h: 1, color: 99 }]), /out of palette range/);
  assert.throws(() => applyOps(s, s.grid, [{ type: "rect", x: 15, y: 0, w: 2, h: 1, color: 1 }]), /out of bounds/);
  assert.throws(
    () => applyOps(s, s.grid, [{ type: "pixels", pixels: Array.from({ length: 513 }, (_, i) => ({ x: 0, y: 0, color: 1, i })) }]),
    /exceeds limit/
  );
  assert.throws(() => applyOps(s, s.grid, [{ type: "rows", rows: "16:1", y: 16 }]), /exceed grid height/);
});

test("mirrorHorizontal mirrors left to right", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [{ type: "pixels", pixels: [{ x: 2, y: 5, color: 3 }] }]);
  mirrorHorizontal(s, s.grid);
  assert.equal(s.grid[5][13], 3);
});

test("outline wraps opaque pixels without cascading", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [
    { type: "rect", x: 4, y: 4, w: 3, h: 3, color: 14 },
    { type: "outline" },
  ]);
  // orthogonal neighbors outlined with default color 1
  assert.equal(s.grid[3][5], 1); // above
  assert.equal(s.grid[7][5], 1); // below
  assert.equal(s.grid[5][3], 1); // left
  assert.equal(s.grid[5][7], 1); // right
  // diagonal untouched without diagonals flag
  assert.equal(s.grid[3][3], 0);
  // interior preserved
  assert.equal(s.grid[5][5], 14);
  // outline does not cascade beyond 1px
  assert.equal(s.grid[2][5], 0);
});

test("outline scope:new only wraps pixels added in the same call", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [
    { type: "rect", x: 2, y: 2, w: 3, h: 3, color: 14 },
    { type: "outline" },
  ]);
  assert.equal(s.grid[1][1], 0); // diagonal of old silhouette, untouched
  // second pass: grow a 1px stalk on top, then outline only the growth
  applyOps(s, s.grid, [
    { type: "pixels", pixels: [{ x: 3, y: 0, color: 14 }] },
    { type: "outline", scope: "new" },
  ]);
  assert.equal(s.grid[0][2], 1); // left of stalk
  assert.equal(s.grid[0][4], 1); // right of stalk
  assert.equal(s.grid[1][1], 0); // old silhouette NOT re-wrapped
  // contrast: scope "all" wraps everything, including old outline's diagonals
  applyOps(s, s.grid, [{ type: "outline" }]);
  assert.equal(s.grid[1][1], 1);
});

test("curve bends a quadratic bezier toward the control point", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [{ type: "curve", x0: 2, y0: 2, cx: 8, cy: 8, x1: 14, y1: 2, color: 5 }]);
  assert.equal(s.grid[2][2], 5); // start endpoint
  assert.equal(s.grid[2][14], 5); // end endpoint
  assert.equal(s.grid[5][8], 5); // apex: t=0.5 -> (8, 5)
  assert.equal(s.grid[2][8], 0); // straight-line midpoint stays empty
});

test("curve paints with thickness and validates endpoints", () => {
  const s = createSprite("t", 16, 16);
  assert.throws(
    () => applyOps(s, s.grid, [{ type: "curve", x0: -1, y0: 0, cx: 4, cy: 4, x1: 8, y1: 0, color: 1 }]),
    /out of bounds/
  );
  applyOps(s, s.grid, [{ type: "curve", x0: 1, y0: 14, cx: 8, cy: 10, x1: 14, y1: 14, color: 3, thickness: 2 }]);
  // apex at t=0.5 -> (7.75, 12) rounds to (8,12); 2px brush offsets +x/+y
  assert.equal(s.grid[12][8], 3);
  assert.equal(s.grid[13][9], 3);
});

test("curve tolerates an off-grid control point (shallow arc, clipped paint)", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [{ type: "curve", x0: 1, y0: 1, cx: 8, cy: -6, x1: 14, y1: 1, color: 2 }]);
  assert.equal(s.grid[1][1], 2);
  assert.equal(s.grid[1][14], 2);
  assert.equal(s.grid[0][8], 0); // arc apex is above the grid, nothing painted at top
});

test("shift translates grid and drops off-grid pixels", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [
    { type: "pixels", pixels: [{ x: 2, y: 2, color: 5 }, { x: 15, y: 0, color: 6 }] },
    { type: "shift", dx: 1, dy: 2 },
  ]);
  assert.equal(s.grid[4][3], 5);
  assert.equal(s.grid[2][2], 0);
  assert.equal(s.grid[2][15], 0); // x=15 shifted off-grid, dropped
  assert.equal(s.grid.flat().filter((v) => v === 6).length, 0);
});

test("animations: add, target frame, copy", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [{ type: "pixels", pixels: [{ x: 1, y: 1, color: 4 }] }]);
  addAnimation(s, "run", 4, 10);
  assert.equal(s.animations.run.frames.length, 4);
  // frame 0 is a copy of base
  assert.equal(s.animations.run.frames[0][1][1], 4);
  // frames 1+ blank
  assert.equal(s.animations.run.frames[1][1][1], 0);

  copyFrame(s, "run", 0, 2);
  assert.equal(s.animations.run.frames[2][1][1], 4);

  const g = targetGrid(s, { anim: "run", index: 3 });
  applyOps(s, g, [{ type: "pixels", pixels: [{ x: 8, y: 8, color: 9 }] }]);
  assert.equal(s.animations.run.frames[3][8][8], 9);

  assert.throws(() => addAnimation(s, "run", 4, 10), /already exists/);
  assert.throws(() => targetGrid(s, { anim: "nope", index: 0 }), /no animation/);
  assert.throws(() => copyFrame(s, "run", 0, 9), /out of range/);
});

test("litEllipse shades by light direction, allows fractional centers", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [{ type: "litEllipse", cx: 7.5, cy: 7.5, rx: 6, ry: 6, ramp: [13, 14, 15] }]);
  const g = s.grid;
  assert.equal(g[4][4], 13); // top-left interior = lit (default light is top-left)
  assert.equal(g[7][7], 14); // center = mid
  assert.equal(g[11][11], 15); // bottom-right = shadow
  assert.equal(g[0][0], 0); // outside the ellipse = untouched
});

test("litEllipse validates ramp colors", () => {
  const s = createSprite("t", 16, 16);
  assert.throws(
    () => applyOps(s, s.grid, [{ type: "litEllipse", cx: 8, cy: 8, rx: 4, ry: 4, ramp: [1, 2, 99] }]),
    /out of palette range/
  );
});

test("rampRect paints v/h gradients and validates bounds and colors", () => {
  const s = createSprite("t", 16, 16);
  applyOps(s, s.grid, [{ type: "rampRect", x: 2, y: 2, w: 4, h: 4, ramp: [5, 6, 7] }]);
  const g = s.grid;
  assert.equal(g[2][2], 5); // top rows map to ramp[0]
  assert.equal(g[3][2], 5);
  assert.equal(g[4][2], 6);
  assert.equal(g[5][2], 7); // bottom row maps to ramp[2]

  applyOps(s, s.grid, [{ type: "rampRect", x: 8, y: 8, w: 4, h: 2, ramp: [1, 2], dir: "h" }]);
  assert.equal(g[8][8], 1); // left half = ramp[0]
  assert.equal(g[8][9], 1);
  assert.equal(g[8][10], 2); // right half = ramp[1]
  assert.equal(g[9][10], 2); // spans all rows

  assert.throws(() => applyOps(s, s.grid, [{ type: "rampRect", x: 14, y: 0, w: 4, h: 1, ramp: [1, 2] }]), /out of bounds/);
  assert.throws(() => applyOps(s, s.grid, [{ type: "rampRect", x: 0, y: 0, w: 2, h: 2, ramp: [1, 99] }]), /out of palette range/);
});
