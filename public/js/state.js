// Shared viewer state + API client + tiny event bus.

export const state = {
  sprites: [],
  current: null, // sprite object
  anim: "", // selected animation ("" = base sprite)
  frame: 0,
  color: 1,
  tool: "pencil",
  zoom: 0, // 0 = fit
  onion: false,
  showGrid: false,
  playing: false,
};

const listeners = {};
export function on(evt, fn) {
  (listeners[evt] ??= []).push(fn);
}
export function emit(evt, data) {
  for (const fn of listeners[evt] ?? []) fn(data);
}

export function currentGrid() {
  const s = state.current;
  if (!s) return null;
  if (!state.anim) return s.grid;
  return s.animations[state.anim]?.frames[state.frame] ?? s.grid;
}

export function currentAnim() {
  return state.current?.animations?.[state.anim] ?? null;
}

export function hexToRgba(hex) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if (!m) return [0, 0, 0, 0];
  return [
    parseInt(m[1].slice(0, 2), 16),
    parseInt(m[1].slice(2, 4), 16),
    parseInt(m[1].slice(4, 6), 16),
    m[2] ? parseInt(m[2], 16) : 255,
  ];
}

async function request(url, method, body) {
  const res = await fetch(url, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function post(url, body) {
  return request(url, "POST", body ?? {});
}

async function guard(promise) {
  try {
    return await promise;
  } catch (e) {
    emit("error", e.message);
    return null;
  }
}

export const api = {
  async load() {
    const res = await fetch("/api/sprites");
    const data = await res.json();
    state.sprites = data.sprites;
    if (state.current) {
      state.current = state.sprites.find((s) => s.name === state.current.name) ?? null;
    }
    if (!state.current && state.sprites.length) state.current = state.sprites[0];
    // clamp frame index if animation shrank
    const anim = currentAnim();
    if (anim && state.frame >= anim.frames.length) state.frame = anim.frames.length - 1;
    emit("render");
  },
  draw(ops) {
    const s = state.current;
    return guard(
      post(`/api/sprite/${s.name}/draw`, {
        ops,
        ...(state.anim ? { anim: state.anim, frame: state.frame } : {}),
      })
    );
  },
  undo: () => guard(post(`/api/sprite/${state.current.name}/undo`)),
  redo: () => guard(post(`/api/sprite/${state.current.name}/redo`)),
  setPalette: (index, color) => guard(post(`/api/sprite/${state.current.name}/palette`, { index, color })),
  frameOp(body) {
    return guard(post(`/api/sprite/${state.current.name}/anim/${state.anim}/frames`, body));
  },
  setFps(fps) {
    return guard(post(`/api/sprite/${state.current.name}/anim/${state.anim}/fps`, { fps }));
  },
  resize: (width, height) => guard(post(`/api/sprite/${state.current.name}/resize`, { width, height })),
  exportSprite: () => guard(post(`/api/export/${state.current.name}`)),
  deleteSprite: (name = state.current?.name) =>
    guard(request(`/api/sprite/${encodeURIComponent(name)}`, "DELETE")),
};
