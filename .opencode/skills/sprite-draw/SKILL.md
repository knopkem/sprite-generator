---
name: Sprite Draw
description: Draw a new pixel-art sprite from a text description. Use when the user asks to create, draw, or make a sprite, character, enemy, or game object.
---

# Sprite Draw

Workflow for creating a sprite from scratch with the sprite-studio MCP tools.

## Process

1. **Clarify the brief.** Extract: subject, mood, distinguishing features
   (e.g. "wizard: pointy hat, long robe, staff"). If the user gave no size,
   use 32x32. If they ask for >32, warn once about quality, then proceed.
   **Complex or unfamiliar subjects** (animals, riders, archers with bows,
   vehicles, instruments): fetch a reference first (sprite-research skill) —
   do not reason about their anatomy from imagination.

2. **Palette.** The default palette is ramp-based — each hue family has
   light/mid/dark as adjacent indices (check `get_palette`). Shade with the
   darker neighbor, highlight with the lighter. Only call `set_palette` for a
   specific art direction. Read `.opencode/skills/sprite-draw/references/pixel-art-basics.md`
   (path from the project root) if unsure.

3. **Silhouette pass.** Draw ONLY the overall shape in 1-2 mid-tone colors.
   **Think in shapes, not scanlines**: `ellipse` for heads/domes, `line` for
   limbs/props/weapon arcs (a bow is 3-4 line segments, not 15 hand-computed
   rows), `rect` for torsos, `block` for small local RLE regions. Reserve
   full-width `rows` for whole-sprite fills. For symmetric characters, draw
   the left half and pass `mirror: true`. A good silhouette reads at thumbnail
   size — that is the whole game. **Do not hand-draw outlines** — finish the
   pass with an `outline` op, which wraps the shape automatically.
   At 16-32px, iconic beats anatomical: simplify the pose until it reads,
   never chase realism the grid can't hold.

4. **Look at it.** Call `get_render`. Critique honestly against the brief:
   proportions? readable? lopsided? Fix with small patches before proceeding.
   Never claim it looks good without rendering.

5. **Detail passes.** Add shading, face, gear — one `draw` call per pass,
   `get_render` after each. 2-4 detail passes is normal. For rounded volumes
   (blobs, heads, muscles, gems) prefer the `litEllipse` op — lambert shading
   onto a [light, mid, dark] ramp with dithered bands, one op instead of a
   hand-placed shading pass; `rampRect` paints gradient bands (ground shadow,
   sky). Hand-placed shading bands come out with hard edges and are the most
   common cause of full redraws.
   See `.opencode/skills/sprite-draw/references/worked-example.md` (path from
   the project root) for a complete real session — match that economy of
   tool calls.

6. **Done when:** you have rendered at `scale: 2` and the sprite still reads
   clearly at game size, AND the user approves. If it only looks good at
   512px, it isn't done. Then suggest next steps (animation via the
   sprite-animate skill, export via sprite-export).

## Rules

- Bulk ops only. A full sprite = 1-3 `draw` calls for the base, plus small
  patches. Never emit hundreds of single-pixel ops.
- Redrawing the whole grid IS allowed during the initial silhouette phase
  (before the user approves the base). The no-redraw rule applies to
  refinement afterwards.
- Palette index 0 is transparent. Leave breathing room — don't fill the grid
  edge to edge unless the sprite is a tile.
- Keep sprites centered, feet on the bottom row area — and draw the character
  at ~75-85% of the grid height with 2-4px of air on every side. Animations
  (jump squash, attack lunges, weapon arcs) need that headroom; a base sprite
  drawn edge-to-edge forces clipped or cramped poses later. If an existing
  sprite is already too tight, `resize_sprite` grows the grid (content stays
  bottom-centered) instead of redrawing.
- RLE reminder: `"count:index"` runs, `;` between rows. `rows` ops are
  full-width and must sum to the grid width; `block` ops paste at (x,y) with
  independent row widths.
- Prefer deterministic ops over hand-drawn polish: `outline` for silhouettes,
  `shift` to move a frame, `mirror: true` for symmetry.
