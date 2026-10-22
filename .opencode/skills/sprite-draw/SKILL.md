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

2. **Palette.** If the sprite fits the default 16-color palette, keep it.
   Only call `set_palette` for a specific art direction. Read
   `references/pixel-art-basics.md` if unsure about palette discipline.

3. **Silhouette pass.** Draw ONLY the overall shape in 1-2 dark colors using
   one `draw` call with `rows` ops (RLE). For symmetric characters, draw the
   left half and pass `mirror: true`. A good silhouette reads at thumbnail
   size — that is the whole game.

4. **Look at it.** Call `get_render`. Critique honestly against the brief:
   proportions? readable? lopsided? Fix with small patches before proceeding.
   Never claim it looks good without rendering.

5. **Detail passes.** Add shading, face, gear — one `draw` call per pass,
   `get_render` after each. 2-4 detail passes is normal.

6. **Done when:** the user approves, or the render clearly matches the brief
   at 100% zoom. Suggest next steps (animation via the sprite-animate skill,
   export via sprite-export).

## Rules

- Bulk ops only. A full sprite = 1-3 `draw` calls for the base, plus small
  patches. Never emit hundreds of single-pixel ops.
- Palette index 0 is transparent. Leave breathing room — don't fill the grid
  edge to edge unless the sprite is a tile.
- Keep sprites centered, feet on the bottom row area.
- RLE reminder: `"count:index"` runs, `;` between rows. Row must sum to
  exactly the grid width.
