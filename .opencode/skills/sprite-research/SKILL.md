---
name: Sprite Research
description: Study reference images before drawing a sprite — fetch a style reference, see it pixelated to the target grid size, and extract its palette. Use when the user references a style ("like Zelda", "chunky SNES look"), asks for quality, or provides an image URL.
---

# Sprite Research

Style and palette transfer from reference images. This improves *choices*
(proportions, palette, shading placement) — not execution. The actual-size
`scale: 1` render check still decides when the sprite is done.

## When to use

- The user references a known style, game, or artist
- The user provides an image URL
- A first attempt came out flat and you want a proven palette/composition

Skip it for quick throwaway sprites.

## Workflow

1. **Pick 1-2 sources.** Prefer CC0/CC-BY: kenney.nl, opengameart.org,
   lospec.com (palette lists). `fetch_reference` accepts HTTP(S) PNG URLs
   only. If the user gives a local image path, inspect it with your host's
   image-reading tool; do not pass the local path to `fetch_reference`.
2. **`fetch_reference(url, sprite)`** — you get back the original, a
   pixelated version at the exact target width x height (the sprite's size,
   or a square `gridSize`), extracted color counts, and a suggested
   `set_palette` argument block.
3. **Study the pixelated version, not the original.** It answers the only
   question that matters: how much detail survives at your resolution. Count
   pixels in the reference: how wide is the head? how many shades on the
   body? where does the outline disappear?
4. **Adopt the palette**: call `set_palette` with the returned `colors`,
   `outlineIndex`, and `rampFamilies` (edit to taste — drop near-duplicates,
   keep one outline color). The suggestion is organized light→dark, not
   frequency ordered; it is intended for a new sprite before drawing. Then
   call `get_palette` for index-specific shading guidance.
5. **Draw** per the sprite-draw workflow, transferring *proportions and
   shading patterns*, never copying the original's pixels.

## Cautions

- Do not mimic detail that only exists at the reference's native resolution.
- Do not fetch more than 2-3 references per sprite — context is finite.
- Licensing: reference for style, don't ship traced pixels. Stick to
  CC0/CC-BY sources for anything close.
