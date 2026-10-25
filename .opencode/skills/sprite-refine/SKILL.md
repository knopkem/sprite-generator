---
name: Sprite Refine
description: Make targeted edits to an existing sprite — change a feature, fix a region, adjust colors. Use when the user asks to fix, tweak, change, or improve part of a sprite.
---

# Sprite Refine

Targeted editing without destroying what already works.

## Process

1. **See it first.** `get_render` (with `grid: true` if you need coordinates)
   and/or `get_grid` to know the exact current state before touching anything.
   If the sprite has multiple layers, `get_state` lists them (bottom→top) and
   `get_grid` defaults to the flattened composite — pass `layer` to read one
   layer. Draws hit the topmost layer unless you pass `layer`, so patches land
   where you expect.

2. **Smallest possible patch.** Translate the request into the minimal set of
   ops:
   - A few pixels wrong → `pixels` op (max 512 per call)
   - A region wrong → `rect` + `pixels`, or one partial `rows` op with `y`
     offset covering only the affected rows
   - Never redraw the whole grid unless the user says "start over" / "redraw".
   - Trying a placement? Pass `commit: false` to preview; nothing is saved and
     no undo entry is created. Re-run without it to apply.

3. **Render and compare.** `get_render` after the patch. Check: did the fix
   land? Did anything adjacent break? Iterate until the user approves.

## Rules

- Full-grid rewrites are the enemy. They silently drift unrelated details.
- `set_palette` replaces the ENTIRE ordered palette (it clamps existing pixel
  indices when the new palette is shorter) — it does not swap one entry. For a
  one-color change, read the complete palette with `get_palette`, preserve its
  order and length, and change only that hex. Alternatively use the viewer's
  single-index palette editor (the REST palette route).
- If the request is ambiguous ("make it pop more"), propose 1-2 concrete
  options and render the safest one at an enlarged scale.
- Before calling it done, inspect a `scale: 1` render for actual-size
  readability; an enlarged view is for locating pixels, not a substitute.
