// Editor tools. Mouse lifecycle: down(x,y) -> move(x,y)* -> up(x,y).
// Pencil/eraser collect a stroke and upload it as one batched op on mouse-up.

import { state, api, currentGrid, activeGrid, emit } from "./state.js";

let stroke = null; // Map<"x,y",{x,y,color}> while dragging pencil/eraser
let anchor = null; // [x,y] drag start for line/rect
let preview = []; // [{x,y,color}] overlay while dragging line/rect

export function getPreview() {
  return preview;
}

function inBounds(x, y) {
  const s = state.current;
  return s && x >= 0 && y >= 0 && x < s.width && y < s.height;
}

function addStrokePixel(x, y) {
  if (!inBounds(x, y)) return;
  const grid = activeGrid();
  if (!grid) return;
  const color = state.tool === "eraser" ? 0 : state.color;
  stroke.set(`${x},${y}`, { x, y, color });
  grid[y][x] = color; // optimistic local paint on the active layer
  emit("canvas");
}

async function commitPixels(pixels) {
  if (!pixels.length) return;
  const ops = [];
  for (let i = 0; i < pixels.length; i += 512) {
    ops.push({ type: "pixels", pixels: pixels.slice(i, i + 512) });
  }
  await api.draw(ops);
}

export function bresenham(x0, y0, x1, y1) {
  const pts = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return pts;
}

function pick(x, y) {
  const grid = currentGrid();
  if (!grid || !inBounds(x, y)) return;
  state.color = grid[y][x];
  state.tool = "pencil";
  emit("render");
}

export const tools = {
  pencil: {
    down(x, y) { stroke = new Map(); addStrokePixel(x, y); },
    move(x, y) { if (stroke) addStrokePixel(x, y); },
    async up() { const px = stroke ? [...stroke.values()] : []; stroke = null; await commitPixels(px); },
  },
  eraser: {
    down(x, y) { stroke = new Map(); addStrokePixel(x, y); },
    move(x, y) { if (stroke) addStrokePixel(x, y); },
    async up() { const px = stroke ? [...stroke.values()] : []; stroke = null; await commitPixels(px); },
  },
  eyedropper: {
    down(x, y) { pick(x, y); },
    move() {},
    up() {},
  },
  fill: {
    async down(x, y) {
      if (!inBounds(x, y)) return;
      const grid = activeGrid();
      if (!grid || grid[y][x] === state.color) return;
      await api.draw([{ type: "fill", x, y, color: state.color }]);
    },
    move() {},
    up() {},
  },
  line: {
    down(x, y) { anchor = [x, y]; preview = [{ x, y, color: state.color }]; emit("canvas"); },
    move(x, y) {
      if (!anchor) return;
      preview = bresenham(anchor[0], anchor[1], x, y).map(([px, py]) => ({ x: px, y: py, color: state.color }));
      emit("canvas");
    },
    async up() { const px = preview; anchor = null; preview = []; emit("canvas"); await commitPixels(px); },
  },
  rect: {
    down(x, y) { anchor = [x, y]; preview = [{ x, y, color: state.color }]; emit("canvas"); },
    move(x, y) {
      if (!anchor) return;
      const [ax, ay] = anchor;
      preview = [];
      for (let py = Math.min(ay, y); py <= Math.max(ay, y); py++) {
        for (let px = Math.min(ax, x); px <= Math.max(ax, x); px++) {
          preview.push({ x: px, y: py, color: state.color });
        }
      }
      emit("canvas");
    },
    async up(x, y) {
      if (!anchor) return;
      const [ax, ay] = anchor;
      const op = {
        type: "rect",
        x: Math.min(ax, x), y: Math.min(ay, y),
        w: Math.abs(x - ax) + 1, h: Math.abs(y - ay) + 1,
        color: state.color,
      };
      anchor = null; preview = []; emit("canvas");
      await api.draw([op]);
    },
  },
  replace: {
    // Swap every pixel of the clicked color to the selected color (active layer/frame).
    async down(x, y) {
      const grid = activeGrid();
      if (!grid || !inBounds(x, y)) return;
      const from = grid[y][x];
      if (from === state.color) return;
      const pixels = [];
      for (let py = 0; py < grid.length; py++) {
        for (let px = 0; px < grid[py].length; px++) {
          if (grid[py][px] === from) pixels.push({ x: px, y: py, color: state.color });
        }
      }
      await commitPixels(pixels);
    },
    move() {},
    up() {},
  },
};

export function cancelDrag() {
  stroke = null;
  anchor = null;
  preview = [];
}
