# Sprite Studio

MCP-first procedural sprite & animation workstation. Your LLM agent
(opencode, Claude Code, any MCP host) is the artist — this app provides the
canvas, the eyes, and the export pipeline.

```
agent (opencode / Claude Code / ...)          sprite-studio daemon
┌──────────────────────────┐   MCP (HTTP)   ┌────────────────────────────┐
│ "draw me a wizard"       │ ─────────────▶ │ state, validation, render  │
│ skills teach it pixel art│ ◀───────────── │ PNG renders (image results)│
│ vision loop: see & fix   │                │ export: sheet + JSON       │
└──────────────────────────┘                │ web viewer (live preview)  │
                                            └────────────────────────────┘
```

## Quick start

```sh
npm install
npm run serve          # http://127.0.0.1:7337 (viewer), /mcp (MCP endpoint)
```

Then open your agent in this directory. For opencode it's preconfigured
(`opencode.jsonc`); for other hosts, add the MCP server manually:

- **URL:** `http://127.0.0.1:7337/mcp` (Streamable HTTP, no auth — loopback only).
  Use the numeric IPv4 address, not `localhost`: the daemon binds `127.0.0.1`, and
  Bun-based clients (OpenCode) resolve `localhost` to `::1` without falling back,
  which fails with `ECONNREFUSED`.

Try: *"Draw me a wizard with a robe and staff, 32x32"* — then watch it appear
live in the viewer. *"Give him an idle animation"*, *"make the hat pointier"*,
*"export the sheet"*.

## Predefined skills

Shipped in `.opencode/skills/`, discovered automatically by opencode:

| Skill | What it teaches the agent |
|---|---|
| `sprite-draw` | Full drawing workflow: silhouette → render → critique → detail passes (+ pixel-art fundamentals reference) |
| `sprite-research` | Style transfer: fetch a reference, study it pixelated to grid size, adopt its extracted palette |
| `sprite-refine` | Minimal-diff targeted edits, never redraw the whole grid |
| `sprite-animate` | Keyframe-first animation with onion-skin checks (+ per-type playbook: idle/run/attack/jump/hurt/die) |
| `palette-design` | Limited ramp-based palettes, shared across character sets |
| `sprite-export` | Sheet layouts, metadata, engine import notes |

## MCP tools

`create_sprite` · `resize_sprite` (grow grid for animation headroom) ·
`generate_sprite` (procedural path: sandboxed painter JS on a 4x canvas →
downsample → quantize into an indexed sprite, palette auto-organized into
light→dark ramp families so the shading ops compose on top; best for
organic/gradient-heavy art and grids ≥ 48) ·
`fetch_reference` (HTTP(S) PNG URL → pixelate to the exact target width ×
height (sprite or square `gridSize`) → extract colors and return a ready-to-use
`set_palette` argument block with `outlineIndex`/`rampFamilies`) ·
`set_palette` / `get_palette` (`set_palette` replaces the complete ordered
palette, clamps pixels, and can store `outlineIndex` + `rampFamilies`;
`get_palette` reports index labels, the outline default, and valid
`litEllipse` triples) · `draw` (shape ops: `ellipse`, `line`,
`curve` (quadratic bezier arc — one op for bows/capes/tails), `polygon`
(3–16 vertex filled silhouette), `taperedLine` (round-capped width-changing
limb/prop), `rect`, `block`; `line`/`curve`/`ellipse` accept fractional
coordinates → 8×8 coverage placement, while integer params keep the legacy
crisp rasterizer; shading ops: `litEllipse` (lambert-shaded ellipse
onto a [light, mid, dark] ramp, dithered), `rampRect` (gradient rect, v/h);
bulk `rows` RLE; `pixels`/`clear`/`fill`; deterministic `outline` (defaults to
the sprite `outlineIndex`; `scope: "new"` re-outlines only pixels added in that
call — thin details stay thin) and `shift`; optional mirror; `layer` targets one
z-ordered layer (default topmost, ops are layer-local); `commit: false`
previews the ops without saving (no version/history/viewer change); returns the
render inline unless `render: false`; failed multi-op draws are atomic) ·
`add_layer` / `remove_layer` / `reorder_layer` / `set_layer_visibility`
(z-ordered base-sprite layers; animations flatten the composite) ·
`undo` / `redo` (server-side snapshots, shared with the viewer) ·
`get_render` (PNG image result — the agent's eyes; `scale: 1` is the
actual-size test) · `export_render` (file fallback for hosts without image
support) · `get_grid` · `get_capabilities` (server version, draw-schema
revision, supported ops, grid sizes) · `list_sprites` / `get_state` ·
`add_animation` · `copy_frame` · `get_onion_skin` · `export` · `delete_sprite`

## Data & export

- Sprites live as JSON in `sprites/` (palette-indexed grids, RLE-friendly).
- **Layers (base sprite):** stored as `layers: [{name, visible}]` (index 0 =
  bottom) plus `grids[layerName]`. Render/export flatten the *visible* layers
  bottom-to-top, where the topmost non-transparent index wins. `draw` targets
  the topmost layer unless you pass `layer`; `outline`, `fill`, and `mirror`
  are layer-local. Animation frames stay flat — `add_animation` flattens the
  composite into frame 0. Legacy files with a single `grid` migrate on load.
- Grid sizes: 16/24/32/48/64. **32 is the sweet spot** — LLM spatial
  coherence degrades above that.
- `export` writes `exports/<name>.png` (sheet) + Aseprite-style
  `exports/<name>.json` (frames, durations, per-animation tags) — imports
  into Godot, Unity (via Aseprite importer), Phaser, etc.

## Viewer

`http://127.0.0.1:7337` — a real editor, not just a preview:

- **Tool palette**: pencil, eraser, eyedropper (or right-click), flood fill,
  line, rect, and color-replace (click a pixel to swap that color everywhere
  in the frame). Strokes upload as one batched op on mouse-up.
- **Undo/redo** (Z / shift+Z): server-side snapshots shared with the agent —
  you can undo the agent's last change and it can build on yours.
- **Film strip**: frame thumbnails, click to select, drag to reorder,
  duplicate/delete, editable fps, play-in-place.
- **Layer panel**: z-ordered layer list (top first), click to activate, eye to
  show/hide, arrows to reorder, add/remove. Strokes target the active layer;
  the canvas always shows the flattened composite. Animation view edits flat
  frames and disables layer reordering.
- **Delete sprite**: the 🗑 button beside each sprite in the sidebar
  confirms, then removes the sprite and all its animations.
- **Onion skin** toggle: previous frame ghosted under the current one.
- **Palette editor**: double-click a swatch to change that color.
- Zoom 2×–32×/fit, grid overlay, cursor coordinates, keyboard shortcuts
  (B/E/I/G/L/R/Z/O/space).
- Live updates via SSE — watch the agent draw in real time; it sees your
  manual fixes too ("I fixed the eyes, now do the run cycle" works).

## Development

```sh
npm test             # core lib: RLE codec, model ops, render, export, MCP
npm run serve -- --port=8080 --root=/path/to/project
```

### Troubleshooting stale tools/capabilities

The daemon is stateless per HTTP request, but the source modules are loaded
once per process and MCP clients cache tool schemas. A fresh transport per
request does **not** hot-reload tool code or schemas.

- After changing tool code or zod schemas, restart `npm run serve`.
- Then reconnect the MCP client or start a fresh agent session.
- If a draw op or tool seems missing, call `get_capabilities` (or
  `GET /api/capabilities`) and compare `serverVersion`, `drawSchemaRevision`,
  and `drawOps` with the running source. Any add/semantic change to a draw op
  increments `DRAW_SCHEMA_REVISION`.

The startup log prints both the server version and the draw-schema revision.
