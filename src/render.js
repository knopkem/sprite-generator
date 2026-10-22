// PNG rendering: palette-indexed grid -> upscaled RGBA PNG buffer.
// Uses pngjs (pure JS, no native deps).

import { PNG } from "pngjs";

/** Parse #rrggbb or #rrggbbaa into [r,g,b,a]. Index 0 / fully transparent -> null. */
export function parseColor(hex) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  const a = m[2] ? parseInt(m[2], 16) : 255;
  if (a === 0) return null;
  return [r, g, b, a];
}

function checkerColor(x, y) {
  const on = (Math.floor(x) + Math.floor(y)) % 2 === 0;
  return on ? [204, 204, 204, 255] : [153, 153, 153, 255];
}

function blend(dst, src) {
  // src over dst, both [r,g,b,a]
  const sa = src[3] / 255;
  const da = dst[3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA === 0) return [0, 0, 0, 0];
  return [
    Math.round((src[0] * sa + dst[0] * da * (1 - sa)) / outA),
    Math.round((src[1] * sa + dst[1] * da * (1 - sa)) / outA),
    Math.round((src[2] * sa + dst[2] * da * (1 - sa)) / outA),
    Math.round(outA * 255),
  ];
}

/**
 * Render a grid to a PNG buffer.
 * @param {number[][]} grid
 * @param {string[]} palette
 * @param {{ scale?: number, grid?: boolean }} opts
 *   scale: integer pixel scale (default: auto to ~512px)
 *   grid: draw coordinate grid lines when scale >= 8
 */
export function renderPng(grid, palette, opts = {}) {
  const height = grid.length;
  const width = grid[0].length;
  const scale = opts.scale ?? Math.max(1, Math.floor(512 / Math.max(width, height)));
  const colors = palette.map(parseColor);

  const png = new PNG({ width: width * scale, height: height * scale });
  for (let py = 0; py < png.height; py++) {
    for (let px = 0; px < png.width; px++) {
      const gx = Math.floor(px / scale);
      const gy = Math.floor(py / scale);
      let rgba = checkerColor(px / 8, py / 8);
      const c = colors[grid[gy][gx]];
      if (c) rgba = blend(rgba, c);
      if (opts.grid && scale >= 8 && (px % scale === 0 || py % scale === 0)) {
        rgba = blend(rgba, [60, 60, 60, 90]);
      }
      const idx = (py * png.width + px) * 4;
      png.data[idx] = rgba[0];
      png.data[idx + 1] = rgba[1];
      png.data[idx + 2] = rgba[2];
      png.data[idx + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png);
}

/**
 * Onion-skin composite: prev frame (red tint), current (full), next (blue tint).
 * @param {number[][][]} frames - array of grids; index 1 is "current"
 */
export function renderOnionSkin(frames, palette, opts = {}) {
  const [prev, current, next] = frames;
  const height = current.length;
  const width = current[0].length;
  const scale = opts.scale ?? Math.max(1, Math.floor(512 / Math.max(width, height)));
  const colors = palette.map(parseColor);

  const tint = (c, [tr, tg, tb], alpha) =>
    c ? [Math.round(c[0] * 0.5 + tr * 0.5), Math.round(c[1] * 0.5 + tg * 0.5), Math.round(c[2] * 0.5 + tb * 0.5), Math.round(c[3] * alpha)] : null;

  const png = new PNG({ width: width * scale, height: height * scale });
  for (let py = 0; py < png.height; py++) {
    for (let px = 0; px < png.width; px++) {
      const gx = Math.floor(px / scale);
      const gy = Math.floor(py / scale);
      let rgba = checkerColor(px / 8, py / 8);
      if (prev) {
        const c = tint(colors[prev[gy][gx]], [255, 60, 60], 0.35);
        if (c) rgba = blend(rgba, c);
      }
      if (next) {
        const c = tint(colors[next[gy][gx]], [60, 60, 255], 0.35);
        if (c) rgba = blend(rgba, c);
      }
      const c = colors[current[gy][gx]];
      if (c) rgba = blend(rgba, c);
      const idx = (py * png.width + px) * 4;
      png.data[idx] = rgba[0];
      png.data[idx + 1] = rgba[1];
      png.data[idx + 2] = rgba[2];
      png.data[idx + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png);
}
