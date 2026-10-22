// Export: sprite -> PNG sheet (strip or grid layout) + Aseprite-style JSON.

import fs from "node:fs";
import { PNG } from "pngjs";
import { parseColor } from "./render.js";

/**
 * Collect export frames: base sprite ("base" tag) + each animation's frames.
 * @returns {{ name: string, anim: string, index: number, fps: number, grid: number[][] }[]}
 */
function collectFrames(sprite, onlyAnim) {
  const out = [];
  if (!onlyAnim) out.push({ name: sprite.name, anim: "base", index: 0, fps: 0, grid: sprite.grid });
  for (const [animName, anim] of Object.entries(sprite.animations)) {
    if (onlyAnim && animName !== onlyAnim) continue;
    anim.frames.forEach((grid, index) => {
      out.push({ name: sprite.name, anim: animName, index, fps: anim.fps, grid });
    });
  }
  return out;
}

/**
 * @param {object} sprite
 * @param {{ layout?: "strip"|"grid", anim?: string }} opts
 *   strip: all collected frames in one horizontal row
 *   grid:  one row per animation (base = first row)
 * @returns {{ pngPath: string, jsonPath: string, frames: object[] }}
 */
export function exportSprite(sprite, storage, opts = {}) {
  const layout = opts.layout ?? "grid";
  const frames = collectFrames(sprite, opts.anim);
  if (frames.length === 0) throw new Error("nothing to export — no base sprite / animation frames");

  const { width: w, height: h } = sprite;
  const colors = sprite.palette.map(parseColor);

  // Group into rows for grid layout
  let rows;
  if (layout === "strip") {
    rows = [frames];
  } else {
    const byAnim = new Map();
    for (const f of frames) {
      if (!byAnim.has(f.anim)) byAnim.set(f.anim, []);
      byAnim.get(f.anim).push(f);
    }
    rows = [...byAnim.values()];
  }
  const cols = Math.max(...rows.map((r) => r.length));

  const png = new PNG({ width: cols * w, height: rows.length * h, fill: true });
  // leave background fully transparent in exports (no checkerboard)
  png.data.fill(0);

  const jsonFrames = [];
  const frameTags = [];
  rows.forEach((row, rowIdx) => {
    row.forEach((f, colIdx) => {
      const x0 = colIdx * w;
      const y0 = rowIdx * h;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = colors[f.grid[y][x]];
          if (!c) continue;
          const idx = ((y0 + y) * png.width + (x0 + x)) * 4;
          png.data[idx] = c[0];
          png.data[idx + 1] = c[1];
          png.data[idx + 2] = c[2];
          png.data[idx + 3] = c[3];
        }
      }
      jsonFrames.push({
        filename: `${sprite.name} ${f.anim} ${f.index}`,
        frame: { x: x0, y: y0, w, h },
        duration: f.fps ? Math.round(1000 / f.fps) : 100,
      });
    });
    frameTags.push({
      name: row[0].anim,
      from: jsonFrames.length - row.length,
      to: jsonFrames.length - 1,
      direction: "forward",
    });
  });

  const base = `${sprite.name}${opts.anim ? `-${opts.anim}` : ""}`;
  const pngPath = storage.exportPath(`${base}.png`);
  const jsonPath = storage.exportPath(`${base}.json`);
  fs.writeFileSync(pngPath, PNG.sync.write(png));
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        frames: jsonFrames,
        meta: {
          app: "sprite-studio",
          size: { w: png.width, h: png.height },
          frameTags,
        },
      },
      null,
      2
    )
  );
  return { pngPath, jsonPath, frames: jsonFrames };
}
