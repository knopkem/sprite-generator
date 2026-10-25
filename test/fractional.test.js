// Fractional-coordinate ops: integer params must remain byte-identical to the
// pre-coverage rasterizers (reference copies below), while any fractional
// param selects 8x8 coverage sampling.

import test from "node:test";
import assert from "node:assert/strict";
import { createSprite, applyOps, mirrorHorizontal } from "../src/model.js";

/** Bottom-layer grid (pre-layers sprites expose the same storage as .grid). */
const baseGrid = (sprite) => (sprite.grids ? sprite.grids.base : sprite.grid);

// --- reference copies of the legacy (pre-fractional) rasterizers -----------

function legacyLine(sprite, grid, op) {
  const th = op.thickness ?? 1;
  const off = Math.floor((th - 1) / 2);
  let [x0, y0] = [op.x0, op.y0];
  const dx = Math.abs(op.x1 - x0);
  const dy = -Math.abs(op.y1 - y0);
  const sx = x0 < op.x1 ? 1 : -1;
  const sy = y0 < op.y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    for (let oy = 0; oy < th; oy++) {
      for (let ox = 0; ox < th; ox++) {
        const px = x0 - off + ox;
        const py = y0 - off + oy;
        if (px >= 0 && px < sprite.width && py >= 0 && py < sprite.height) grid[py][px] = op.color;
      }
    }
    if (x0 === op.x1 && y0 === op.y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function legacyCurve(sprite, grid, op) {
  const th = op.thickness ?? 1;
  const off = Math.floor((th - 1) / 2);
  const { x0, y0, cx, cy, x1, y1 } = op;
  const approxLen = Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy);
  const steps = Math.max(8, Math.ceil(approxLen * 2));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    const px = Math.round(u * u * x0 + 2 * u * t * cx + t * t * x1);
    const py = Math.round(u * u * y0 + 2 * u * t * cy + t * t * y1);
    for (let oy = 0; oy < th; oy++) {
      for (let ox = 0; ox < th; ox++) {
        const bx = px - off + ox;
        const by = py - off + oy;
        if (bx >= 0 && bx < sprite.width && by >= 0 && by < sprite.height) grid[by][bx] = op.color;
      }
    }
  }
}

function legacyEllipse(sprite, grid, op) {
  const { cx, cy, rx, ry } = op;
  const inside = (x, y) => {
    const nx = (x - cx) / (rx + 0.5);
    const ny = (y - cy) / (ry + 0.5);
    return nx * nx + ny * ny <= 1;
  };
  for (let y = Math.max(0, cy - ry); y <= Math.min(sprite.height - 1, cy + ry); y++) {
    for (let x = Math.max(0, cx - rx); x <= Math.min(sprite.width - 1, cx + rx); x++) {
      if (!inside(x, y)) continue;
      if (op.filled === false) {
        const boundary = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
        if (!boundary) continue;
      }
      grid[y][x] = op.color;
    }
  }
}

function applyLegacy(op, size = 24) {
  const sprite = createSprite("legacy", size, size);
  const grid = baseGrid(sprite);
  if (op.type === "line") legacyLine(sprite, grid, op);
  else if (op.type === "curve") legacyCurve(sprite, grid, op);
  else legacyEllipse(sprite, grid, op);
  return grid;
}

function applyNew(op, size = 24) {
  const sprite = createSprite("new", size, size);
  applyOps(sprite, baseGrid(sprite), [op]);
  return baseGrid(sprite);
}

// --- characterization: integer params must not move -----------------------

test("integer line output is byte-identical to the legacy Bresenham rasterizer", () => {
  const cases = [];
  for (const thickness of [1, 2, 3, 4]) {
    cases.push(
      { type: "line", x0: 2, y0: 2, x1: 20, y1: 2, color: 5, thickness }, // horizontal
      { type: "line", x0: 5, y0: 1, x1: 5, y1: 20, color: 5, thickness }, // vertical
      { type: "line", x0: 2, y0: 2, x1: 18, y1: 18, color: 5, thickness }, // 45 deg
      { type: "line", x0: 1, y0: 3, x1: 21, y1: 9, color: 5, thickness }, // shallow
      { type: "line", x0: 21, y0: 9, x1: 1, y1: 3, color: 5, thickness } // reversed
    );
  }
  for (const op of cases) assert.deepEqual(applyNew(op), applyLegacy(op), JSON.stringify(op));
});

test("integer curve output is byte-identical to the legacy sampled rasterizer", () => {
  const cases = [
    { type: "curve", x0: 2, y0: 2, cx: 12, cy: 12, x1: 22, y1: 2, color: 6 },
    { type: "curve", x0: 3, y0: 18, cx: 12, cy: 2, x1: 20, y1: 18, color: 6, thickness: 2 },
    { type: "curve", x0: 1, y0: 1, cx: 12, cy: -8, x1: 22, y1: 1, color: 6 }, // off-grid control
    { type: "curve", x0: 4, y0: 4, cx: 20, cy: 4, x1: 20, y1: 20, color: 7, thickness: 4 },
  ];
  for (const op of cases) assert.deepEqual(applyNew(op), applyLegacy(op), JSON.stringify(op));
});

test("integer ellipse output is byte-identical to the legacy rasterizer", () => {
  const cases = [
    { type: "ellipse", cx: 12, cy: 12, rx: 7, ry: 5, color: 8 },
    { type: "ellipse", cx: 12, cy: 12, rx: 7, ry: 5, color: 8, filled: false },
    { type: "ellipse", cx: 5, cy: 6, rx: 1, ry: 1, color: 8 },
    { type: "ellipse", cx: 12, cy: 12, rx: 10, ry: 3, color: 8, filled: false },
    { type: "ellipse", cx: 20, cy: 2, rx: 8, ry: 8, color: 8 }, // clipped at the edge
  ];
  for (const op of cases) assert.deepEqual(applyNew(op), applyLegacy(op), JSON.stringify(op));
});

// --- fractional placement -------------------------------------------------

function paintedRows(grid) {
  const rows = new Map();
  grid.forEach((row, y) => {
    const xs = row.map((v, x) => (v !== 0 ? x : -1)).filter((x) => x >= 0);
    if (xs.length) rows.set(y, xs);
  });
  return rows;
}

test("fractional line places a one-pixel row and leaves neighbors empty", () => {
  // Coordinates are pixel-center based (like the legacy rasterizers), so a
  // line at y=2.2 covers row 2 and only grazes row 3; a line exactly at y=2.5
  // is equidistant from both rows and correctly covers each at 50%.
  const grid = applyNew({ type: "line", x0: 2.5, y0: 2.2, x1: 13.5, y1: 2.2, color: 5 });
  const rows = paintedRows(grid);
  assert.deepEqual([...rows.keys()], [2]);
  const xs = rows.get(2);
  assert.ok(xs.length >= 8, `expected a substantial run, got ${xs.join(",")}`);
  assert.equal(grid[1][8], 0);
  assert.equal(grid[3][8], 0);
});

test("a fractional line grazing a pixel below 50% coverage leaves it empty", () => {
  // Centerline at y=3.1 covers row 3 fully; row 2 only ~12% — must stay empty.
  const grid = applyNew({ type: "line", x0: 1, y0: 3.1, x1: 20, y1: 3.1, color: 5 });
  assert.equal(grid[3][10], 5);
  assert.equal(grid[2][10], 0);
  assert.equal(grid[4][10], 0);
});

test("fractional line is symmetric when endpoints are reversed", () => {
  const a = applyNew({ type: "line", x0: 2.5, y0: 4, x1: 18, y1: 11.5, color: 5, thickness: 2 });
  const b = applyNew({ type: "line", x0: 18, y0: 11.5, x1: 2.5, y1: 4, color: 5, thickness: 2 });
  assert.deepEqual(b, a);
});

test("fractional ellipse with a half-pixel center is mirror-symmetric", () => {
  const sprite = createSprite("sym", 16, 16);
  applyOps(sprite, baseGrid(sprite), [
    { type: "ellipse", cx: 7.5, cy: 7.5, rx: 5.5, ry: 3.5, color: 5 },
  ]);
  const original = JSON.stringify(baseGrid(sprite));
  mirrorHorizontal(sprite, baseGrid(sprite));
  assert.equal(JSON.stringify(baseGrid(sprite)), original);
});

test("fractional ellipse ring is one pixel thick with no fill leak", () => {
  const grid = applyNew({ type: "ellipse", cx: 7.5, cy: 7.5, rx: 6, ry: 6, color: 6, filled: false }, 16);
  assert.equal(grid[7][2], 6); // outer boundary
  assert.equal(grid[7][0], 0); // outside the outer ellipse
  assert.equal(grid[7][3], 0); // ring is 1px thick
  assert.equal(grid[7][7], 0); // hollow center
});

test("fractional curve apex lands between the integer outcomes", () => {
  const base = { type: "curve", x0: 3, y0: 11, x1: 13, y1: 11, color: 5 };
  const frac = applyNew({ ...base, cx: 8, cy: 1.5 }, 16);
  const low = applyNew({ ...base, cx: 8, cy: 1 }, 16);
  const high = applyNew({ ...base, cx: 8, cy: 2 }, 16);

  assert.equal(frac[11][3], 5); // start endpoint
  assert.equal(frac[11][13], 5); // end endpoint
  assert.equal(frac[6][8], 5); // apex y = 6.25
  assert.notDeepEqual(frac, low);
  assert.notDeepEqual(frac, high);
});

test("fractional thickness stays close to the legacy brush footprint", () => {
  const legacy = applyLegacy({ type: "line", x0: 2, y0: 2, x1: 20, y1: 10, color: 5, thickness: 2 });
  const frac = applyNew({ type: "line", x0: 2.5, y0: 2.5, x1: 20.5, y1: 10.5, color: 5, thickness: 2 });
  const count = (g) => g.flat().filter((v) => v === 5).length;
  const a = count(legacy);
  const b = count(frac);
  assert.ok(Math.abs(a - b) / a <= 0.25, `pixel counts drifted: legacy ${a}, fractional ${b}`);
});

test("fractional endpoints that round off-grid fail loudly", () => {
  const sprite = createSprite("t", 16, 16);
  assert.throws(
    () => applyOps(sprite, baseGrid(sprite), [{ type: "line", x0: 15.6, y0: 2, x1: 4, y1: 2, color: 1 }]),
    /rounds to \(16,2\), out of bounds/
  );
  assert.throws(
    () => applyOps(sprite, baseGrid(sprite), [{ type: "curve", x0: 2, y0: 2, cx: 8, cy: 8, x1: -0.6, y1: 2, color: 1 }]),
    /rounds to \(-1,2\)/
  );
});
