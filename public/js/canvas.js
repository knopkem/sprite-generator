// Main canvas: renders the current grid (plus onion skin + drag previews),
// dispatches mouse events to the active tool, tracks cursor for the status bar.

import { state, currentGrid, currentAnim, hexToRgba, on, emit } from "./state.js";
import { tools, getPreview, cancelDrag } from "./tools.js";

let canvas, ctx;

export function scale() {
  const s = state.current;
  if (!s) return 16;
  if (state.zoom > 0) return state.zoom;
  return Math.max(4, Math.floor(512 / Math.max(s.width, s.height)));
}

function gridPos(ev) {
  const s = state.current;
  const rect = canvas.getBoundingClientRect();
  const sc = scale();
  return [Math.floor((ev.clientX - rect.left) / sc), Math.floor((ev.clientY - rect.top) / sc)];
}

function drawPixels(grid, alpha) {
  const s = state.current;
  const colors = s.palette.map(hexToRgba);
  const sc = scale();
  ctx.globalAlpha = alpha;
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const c = colors[grid[y][x]];
      if (!c || c[3] === 0) continue;
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(3)})`;
      ctx.fillRect(x * sc, y * sc, sc, sc);
    }
  }
  ctx.globalAlpha = 1;
}

export function drawCanvas() {
  const s = state.current;
  const grid = currentGrid();
  if (!s || !grid) {
    canvas.width = canvas.height = 0;
    return;
  }
  const sc = scale();
  canvas.width = s.width * sc;
  canvas.height = s.height * sc;

  // onion skin: previous frame ghosted underneath
  if (state.onion && state.anim && !state.playing) {
    const anim = currentAnim();
    const prev = anim?.frames[state.frame - 1];
    if (prev) drawPixels(prev, 0.3);
  }

  drawPixels(grid, 1);

  // drag preview (line/rect)
  const colors = s.palette.map(hexToRgba);
  for (const p of getPreview()) {
    const c = colors[p.color];
    if (!c) continue;
    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.65)`;
    ctx.fillRect(p.x * sc, p.y * sc, sc, sc);
  }

  if (state.showGrid && sc >= 8) {
    ctx.strokeStyle = "rgba(30,30,46,0.5)";
    ctx.beginPath();
    for (let i = 0; i <= s.width; i++) { ctx.moveTo(i * sc, 0); ctx.lineTo(i * sc, canvas.height); }
    for (let i = 0; i <= s.height; i++) { ctx.moveTo(0, i * sc); ctx.lineTo(canvas.width, i * sc); }
    ctx.stroke();
  }
}

export function initCanvas(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext("2d");
  let dragging = false;

  canvas.addEventListener("mousedown", (ev) => {
    if (ev.button === 2) return; // right-click handled by contextmenu
    dragging = true;
    tools[state.tool].down(...gridPos(ev));
  });
  canvas.addEventListener("mousemove", (ev) => {
    const [x, y] = gridPos(ev);
    emit("cursor", { x, y });
    if (dragging) tools[state.tool].move(x, y);
  });
  addEventListener("mouseup", (ev) => {
    if (!dragging) return;
    dragging = false;
    tools[state.tool].up(...gridPos(ev));
  });
  canvas.addEventListener("mouseleave", () => emit("cursor", null));
  canvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const [x, y] = gridPos(ev);
    const grid = currentGrid();
    if (grid && state.current && x >= 0 && y >= 0 && x < state.current.width && y < state.current.height) {
      state.color = grid[y][x];
      emit("render");
    }
  });

  on("canvas", drawCanvas);
  on("render", drawCanvas);
  return { cancelDrag };
}
