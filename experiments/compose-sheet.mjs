// Compose the five 256px renders side by side over a checker background.
import fs from "node:fs";
import { PNG } from "pngjs";
import { renderPng } from "../src/render.js";

const files = {
  A: null, // rendered from sprite JSON below
  B: "exports/experiments/b-slime.png",
  C: "exports/experiments/c-slime.png",
  D: "exports/experiments/d-slime.png",
  E: "exports/experiments/e-slime-up.png",
};

const spriteA = JSON.parse(fs.readFileSync("sprites/exp-a-slime.json", "utf8"));
const imgs = {
  A: PNG.sync.read(renderPng(spriteA.grid, spriteA.palette, { scale: 8 })),
};
for (const [k, f] of Object.entries(files)) {
  if (f) imgs[k] = PNG.sync.read(fs.readFileSync(f));
}

const CELL = 256, GAP = 8, N = 5;
const sheet = new PNG({ width: N * CELL + (N - 1) * GAP, height: CELL });
const checker = (x, y) => ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 204 : 153);

for (let y = 0; y < sheet.height; y++) {
  for (let x = 0; x < sheet.width; x++) {
    let rgba = [checker(x, y), checker(x, y), checker(x, y), 255];
    const cell = Math.floor(x / (CELL + GAP));
    const lx = x - cell * (CELL + GAP);
    if (cell < N && lx < CELL) {
      const src = imgs["ABCDE"[cell]];
      const i = (y * CELL + lx) * 4;
      const sa = src.data[i + 3] / 255;
      if (sa > 0) {
        rgba = [
          Math.round(src.data[i] * sa + rgba[0] * (1 - sa)),
          Math.round(src.data[i + 1] * sa + rgba[1] * (1 - sa)),
          Math.round(src.data[i + 2] * sa + rgba[2] * (1 - sa)),
          255,
        ];
      }
    }
    const o = (y * sheet.width + x) * 4;
    sheet.data[o] = rgba[0]; sheet.data[o + 1] = rgba[1]; sheet.data[o + 2] = rgba[2]; sheet.data[o + 3] = 255;
  }
}
fs.writeFileSync("exports/experiments/sheet.png", PNG.sync.write(sheet));
console.log("wrote exports/experiments/sheet.png — order: A(baseline) B(code) C(hi-ops) D(downsample) E(procedural)");
