// Approach B: LLM writes procedural generator code; Node executes it against
// the real sprite model. Simulates a "run_script" MCP tool.
import fs from "node:fs";
import { createSprite, applyOps } from "../src/model.js";
import { renderPng } from "../src/render.js";

const sprite = createSprite("exp-b-slime", 32, 32);
const g = sprite.grid;
const set = (x, y, c) => { if (x >= 0 && x < 32 && y >= 0 && y < 32) g[y][x] = c; };

// ---------- generator (what the LLM would author) ----------
// Palette ramp: 13 = green light, 14 = green mid, 15 = green dark
const CX = 15.5, CY = 17.5, RX = 10.2, RY = 8.2;

const inDome = (x, y) => ((x - CX) / RX) ** 2 + ((y - CY) / RY) ** 2 <= 1;
const inBase = (x, y) => x >= 7 && x <= 24 && y >= 23 && y <= 26;
const inBody = (x, y) => inDome(x, y) || inBase(x, y);

for (let y = 0; y < 32; y++) {
  for (let x = 0; x < 32; x++) {
    if (!inBody(x, y)) continue;
    // direction from center, used as a cheap sphere normal
    const nx = (x - CX) / RX, ny = (y - CY) / RY;
    // light from top-left; lambert-ish term
    const lam = -0.6 * nx - 0.75 * ny;
    // vertical gradient so the base is always grounded
    const t = (y - 9) / 18; // 0 at dome top, ~1 at base bottom
    let c = 14;
    if (lam > 0.42) c = 13;                 // lit
    if (lam < -0.38 || t > 0.88) c = 15;    // shadow side / base
    // ordered dither at band boundaries to soften transitions
    if (Math.abs(lam - 0.42) < 0.10 && (x + y) % 2 === 0) c = 13;
    if (Math.abs(lam + 0.38) < 0.10 && (x + y) % 2 === 0) c = 15;
    set(x, y, c);
  }
}

// glossy specular: bright cluster + white core, offset toward the light
for (let y = 0; y < 32; y++) {
  for (let x = 0; x < 32; x++) {
    const d = ((x - 9.5) / 3.2) ** 2 + ((y - 11.5) / 2.2) ** 2;
    if (d <= 1 && inBody(x, y) && y < 14) set(x, y, 13);
    if (d <= 0.12) set(x, y, 2); // white hot spot
  }
}

// eyes: tall dark ovals with a white sparkle, symmetric by construction
for (const ex of [11.5, 19.5]) {
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (((x - ex) / 2.1) ** 2 + ((y - 17) / 3.1) ** 2 <= 1) set(x, y, 1);
    }
  }
  set(Math.round(ex) - 1, 15, 2); // sparkle
}
// ---------- end generator ----------

applyOps(sprite, g, [{ type: "outline", color: 1 }]);

fs.mkdirSync("exports/experiments", { recursive: true });
fs.writeFileSync("exports/experiments/b-slime.png", renderPng(g, sprite.palette, { scale: 8 }));
console.log("wrote exports/experiments/b-slime.png");
