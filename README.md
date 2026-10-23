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
npm run serve          # http://localhost:7337 (viewer), /mcp (MCP endpoint)
```

Then open your agent in this directory. For opencode it's preconfigured
(`opencode.jsonc`); for other hosts, add the MCP server manually:

- **URL:** `http://localhost:7337/mcp` (Streamable HTTP, no auth — localhost only)

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
`fetch_reference` (download → pixelate to grid size → extract palette) ·
`set_palette` / `get_palette` · `draw` (shape ops: `ellipse`, `line`, `rect`,
`block`; bulk `rows` RLE; `pixels`/`clear`/`fill`; deterministic `outline` and
`shift`; optional mirror) · `get_render` (PNG image result — the agent's eyes) ·
`export_render` (file fallback for hosts without image support) · `get_grid`
· `list_sprites` / `get_state` · `add_animation` · `copy_frame` ·
`get_onion_skin` · `export` · `delete_sprite`

## Data & export

- Sprites live as JSON in `sprites/` (palette-indexed grids, RLE-friendly).
- Grid sizes: 16/24/32/48/64. **32 is the sweet spot** — LLM spatial
  coherence degrades above that.
- `export` writes `exports/<name>.png` (sheet) + Aseprite-style
  `exports/<name>.json` (frames, durations, per-animation tags) — imports
  into Godot, Unity (via Aseprite importer), Phaser, etc.

## Viewer

`http://localhost:7337` — a real editor, not just a preview:

- **Tool palette**: pencil, eraser, eyedropper (or right-click), flood fill,
  line, rect, and color-replace (click a pixel to swap that color everywhere
  in the frame). Strokes upload as one batched op on mouse-up.
- **Undo/redo** (Z / shift+Z): server-side snapshots shared with the agent —
  you can undo the agent's last change and it can build on yours.
- **Film strip**: frame thumbnails, click to select, drag to reorder,
  duplicate/delete, editable fps, play-in-place.
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
npm test             # core lib: RLE codec, model ops, render, export
npm run serve -- --port=8080 --root=/path/to/project
```
