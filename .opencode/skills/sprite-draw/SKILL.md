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

2. **Palette.** The default palette is ramp-based — each hue family has
   light/mid/dark as adjacent indices (check `get_palette`). Shade with the
   darker neighbor, highlight with the lighter. Only call `set_palette` for a
   specific art direction. Read `references/pixel-art-basics.md` if unsure.

3. **Silhouette pass.** Draw ONLY the overall shape in 1-2 mid-tone colors
   using one `draw` call with `rows` ops (RLE). For symmetric characters, draw
   the left half and pass `mirror: true`. A good silhouette reads at thumbnail
   size — that is the whole game. **Do not hand-draw outlines** — finish the
   pass with an `outline` op, which wraps the shape automatically.

4. **Look at it.** Call `get_render`. Critique honestly against the brief:
   proportions? readable? lopsided? Fix with small patches before proceeding.
   Never claim it looks good without rendering.

5. **Detail passes.** Add shading (ramp neighbors), face, gear — one `draw`
   call per pass, `get_render` after each. 2-4 detail passes is normal.
   See `references/worked-example.md` for a complete real session — match
   that economy of tool calls.

6. **Done when:** you have rendered at `scale: 2` and the sprite still reads
   clearly at game size, AND the user approves. If it only looks good at
   512px, it isn't done. Then suggest next steps (animation via the
   sprite-animate skill, export via sprite-export).

## Rules

- Bulk ops only. A full sprite = 1-3 `draw` calls for the base, plus small
  patches. Never emit hundreds of single-pixel ops.
- Palette index 0 is transparent. Leave breathing room — don't fill the grid
  edge to edge unless the sprite is a tile.
- Keep sprites centered, feet on the bottom row area — and draw the character
  at ~75-85% of the grid height with 2-4px of air on every side. Animations
  (jump squash, attack lunges, weapon arcs) need that headroom; a base sprite
  drawn edge-to-edge forces clipped or cramped poses later. If an existing
  sprite is already too tight, `resize_sprite` grows the grid (content stays
  bottom-centered) instead of redrawing.
- RLE reminder: `"count:index"` runs, `;` between rows. Row must sum to
  exactly the grid width.
- Prefer deterministic ops over hand-drawn polish: `outline` for silhouettes,
  `shift` to move a frame, `mirror: true` for symmetry.
