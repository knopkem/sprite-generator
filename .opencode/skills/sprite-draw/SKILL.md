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

2. **Palette.** The default palette has 23 opaque colors plus transparent
   index 0, organized as ramp families — each hue family has light/mid/dark as
   adjacent indices (check `get_palette`). Shade with the darker neighbor,
   highlight with the lighter. Only call `set_palette` for a specific art
   direction. Read `.opencode/skills/sprite-draw/references/pixel-art-basics.md`
   (path from the project root) if unsure.

3. **Silhouette pass.** Draw ONLY the overall shape in 1-2 mid-tone colors.
   **Think in shapes, not scanlines**: `ellipse` for heads/domes, `line` for
   straight limbs/props, `curve` for arcs (**a bow is ONE curve op**, not 3-4
   line segments), `polygon` for angular silhouettes (tunics, boots, quivers,
   shields), `taperedLine` for anatomy that changes width (thigh→calf,
   upper-arm→forearm, tapered props), `rect` for torsos, `block` for small
   local RLE regions. Reserve full-width `rows` for whole-sprite fills. For
   symmetric characters, draw the left half and pass `mirror: true`.
   **Do not hand-draw outlines** — finish the pass with an `outline` op, which
   wraps the shape using the sprite's `outlineIndex`.
   Work back-to-front: rear props → body → costume → arms → held props.
   At 16-32px, iconic beats anatomical: simplify the pose until it reads,
   never chase realism the grid can't hold.

4. **Silhouette gate — mandatory before any detail pass.** Look at the
   render and check:
   - subject and pose read without facial details or shading;
   - head/torso/leg proportions are intentional;
   - thighs, calves, ankles, and feet have distinct, readable widths;
   - feet are grounded and broader than ankles where appropriate;
   - bent arms show visible negative space and do not read as straight bars;
   - back equipment (quiver, pack, cape) does not merge with elbows, arms, or
     the torso;
   - touching parts differ in value or hue; add 1-2px separation when the
     design allows;
   - weapons and extremities preserve animation headroom.
   If any item fails, patch the silhouette. **Do not use shading to conceal an
   anatomy or overlap problem.** A good silhouette reads at thumbnail size —
   that is the whole game.

5. **Look at it.** `draw` returns the render inline by default — critique that
   image instead of asking for the same render again. Use `get_render` when
   changing scale/grid/target or when inline rendering was skipped. Inspect an
   enlarged render (scale 2-4) for pixel placement. Never claim it looks good
   without rendering.

6. **Detail passes.** Add shading, face, gear — one `draw` call per pass, and
   render after each (inline is usually enough). 2-4 detail passes is normal.
   For rounded volumes (blobs, heads, muscles, gems) prefer the `litEllipse`
   op — lambert shading onto a [light, mid, dark] ramp with dithered bands,
   one op instead of a hand-placed shading pass; `rampRect` paints gradient
   bands (ground shadow, sky). Only a 3+ entry ramp family is a valid
   `litEllipse` ramp. Hand-placed shading bands come out with hard edges and
   are the most common cause of full redraws.
   See `.opencode/skills/sprite-draw/references/worked-example.md` (path from
   the project root) for a complete real session — match that economy of
   tool calls.

7. **Done when:** you have inspected a `scale: 1` render and the sprite reads
   clearly at actual size, AND the user approves. An additional `scale: 2`
   view is useful for pixel placement but is NOT the actual-size test. If it
   only looks good at 512px, it isn't done. Then suggest next steps (animation
   via the sprite-animate skill, export via sprite-export).

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
- If a draw op or tool seems missing, call `get_capabilities`; restart the
  daemon and reconnect the MCP session after server code changes.
