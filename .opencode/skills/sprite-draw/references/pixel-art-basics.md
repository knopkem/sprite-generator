# Pixel Art Basics for LLM Sprites

## Palette discipline
- 8-16 colors is plenty. Fewer = more cohesive.
- One dark outline color, used consistently.
- Shade with hue shifts, not just darker versions: shadows go slightly
  blue/purple, highlights slightly yellow.

## Readability
- The sprite must read at 100% zoom (actual pixel size). Zoom out mentally.
- Contrast does the work: dark outline, mid-tone body, one bright accent.
- Faces: 2-4 pixels. Eyes are usually 1-2 dark pixels with a light pixel gap.

## Anti-patterns (avoid)
- **Banding**: pixels lining up in long single-file diagonals/strips.
- **Pillow shading**: shading evenly from all edges toward the center.
  Pick ONE light direction (top-left is the genre default) and stick to it.
- **Stray pixels**: single isolated pixels of a color inside another region.
- **Symmetry drift**: if the character should be symmetric, use mirror: true
  instead of hoping both halves match.

## Structure that works at 16-32px
- Head is ~1/3 of total height. Bigger heads read as chibi/cute.
- Feet wider than legs. Arms slightly away from the body read better than
  flush against it.
- Props (staff, sword) should be thicker than 1px where possible, and a
  contrasting color.
