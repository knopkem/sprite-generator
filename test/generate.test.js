import test from "node:test";
import assert from "node:assert/strict";
import { runPainter, generateSprite, organizePalette } from "../src/generate.js";

test("generateSprite paints big, downsamples, quantizes into an indexed sprite", () => {
  const { sprite } = generateSprite({
    name: "gen-dot",
    gridSize: 16,
    scale: 2,
    colors: 4,
    code: `
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (Math.hypot(x - W / 2, y - H / 2) < W / 3) px(x, y, [255, 0, 0]);
      }
    `,
  });
  assert.equal(sprite.width, 16);
  assert.notEqual(sprite.grid[8][8], 0); // center of the disc is opaque
  assert.equal(sprite.grid[0][0], 0); // corner stays transparent
  assert.ok(sprite.palette.some((c) => c === "#ff0000")); // palette-indexed now
});

test("painter sandbox: no module/process access, hard CPU timeout", () => {
  assert.throws(() => runPainter(`require("fs")`, 8, 8), /not defined/);
  assert.throws(() => runPainter(`process.exit(1)`, 8, 8), /not defined/);
  assert.throws(() => runPainter(`while (true) {}`, 8, 8), /timed out/);
});

test("painter helpers: mix, over blends alpha, log is captured", () => {
  const { png, logs } = runPainter(
    `
    px(0, 0, mix([0, 0, 0], [100, 200, 300], 0.5));
    px(1, 0, [10, 10, 10]);
    over(1, 0, [20, 20, 20, 128]);
    log("clamp", clamp01(2), "smooth", smooth(0, 1, 0.5));
    `,
    4, 4, 1
  );
  assert.deepEqual([png.data[0], png.data[1], png.data[2]], [50, 100, 150]);
  // 20 at ~50% over opaque 10 -> ~15
  assert.ok(Math.abs(png.data[4] - 15) <= 1);
  assert.match(logs.join(" "), /clamp 1 smooth 0.5/);
});

test("rng is deterministic per seed", () => {
  const paint = (seed) =>
    runPainter(`for (let i = 0; i < 8; i++) px(i, 0, [Math.round(rng() * 255), 0, 0]);`, 8, 1, seed).png.data;
  assert.deepEqual(paint(7), paint(7));
  assert.notDeepEqual(paint(7), paint(8));
});

test("generateSprite validates gridSize, scale, colors; bad color arrays rejected", () => {
  const base = { name: "g", code: `px(0, 0, [1, 2, 3])` };
  assert.throws(() => generateSprite({ ...base, gridSize: 20 }), /gridSize/);
  assert.throws(() => generateSprite({ ...base, gridSize: 16, scale: 9 }), /scale/);
  assert.throws(() => generateSprite({ ...base, gridSize: 16, colors: 40 }), /colors/);
  assert.throws(() => generateSprite({ ...base, gridSize: 16, code: `px(0, 0, "red")` }), /color must be/);
});

test("generated palettes are organized into light->dark ramp families", () => {
  const { sprite } = generateSprite({
    name: "gen-ramps",
    gridSize: 16,
    scale: 2,
    colors: 6,
    code: `
      // three wide red bands (dominant) + one narrow blue band
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (x < W * 0.25) px(x, y, [255, 150, 150]);
        else if (x < W * 0.5) px(x, y, [204, 51, 51]);
        else if (x < W * 0.75) px(x, y, [102, 26, 26]);
        else px(x, y, [51, 85, 204]);
      }
    `,
  });
  const fams = sprite.rampFamilies;
  assert.equal(fams.length, 2);
  assert.equal(fams[0].name, "red"); // dominant family comes first
  assert.equal(fams[0].to - fams[0].from + 1, 3);
  assert.equal(fams[1].name, "blue");
  // light -> dark within the red family
  const lum = (i) => {
    const h = sprite.palette[i];
    return parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
  };
  assert.ok(lum(fams[0].from) > lum(fams[0].from + 1));
  assert.ok(lum(fams[0].from + 1) > lum(fams[0].from + 2));
  // grid indices point into the organized palette correctly
  assert.equal(sprite.grid[8][2], fams[0].from); // leftmost band = lightest red
  assert.equal(sprite.grid[8][6], fams[0].from + 1);
  assert.equal(sprite.grid[8][10], fams[0].from + 2);
  assert.equal(sprite.grid[8][13], fams[1].from); // blue band
});

test("organizePalette merges hue wrap-around (reds) and keeps a neutral family", () => {
  const { palette, families } = organizePalette(["#cc3333", "#dd2244", "#888888"], [10, 10, 5]);
  assert.equal(families.length, 2);
  const red = families.find((f) => f.name === "red");
  assert.equal(red.to - red.from + 1, 2); // hue 0 and hue ~349 in one family
  assert.ok(families.some((f) => f.name === "neutral"));
  assert.equal(palette[0], "#00000000");
  assert.equal(palette.length, 4);
});

test("organizePalette names browns as orange (brown = dark orange, hue ~20-45)", () => {
  const { families } = organizePalette(["#8a5a3c", "#76663d"], [1, 1]);
  assert.equal(families[0].name, "orange");
});
