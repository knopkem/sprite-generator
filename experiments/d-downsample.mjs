// Approach D: LLM authors a smooth 128x128 RGBA raster (gradients, AA, no
// palette worries), then reference.js's resizeAvg crunches it to 32x32 and a
// nearest-color step quantizes onto DEFAULT_PALETTE.
import fs from "node:fs";
import { PNG } from "pngjs";
import { createSprite, applyOps, DEFAULT_PALETTE } from "../src/model.js";
import { renderPng, parseColor } from "../src/render.js";
import { resizeAvg } from "../src/reference.js";

const S = 128;
const png = new PNG({ width: S, height: S });

// palette greens as RGB stops for the smooth gradient
const LIGHT = [167, 240, 112], MID = [56, 183, 100], DARK = [37, 113, 121];
const INK = [26, 28, 44], WHITE = [244, 244, 244];

const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function ramp(t) { // 0 = dark, 0.5 = mid, 1 = light
  return t < 0.5 ? lerp(DARK, MID, t * 2) : lerp(MID, LIGHT, (t - 0.5) * 2);
}

const CX = 62, CY = 70, RX = 41, RY = 33;
const inDome = (x, y) => ((x - CX) / RX) ** 2 + ((y - CY) / RY) ** 2 <= 1;
const inBase = (x, y) => x >= 28 && x <= 96 && y >= 92 && y <= 104;
const inBody = (x, y) => inDome(x, y) || inBase(x, y);

// silhouette mask first (for outline + AA edges)
const mask = [];
for (let y = 0; y < S; y++) { mask.push([]); for (let x = 0; x < S; x++) mask[y][x] = inBody(x, y); }
const nearBody = (x, y) => {
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const yy = y + dy, xx = x + dx;
    if (yy >= 0 && yy < S && xx >= 0 && xx < S && mask[yy][xx] && dx * dx + dy * dy <= 9) return true;
  }
  return false;
};

const put = (x, y, [r, g, b], a = 255) => {
  const i = (y * S + x) * 4;
  png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a;
};

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (mask[y][x]) {
      const nx = (x - CX) / RX, ny = (y - CY) / RY;
      const lam = -0.6 * nx - 0.75 * ny;
      let t = Math.max(0, Math.min(1, 0.50 + 0.62 * lam));
      if (y > 88) t *= 0.45; // ground the base
      let col = ramp(t);
      // glossy specular, gaussian falloff toward white
      const d2 = ((x - 38) / 12) ** 2 + ((y - 46) / 8) ** 2;
      const spec = Math.exp(-d2 * 2.6);
      col = lerp(col, LIGHT, Math.min(1, spec * 1.6));
      if (d2 < 0.10) col = lerp(col, WHITE, 0.9);
      put(x, y, col);
    } else {
      put(x, y, [0, 0, 0], 0);
    }
  }
}
// eyes: bigger and harder-edged so they survive the 4x crunch
for (const ex of [46, 80]) {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (((x - ex) / 9.5) ** 2 + ((y - 68) / 13.5) ** 2 <= 1) put(x, y, INK);
  }
}

// crunch: 128 -> 32. Alpha-weighted average: rgb averaged over the block's
// alpha (transparent black must not darken edge pixels), alpha = mean alpha.
function resizeAvgA(src, tw, th) {
  const out = new PNG({ width: tw, height: th });
  const sx = src.width / tw, sy = src.height / th;
  const px = (p, x, y) => { const i = (y * p.width + x) * 4; return [p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]]; };
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    let r = 0, g = 0, b = 0, a = 0, aw = 0;
    for (let yy = y0; yy < Math.min(y1, src.height); yy++) for (let xx = x0; xx < Math.min(x1, src.width); xx++) {
      const p = px(src, xx, yy);
      r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3]; aw += p[3];
    }
    const n = (Math.min(y1, src.height) - y0) * (Math.min(x1, src.width) - x0);
    const i = (y * tw + x) * 4;
    out.data[i] = aw ? Math.round(r / aw) : 0;
    out.data[i + 1] = aw ? Math.round(g / aw) : 0;
    out.data[i + 2] = aw ? Math.round(b / aw) : 0;
    out.data[i + 3] = Math.round(a / n);
  }
  return out;
}
const small = resizeAvgA(png, 32, 32);
const pal = DEFAULT_PALETTE.map((c) => parseColor(c) ?? [0, 0, 0, 0]);
const sprite = createSprite("exp-d-slime", 32, 32);
for (let y = 0; y < 32; y++) {
  for (let x = 0; x < 32; x++) {
    const i = (y * 32 + x) * 4;
    const r = small.data[i], g = small.data[i + 1], b = small.data[i + 2], a = small.data[i + 3];
    if (a < 128) { sprite.grid[y][x] = 0; continue; }
    let best = 1, bd = Infinity;
    for (let p = 1; p < pal.length; p++) {
      const d = (pal[p][0] - r) ** 2 + (pal[p][1] - g) ** 2 + (pal[p][2] - b) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    sprite.grid[y][x] = best;
  }
}

// post-pass at target resolution: crisp outline + eye sparkles
applyOps(sprite, sprite.grid, [
  { type: "outline", color: 1 },
  { type: "pixels", pixels: [{ x: 10, y: 15, color: 2 }, { x: 19, y: 15, color: 2 }] },
]);

fs.mkdirSync("exports/experiments", { recursive: true });
fs.writeFileSync("exports/experiments/d-slime.png", renderPng(sprite.grid, sprite.palette, { scale: 8 }));
fs.writeFileSync("exports/experiments/d-slime-big.png", PNG.sync.write(png)); // the 128px source
console.log("wrote exports/experiments/d-slime.png (+ d-slime-big.png source)");
