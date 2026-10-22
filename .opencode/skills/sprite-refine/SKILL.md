---
name: Sprite Refine
description: Make targeted edits to an existing sprite — change a feature, fix a region, adjust colors. Use when the user asks to fix, tweak, change, or improve part of a sprite.
---

# Sprite Refine

Targeted editing without destroying what already works.

## Process

1. **See it first.** `get_render` (with `grid: true` if you need coordinates)
   and/or `get_grid` to know the exact current state before touching anything.

2. **Smallest possible patch.** Translate the request into the minimal set of
   ops:
   - A few pixels wrong → `pixels` op (max 512 per call)
   - A region wrong → `rect` + `pixels`, or one partial `rows` op with `y`
     offset covering only the affected rows
   - Never redraw the whole grid unless the user says "start over" / "redraw".

3. **Render and compare.** `get_render` after the patch. Check: did the fix
   land? Did anything adjacent break? Iterate until the user approves.

## Rules

- Full-grid rewrites are the enemy. They silently drift unrelated details.
- When changing a color everywhere, prefer `set_palette` (swaps the palette
  entry) over repainting pixels.
- If the request is ambiguous ("make it pop more"), propose 1-2 concrete
  options and render the safest one.
