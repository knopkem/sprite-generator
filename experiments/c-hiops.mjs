// Approach C: prototype high-level ops. The LLM authors a short declarative
// op list; each op encapsulates shading math. If this wins, these get
// upstreamed into model.js (applyOps case + zod schema + docs).
import fs from "node:fs";
import { createSprite, applyOps } from "../src/model.js";
import { renderPng } from "../src/render.js";

// --- prototype op implementations (would live in model.js) ---
function litEllipse(sprite, grid, op) {
  // Shaded ellipse: lambert term from `light` dir maps onto ramp [light, mid, dark].
  const [rl, rm, rd] = op.ramp;
  const [lx, ly] = op.light ?? [-0.6, -0.75];
  const lo = op.lo ?? -0.38, hi = op.hi ?? 0.42;
  for (let y = Math.max(0, Math.floor(op.cy - op.ry)); y <= Math.min(sprite.height - 1, Math.ceil(op.cy + op.ry)); y++) {
    for (let x = Math.max(0, Math.floor(op.cx - op.rx)); x <= Math.min(sprite.width - 1, Math.ceil(op.cx + op.rx)); x++) {
      const nx = (x - op.cx) / op.rx, ny = (y - op.cy) / op.ry;
      if (nx * nx + ny * ny > 1) continue;
      const lam = lx * nx + ly * ny;
      let c = lam > hi ? rl : lam < lo ? rd : rm;
      if (op.dither !== false) {
        if (Math.abs(lam - hi) < 0.1 && (x + y) % 2 === 0) c = rl;
        if (Math.abs(lam - lo) < 0.1 && (x + y) % 2 === 0) c = rd;
      }
      grid[y][x] = c;
    }
  }
}

function vRamp(sprite, grid, op) {
  // Vertical gradient across a rect, ramp[0] at top -> ramp[last] at bottom.
  const { x, y, w, h, ramp } = op;
  for (let dy = 0; dy < h; dy++) {
    const idx = Math.min(ramp.length - 1, Math.floor((dy / h) * ramp.length));
    for (let dx = 0; dx < w; dx++) grid[y + dy][x + dx] = ramp[idx];
  }
}

function applyHiOps(sprite, grid, ops) {
  for (const op of ops) {
    if (op.type === "litEllipse") litEllipse(sprite, grid, op);
    else if (op.type === "vRamp") vRamp(sprite, grid, op);
    else applyOps(sprite, grid, [op]);
  }
}

// --- the LLM-authored artifact: just this list ---
const OPS = [
  { type: "vRamp", x: 7, y: 23, w: 18, h: 4, ramp: [14, 14, 15, 15] },        // flat base
  { type: "litEllipse", cx: 15.5, cy: 17.5, rx: 10.2, ry: 8.2, ramp: [13, 14, 15] }, // shaded dome
  { type: "ellipse", cx: 10, cy: 12, rx: 3, ry: 2, color: 13 },               // specular
  { type: "pixels", pixels: [{ x: 9, y: 11, color: 2 }] },                    // hot spot
  { type: "ellipse", cx: 11, cy: 17, rx: 2, ry: 3, color: 1 },                // eyes
  { type: "ellipse", cx: 20, cy: 17, rx: 2, ry: 3, color: 1 },
  { type: "pixels", pixels: [{ x: 10, y: 15, color: 2 }, { x: 19, y: 15, color: 2 }] },
  { type: "outline", color: 1 },
];

const sprite = createSprite("exp-c-slime", 32, 32);
applyHiOps(sprite, sprite.grid, OPS);

fs.mkdirSync("exports/experiments", { recursive: true });
fs.writeFileSync("exports/experiments/c-slime.png", renderPng(sprite.grid, sprite.palette, { scale: 8 }));
console.log("wrote exports/experiments/c-slime.png");
