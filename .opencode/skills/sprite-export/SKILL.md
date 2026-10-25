---
name: Sprite Export
description: Export a sprite with its animations to a PNG sprite sheet and JSON metadata for use in a game engine. Use when the user asks to export, save, or get the sprite sheet.
---

# Sprite Export

## Process

1. **Sanity check first**: `get_render` the base sprite and at least spot-check
   each animation frame. Exporting broken frames wastes the user's time.

2. **Choose layout**:
   - `grid` (default): one row per animation, base sprite on the first row.
     Best all-round sheet.
   - `strip`: all frames in one row. Use with `anim` for a single-animation
     strip (common for engines that want one file per animation).

3. **Call `export`** and report the returned paths:
   - `exports/<name>.png` — the sheet (transparent background), with the base
     frame rendered as the **flattened composite** of visible layers (engines
     never see layer metadata)
   - `exports/<name>.json` — Aseprite-style metadata: per-frame rect +
      duration, `meta.frameTags` with one tag per animation (usable as
      animation names in Godot, Unity via Aseprite importers, Phaser, etc.)

4. **Tell the user the frame layout** (rows × cols, frame size) so they can
   configure their engine's import.

## Engine notes

- Frame durations in the JSON come from each animation's fps.
- The sheet has no padding/spacing — frames are packed contiguously, origin
  top-left.
- If the engine needs a pivot/anchor: bottom-center is the convention these
  sprites are drawn for (feet on bottom row, horizontally centered).
