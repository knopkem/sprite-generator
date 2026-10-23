// Approach E: what the "build a platformer" LLM actually does — direct RGBA
// per-pixel code, no sprite model, no palette constraint, free anti-aliasing.
import fs from "node:fs";
import { PNG } from "pngjs";

const S = 32;
const png = new PNG({ width: S, height: S });

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (e0, e1, v) => { const t = clamp01((v - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

const CX = 15.5, CY = 17.5, RX = 10.2, RY = 8.2;
const dome = (x, y) => Math.hypot((x - CX) / RX, (y - CY) / RY); // <1 inside
const base = (x, y) => Math.min(Math.min(x - 7, 24 - x), Math.min(y - 23, 26 - y)); // >0 inside

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const px = x + 0.5, py = y + 0.5;
    // silhouette coverage with AA on both shapes (union = max coverage)
    const cov = Math.max(
      1 - smooth(0.985, 1.02, dome(px, py)),
      smooth(-0.35, 0.35, base(px, py))
    );
    if (cov <= 0) continue;

    const nx = (px - CX) / RX, ny = (py - CY) / RY;
    const lam = clamp01(0.55 + 0.55 * (-0.6 * nx - 0.75 * ny));
    // hue-shifted shading: teal shadows -> yellow-green highlights (unconstrained)
    let col = mix([24, 96, 104], [150, 228, 92], lam);
    if (py > 24) col = mix(col, [20, 70, 80], 0.5 * smooth(24, 27, py)); // grounded base

    // glossy specular
    const d2 = ((px - 10) / 3.2) ** 2 + ((py - 11.5) / 2.4) ** 2;
    col = mix(col, [235, 255, 220], Math.exp(-d2 * 1.8) * 0.85);

    // eyes with AA
    for (const ex of [11.5, 19.5]) {
      const ed = Math.hypot((px - ex) / 2.1, (py - 17) / 3.1);
      const ec = 1 - smooth(0.95, 1.06, ed);
      col = mix(col, [22, 24, 40], ec);
      const sd = Math.hypot(px - (ex - 0.8), py - 15.2);
      col = mix(col, [255, 255, 255], 1 - smooth(0.35, 0.65, sd));
    }

    // dark outline via coverage falloff (narrow band = crisper edge)
    const outline = smooth(0.8, 0.97, cov);
    col = mix([18, 20, 34], col, outline);

    const i = (y * S + x) * 4;
    png.data[i] = Math.round(col[0]);
    png.data[i + 1] = Math.round(col[1]);
    png.data[i + 2] = Math.round(col[2]);
    png.data[i + 3] = Math.round(255 * clamp01(cov * 3));
  }
}

fs.mkdirSync("exports/experiments", { recursive: true });
fs.writeFileSync("exports/experiments/e-slime.png", PNG.sync.write(png));

// nearest-neighbor upscale for viewing at the same size as the other renders
const UP = 8;
const big = new PNG({ width: S * UP, height: S * UP });
for (let y = 0; y < big.height; y++) for (let x = 0; x < big.width; x++) {
  const si = (Math.floor(y / UP) * S + Math.floor(x / UP)) * 4;
  const di = (y * big.width + x) * 4;
  for (let k = 0; k < 4; k++) big.data[di + k] = png.data[si + k];
}
fs.writeFileSync("exports/experiments/e-slime-up.png", PNG.sync.write(big));
console.log("wrote exports/experiments/e-slime.png (+ up)");
