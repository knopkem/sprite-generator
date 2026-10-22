// Sprite data model: pure operations on sprite objects, no I/O.
//
// Sprite shape:
// {
//   name, width, height,
//   palette: string[]            // hex colors, index 0 = transparent
//   grid: number[][]             // palette indices, [y][x]
//   animations: { [name]: { fps: number, frames: number[][][] } },
//   version: number
// }

import { decodeRow } from "./rle.js";

export const GRID_SIZES = [16, 24, 32, 48, 64];
export const MAX_PIXELS_PER_OP = 512;

export const DEFAULT_PALETTE = [
  "#00000000", // 0 transparent (required)
  "#1a1c2c",
  "#5d275d",
  "#b13e53",
  "#ef7d57",
  "#ffcd75",
  "#a7f070",
  "#38b764",
  "#257179",
  "#29366f",
  "#3b5dc9",
  "#41a6f6",
  "#73eff7",
  "#f4f4f4",
  "#94b0c2",
  "#566c86",
];

export function normalizeHex(hex) {
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex.trim());
  if (!m) throw new Error(`invalid hex color "${hex}", expected #rrggbb or #rrggbbaa`);
  return `#${m[1].toLowerCase()}${m[2] ? m[2].toLowerCase() : ""}`;
}

export function blankGrid(width, height) {
  return Array.from({ length: height }, () => new Array(width).fill(0));
}

export function createSprite(name, width, height) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`invalid sprite name "${name}": letters, digits, - and _ only`);
  }
  if (!GRID_SIZES.includes(width) || !GRID_SIZES.includes(height)) {
    throw new Error(`grid size must be one of ${GRID_SIZES.join("/")} (got ${width}x${height})`);
  }
  return {
    name,
    width,
    height,
    palette: [...DEFAULT_PALETTE],
    grid: blankGrid(width, height),
    animations: {},
    version: 1,
  };
}

/** Resolve which grid an operation targets: base grid or an animation frame. */
export function targetGrid(sprite, frame) {
  if (!frame) return sprite.grid;
  const anim = sprite.animations[frame.anim];
  if (!anim) throw new Error(`no animation "${frame.anim}" on sprite "${sprite.name}"`);
  if (frame.index < 0 || frame.index >= anim.frames.length) {
    throw new Error(`frame index ${frame.index} out of range (animation "${frame.anim}" has ${anim.frames.length} frames)`);
  }
  return anim.frames[frame.index];
}

function checkColor(sprite, color) {
  if (!Number.isInteger(color) || color < 0 || color >= sprite.palette.length) {
    throw new Error(`color index ${color} out of palette range 0..${sprite.palette.length - 1}`);
  }
}

function checkBounds(sprite, x, y) {
  if (x < 0 || x >= sprite.width || y < 0 || y >= sprite.height) {
    throw new Error(`pixel (${x},${y}) out of bounds for ${sprite.width}x${sprite.height} grid`);
  }
}

/**
 * Apply a list of draw ops to a grid. Mutates `grid`.
 * Ops:
 *   { type: "rows", rows: "<rle>", y?: 0 }   — paste RLE rows starting at row y
 *   { type: "rect", x, y, w, h, color }
 *   { type: "pixels", pixels: [{x, y, color}, ...] }  — max MAX_PIXELS_PER_OP
 *   { type: "clear", color?: 0 }
 */
export function applyOps(sprite, grid, ops) {
  for (const [i, op] of ops.entries()) {
    const where = `op ${i} (${op.type})`;
    switch (op.type) {
      case "rows": {
        const y0 = op.y ?? 0;
        const rows = op.rows.split(";").map((r) => {
          const row = decodeRowSafe(r, sprite.width, where);
          for (const v of row) checkColor(sprite, v);
          return row;
        });
        if (y0 < 0 || y0 + rows.length > sprite.height) {
          throw new Error(`${where}: ${rows.length} rows at y=${y0} exceed grid height ${sprite.height}`);
        }
        rows.forEach((row, dy) => {
          grid[y0 + dy] = row;
        });
        break;
      }
      case "rect": {
        checkColor(sprite, op.color);
        checkBounds(sprite, op.x, op.y);
        checkBounds(sprite, op.x + op.w - 1, op.y + op.h - 1);
        for (let y = op.y; y < op.y + op.h; y++) {
          for (let x = op.x; x < op.x + op.w; x++) grid[y][x] = op.color;
        }
        break;
      }
      case "pixels": {
        if (op.pixels.length > MAX_PIXELS_PER_OP) {
          throw new Error(`${where}: ${op.pixels.length} pixels exceeds limit ${MAX_PIXELS_PER_OP} — batch into multiple draw calls`);
        }
        for (const p of op.pixels) {
          checkBounds(sprite, p.x, p.y);
          checkColor(sprite, p.color);
          grid[p.y][p.x] = p.color;
        }
        break;
      }
      case "clear": {
        const c = op.color ?? 0;
        checkColor(sprite, c);
        for (let y = 0; y < sprite.height; y++) grid[y].fill(c);
        break;
      }
      default:
        throw new Error(`${where}: unknown op type "${op.type}"`);
    }
  }
}

function decodeRowSafe(rle, width, where) {
  try {
    return decodeRow(rle, width);
  } catch (e) {
    throw new Error(`${where}: ${e.message}`);
  }
}

/** Mirror the left half of the grid onto the right half. */
export function mirrorHorizontal(sprite, grid) {
  for (let y = 0; y < sprite.height; y++) {
    for (let x = 0; x < Math.floor(sprite.width / 2); x++) {
      grid[y][sprite.width - 1 - x] = grid[y][x];
    }
  }
}

export function addAnimation(sprite, name, frameCount, fps) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`invalid animation name "${name}"`);
  }
  if (sprite.animations[name]) throw new Error(`animation "${name}" already exists on "${sprite.name}"`);
  if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 16) {
    throw new Error(`frameCount must be an integer 2..16 (got ${frameCount})`);
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    throw new Error(`fps must be an integer 1..60 (got ${fps})`);
  }
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(i === 0 ? sprite.grid.map((r) => [...r]) : blankGrid(sprite.width, sprite.height));
  }
  sprite.animations[name] = { fps, frames };
}

export function copyFrame(sprite, animName, from, to) {
  const anim = sprite.animations[animName];
  if (!anim) throw new Error(`no animation "${animName}" on sprite "${sprite.name}"`);
  for (const idx of [from, to]) {
    if (idx < 0 || idx >= anim.frames.length) {
      throw new Error(`frame index ${idx} out of range (${anim.frames.length} frames)`);
    }
  }
  anim.frames[to] = anim.frames[from].map((r) => [...r]);
}
