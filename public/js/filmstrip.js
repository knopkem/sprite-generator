// Film strip: frame thumbnails for the selected animation with select,
// drag-to-reorder, duplicate/delete, and fps editing.

import { state, api, currentAnim, hexToRgba, on } from "./state.js";

function renderThumb(canvas, grid, palette, w, h) {
  const sc = Math.max(2, Math.floor(48 / Math.max(w, h)));
  canvas.width = w * sc;
  canvas.height = h * sc;
  const ctx = canvas.getContext("2d");
  const colors = palette.map(hexToRgba);
  // checkerboard backdrop for transparency
  for (let y = 0; y < canvas.height; y += 4) {
    for (let x = 0; x < canvas.width; x += 4) {
      ctx.fillStyle = ((x + y) / 4) % 2 === 0 ? "#45475a" : "#585b70";
      ctx.fillRect(x, y, 4, 4);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = colors[grid[y][x]];
      if (!c || c[3] === 0) continue;
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;
      ctx.fillRect(x * sc, y * sc, sc, sc);
    }
  }
}

export function renderFilmstrip(container) {
  container.innerHTML = "";
  const s = state.current;
  const anim = currentAnim();
  container.style.display = anim ? "flex" : "none";
  if (!s || !anim) return;

  let dragFrom = null;

  anim.frames.forEach((grid, i) => {
    const cell = document.createElement("div");
    cell.className = "frame-cell" + (i === state.frame ? " active" : "");
    cell.draggable = true;
    cell.title = `frame ${i} — drag to reorder`;

    const cv = document.createElement("canvas");
    renderThumb(cv, grid, s.palette, s.width, s.height);
    cell.appendChild(cv);
    const label = document.createElement("span");
    label.textContent = `f${i}`;
    cell.appendChild(label);

    cell.onclick = () => {
      state.frame = i;
      emit("render");
    };
    cell.ondragstart = () => (dragFrom = i);
    cell.ondragover = (ev) => ev.preventDefault();
    cell.ondrop = async (ev) => {
      ev.preventDefault();
      if (dragFrom === null || dragFrom === i) return;
      await api.frameOp({ op: "move", from: dragFrom, to: i });
      state.frame = i;
      dragFrom = null;
    };
    container.appendChild(cell);
  });

  const ops = document.createElement("div");
  ops.className = "frame-ops";

  const dup = document.createElement("button");
  dup.textContent = "+ dup";
  dup.title = "duplicate current frame";
  dup.onclick = async () => {
    await api.frameOp({ op: "duplicate", index: state.frame });
    state.frame += 1;
  };

  const del = document.createElement("button");
  del.textContent = "− del";
  del.title = "delete current frame";
  del.onclick = async () => {
    await api.frameOp({ op: "delete", index: state.frame });
    if (state.frame > 0) state.frame -= 1;
  };

  const fps = document.createElement("input");
  fps.type = "number";
  fps.min = 1;
  fps.max = 60;
  fps.value = anim.fps;
  fps.title = "frames per second";
  fps.onchange = () => api.setFps(Number(fps.value));

  ops.append(dup, del, document.createTextNode("fps"), fps);
  container.appendChild(ops);
}
