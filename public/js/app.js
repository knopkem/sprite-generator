// App wiring: sidebar, toolbar, palette editor, playback, shortcuts, SSE.

import { state, api, currentAnim, on, emit, activeLayerName } from "./state.js";
import { initCanvas, drawCanvas, scale } from "./canvas.js";
import { cancelDrag } from "./tools.js";
import { renderFilmstrip } from "./filmstrip.js";

const $ = (id) => document.getElementById(id);

// --- rendering ---

function renderSidebar() {
  $("sprites").innerHTML = "";
  for (const s of state.sprites) {
    const div = document.createElement("div");
    div.className = "sprite-item" + (state.current?.name === s.name ? " active" : "");

    const label = document.createElement("span");
    label.className = "sprite-name";
    label.textContent = `${s.name} (${s.width}×${s.height})`;
    div.appendChild(label);

    const del = document.createElement("button");
    const animCount = Object.keys(s.animations ?? {}).length;
    del.className = "sprite-delete";
    del.type = "button";
    del.textContent = "🗑";
    del.title = `delete "${s.name}"${animCount ? ` and its ${animCount} animation${animCount === 1 ? "" : "s"}` : ""}`;
    del.setAttribute("aria-label", del.title);
    del.onclick = async (ev) => {
      ev.stopPropagation();
      const extra = animCount ? ` and its ${animCount} animation${animCount === 1 ? "" : "s"}` : "";
      if (!confirm(`Delete "${s.name}"${extra}? This cannot be undone.`)) return;
      const wasCurrent = state.current?.name === s.name;
      if (wasCurrent) stopPlay();
      const deleted = await api.deleteSprite(s.name);
      if (!deleted) return;
      if (wasCurrent) {
        state.current = null;
        state.anim = "";
        state.layer = null;
        state.frame = 0;
      }
      await api.load();
    };
    div.appendChild(del);

    div.onclick = () => {
      state.current = s;
      state.anim = "";
      state.frame = 0;
      stopPlay();
      emit("render");
    };
    $("sprites").appendChild(div);
  }
}

function renderToolbar() {
  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === state.tool);
  });
  $("grid-toggle").checked = state.showGrid;
  $("onion-toggle").checked = state.onion;
  $("onion-toggle").disabled = !state.anim;
  $("zoom-label").textContent = state.zoom ? `${state.zoom}×` : "fit";
}

function renderAnimSelect() {
  const sel = $("anim-select");
  const prev = state.anim;
  sel.innerHTML = '<option value="">base sprite</option>';
  for (const name of Object.keys(state.current?.animations ?? {})) {
    const a = state.current.animations[name];
    const o = document.createElement("option");
    o.value = name;
    o.textContent = `${name} (${a.frames.length}f @ ${a.fps}fps)`;
    sel.appendChild(o);
  }
  sel.value = prev;
  if (sel.value !== prev) state.anim = ""; // animation disappeared
}

function renderPalette() {
  const s = state.current;
  const box = $("palette");
  box.innerHTML = "";
  if (!s) return;
  s.palette.forEach((hex, i) => {
    const d = document.createElement("div");
    d.className = "swatch" + (i === 0 ? " transparent" : "") + (i === state.color ? " active" : "");
    if (i !== 0) d.style.background = hex;
    d.title = i === 0 ? "0: transparent (locked)" : `${i}: ${hex} — click to select, double-click to edit`;
    d.innerHTML = `<span>${i}</span>`;
    d.onclick = () => { state.color = i; emit("render"); };
    if (i !== 0) {
      d.ondblclick = () => {
        const picker = $("color-picker");
        picker.value = hex.slice(0, 7);
        picker.onchange = () => api.setPalette(i, picker.value);
        picker.click();
      };
    }
    box.appendChild(d);
  });
}

let cursorPos = null;

function layerButton(text, title, disabled) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "layer-btn";
  b.textContent = text;
  b.title = title;
  b.disabled = Boolean(disabled);
  return b;
}

function renderLayers() {
  const box = $("layers");
  if (!box) return;
  box.innerHTML = "";
  const s = state.current;
  if (!s?.layers) return;

  const head = document.createElement("div");
  head.className = "layers-head";
  const title = document.createElement("span");
  title.textContent = state.anim ? "layers (base sprite)" : "layers";
  head.appendChild(title);
  const add = layerButton("+ layer", "add an empty layer on top", state.anim);
  add.onclick = async () => {
    const name = prompt("layer name (letters, digits, - and _)");
    if (!name) return;
    const result = await api.layerOp({ op: "add", name });
    if (result) {
      state.layer = name;
      emit("render");
    }
  };
  head.appendChild(add);
  box.appendChild(head);

  const active = activeLayerName();
  // Topmost layer first in the panel; z-order index is bottom-up.
  for (const layer of [...s.layers].reverse()) {
    const idx = s.layers.indexOf(layer);
    const row = document.createElement("div");
    row.className = "layer-item" + (layer.name === active ? " active" : "");
    row.title = `${layer.name} — z-index ${idx}${layer.visible ? "" : " (hidden)"}`;

    const eye = layerButton(layer.visible ? "👁" : "🚫", layer.visible ? "hide layer" : "show layer", state.anim);
    eye.onclick = async (ev) => {
      ev.stopPropagation();
      await api.layerOp({ op: "visibility", name: layer.name, visible: !layer.visible });
    };
    row.appendChild(eye);

    const label = document.createElement("span");
    label.className = "layer-name";
    label.textContent = layer.name;
    row.appendChild(label);

    if (!state.anim) {
      const down = layerButton("↓", "move down one z-index", idx === 0);
      down.onclick = async (ev) => {
        ev.stopPropagation();
        await api.layerOp({ op: "reorder", name: layer.name, toIndex: idx - 1 });
      };
      const up = layerButton("↑", "move up one z-index", idx === s.layers.length - 1);
      up.onclick = async (ev) => {
        ev.stopPropagation();
        await api.layerOp({ op: "reorder", name: layer.name, toIndex: idx + 1 });
      };
      row.append(down, up);
    }

    row.onclick = () => {
      state.layer = layer.name;
      emit("render");
    };
    box.appendChild(row);
  }

  const activeLayer = s.layers.find((l) => l.name === active);
  const remove = layerButton("remove layer", "remove the active layer and its pixels", state.anim || s.layers.length <= 1);
  remove.className = "layer-remove";
  remove.onclick = async () => {
    if (!activeLayer) return;
    if (!confirm(`Remove layer "${activeLayer.name}" and its pixels?`)) return;
    const result = await api.layerOp({ op: "remove", name: activeLayer.name });
    if (result) {
      state.layer = null;
      emit("render");
    }
  };
  box.appendChild(remove);
}

function renderStatus() {
  const s = state.current;
  const parts = [];
  if (s) parts.push(`${s.name} v${s.version}`);
  if (cursorPos && s && cursorPos.x >= 0 && cursorPos.y >= 0 && cursorPos.x < s.width && cursorPos.y < s.height) {
    parts.push(`(${cursorPos.x},${cursorPos.y})`);
  }
  parts.push(`scale ${scale()}×`);
  if (state.tool !== "pencil") parts.push(`tool: ${state.tool}`);
  if (s && !state.anim && s.layers?.length > 1) parts.push(`layer ${activeLayerName()}`);
  $("status").textContent = parts.join(" · ") || "no sprites — ask your agent to draw one";
}

function renderResizeSelect() {
  const sel = $("resize-select");
  const s = state.current;
  const sizes = [16, 24, 32, 48, 64];
  sel.innerHTML = "";
  for (const n of sizes) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = `${n}×${n}`;
    sel.appendChild(o);
  }
  if (s) sel.value = s.width;
}

on("render", () => {
  renderSidebar();
  renderToolbar();
  renderAnimSelect();
  renderResizeSelect();
  renderPalette();
  renderLayers();
  renderFilmstrip($("filmstrip"));
  renderStatus();
});
on("cursor", (pos) => { cursorPos = pos; renderStatus(); });
on("error", (msg) => { $("status").innerHTML = `<span class="err">${msg}</span>`; });

// --- toolbar ---

document.querySelectorAll("[data-tool]").forEach((b) => {
  b.onclick = () => { state.tool = b.dataset.tool; emit("render"); };
});
$("undo-btn").onclick = () => api.undo();
$("redo-btn").onclick = () => api.redo();
$("grid-toggle").onchange = (e) => { state.showGrid = e.target.checked; emit("render"); };
$("onion-toggle").onchange = (e) => { state.onion = e.target.checked; emit("render"); };
$("zoom-in").onclick = () => { state.zoom = Math.min(32, (state.zoom || scale()) * 2); emit("render"); };
$("zoom-out").onclick = () => { state.zoom = Math.max(2, Math.floor((state.zoom || scale()) / 2)); emit("render"); };
$("zoom-fit").onclick = () => { state.zoom = 0; emit("render"); };

// --- animation controls ---

let playTimer = null;
function stopPlay() {
  state.playing = false;
  clearInterval(playTimer);
  $("play-btn").textContent = "▶ play";
}
$("play-btn").onclick = () => {
  const anim = currentAnim();
  if (!anim) return;
  if (state.playing) { stopPlay(); emit("render"); return; }
  state.playing = true;
  $("play-btn").textContent = "⏸ stop";
  playTimer = setInterval(() => {
    state.frame = (state.frame + 1) % anim.frames.length;
    renderFilmstrip($("filmstrip"));
    drawCanvas();
  }, 1000 / anim.fps);
};
$("anim-select").onchange = (e) => {
  state.anim = e.target.value;
  state.frame = 0;
  stopPlay();
  emit("render");
};

$("resize-select").onchange = async (e) => {
  const n = Number(e.target.value);
  if (state.current && n !== state.current.width) await api.resize(n, n);
};

$("export-btn").onclick = async () => {
  const data = await api.exportSprite();
  $("export-result").textContent = data ? `PNG:  ${data.png}\nJSON: ${data.json}` : "";
};

// --- keyboard ---

const KEYS = { b: "pencil", e: "eraser", i: "eyedropper", g: "fill", l: "line", r: "rect" };
addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea")) return;
  const k = e.key.toLowerCase();
  if (KEYS[k]) { state.tool = KEYS[k]; emit("render"); }
  else if (k === "z" && e.shiftKey) api.redo();
  else if (k === "z") api.undo();
  else if (k === "o") { state.onion = !state.onion && Boolean(state.anim); emit("render"); }
  else if (k === " ") { e.preventDefault(); $("play-btn").click(); }
});

// --- live updates from agent edits ---

new EventSource("/api/events").onmessage = () => {
  cancelDrag();
  api.load();
};

initCanvas($("canvas"));
api.load();
