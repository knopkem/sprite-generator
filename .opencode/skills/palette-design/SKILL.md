---
name: Palette Design
description: Design a custom limited color palette for a sprite or character set. Use when the user asks for a palette, specific colors, or a consistent look across multiple sprites.
---

# Palette Design

Limited palettes are what make pixel art cohesive.

## Process

1. **Size**: 8-16 colors is a good target. Hard max 31 (index 0 is
   transparent, added automatically). The built-in ramp palette already has
   23 opaque colors plus transparent index 0.

2. **Structure by ramps** — each material gets a 2-4 shade ramp:
   - skin (light → shadow)
   - primary cloth/armor
   - secondary cloth/armor
   - metal/prop
   - 1-2 universal: near-black outline, bright highlight

3. **Hue-shifted ramps**: shadows shift toward blue/purple, highlights toward
   yellow. Avoid pure-gray ramps (lifeless).

4. **Apply with `set_palette`**, then render every sprite that should share it
   to check the mapping.

## Multi-sprite sets

One shared palette across a whole character set is the single biggest
consistency win. When the user asks for "a matching enemy/companion", reuse
the existing sprite's palette verbatim (read it with `get_palette`) and only
add entries if truly needed.

## Reference points

- Classic constraints: NES (4 colors/sprite), PICO-8 (16 fixed colors)
- Good default if the user has no preference: keep the built-in ramp palette
  (23 opaque colors + transparent index 0). `get_palette` reports its
  `outlineIndex` and only valid 3+ entry `litEllipse` triples.
- `set_palette` replaces the whole ordered palette; include matching
  `outlineIndex`/`rampFamilies` when you want generated-style ramp guidance.
