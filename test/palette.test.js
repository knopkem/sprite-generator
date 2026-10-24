import test from "node:test";
import assert from "node:assert/strict";
import { createSprite, applyOps } from "../src/model.js";
import { suggestOutlineIndex, rampTripleSuggestions, organizePalette } from "../src/palette.js";
import { generateSprite } from "../src/generate.js";
import { parseColor } from "../src/render.js";

const luminance = (hex) => {
  const [r, g, b] = parseColor(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test("suggestOutlineIndex picks the lowest-luminance opaque color", () => {
  assert.equal(suggestOutlineIndex(["#00000000", "#ffffff", "#202020", "#404040"]), 2);
  // index 1 (light) is not a safe outline default
  assert.equal(suggestOutlineIndex(["#00000000", "#f0f0f0", "#101010", "#505050"]), 2);
  // fully transparent entries are ignored
  assert.equal(suggestOutlineIndex(["#00000000", "#00000000", "#ffffff"]), 2);
  // otherwise empty palette falls back to 1
  assert.equal(suggestOutlineIndex(["#00000000"]), 1);
  assert.equal(suggestOutlineIndex([]), 1);
});

test("rampTripleSuggestions only yields real three-stop ramps", () => {
  assert.deepEqual(rampTripleSuggestions({ name: "x", from: 5, to: 5 }), []);
  assert.deepEqual(rampTripleSuggestions({ name: "x", from: 5, to: 6 }), []);
  assert.deepEqual(rampTripleSuggestions({ name: "x", from: 5, to: 7 }), [[5, 6, 7]]);
  assert.deepEqual(rampTripleSuggestions({ name: "x", from: 5, to: 8 }), [[5, 6, 7], [6, 7, 8]]);
});

test("outline op defaults to sprite.outlineIndex; explicit color wins; legacy defaults to 1", () => {
  const s = createSprite("t", 16, 16);
  assert.equal(s.outlineIndex, 1);
  s.outlineIndex = 7;
  applyOps(s, s.grid, [{ type: "rect", x: 4, y: 4, w: 2, h: 2, color: 14 }, { type: "outline" }]);
  assert.equal(s.grid[3][4], 7);

  applyOps(s, s.grid, [{ type: "outline", color: 9 }]);
  assert.equal(s.grid[2][4], 9);

  const legacy = createSprite("legacy", 16, 16);
  delete legacy.outlineIndex;
  applyOps(legacy, legacy.grid, [{ type: "rect", x: 4, y: 4, w: 2, h: 2, color: 14 }, { type: "outline" }]);
  assert.equal(legacy.grid[3][4], 1);

  // a palette with index 1 light must not become an accidental light outline
  const { sprite: generated } = generateSprite({
    name: "gen-outline",
    gridSize: 16,
    scale: 2,
    colors: 5,
    code: `
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (x < W / 2) px(x, y, [240, 220, 210]);   // light, dominant
        else if (x < W * 0.75) px(x, y, [180, 140, 120]);
        else px(x, y, [60, 40, 35]);                // darkest
      }
    `,
  });
  const idx = generated.outlineIndex;
  assert.ok(idx >= 1 && idx < generated.palette.length);
  let darkest = 1;
  for (let i = 1; i < generated.palette.length; i++) {
    if (luminance(generated.palette[i]) < luminance(generated.palette[darkest])) darkest = i;
  }
  assert.equal(idx, darkest);
  assert.ok(luminance(generated.palette[idx]) < luminance(generated.palette[1]));
  // grid remapping still points at the organized palette
  for (const row of generated.grid) {
    for (const v of row) assert.ok(v >= 0 && v < generated.palette.length);
  }
});

test("organizePalette is importable from palette.js and still used by generate.js", () => {
  const { palette, families } = organizePalette(["#cc3333", "#888888"], [5, 1]);
  assert.equal(palette[0], "#00000000");
  assert.equal(families.length, 2);
});
