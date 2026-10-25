---
name: Sprite Animate
description: Create an animation (idle, run, attack, jump, hurt, die) for an existing sprite. Use when the user asks to animate a sprite or add a motion/animation sequence.
---

# Sprite Animate

Frame-by-frame animation with consistency. The base sprite is ground truth —
every frame must remain recognizably the same character.

## Process

1. **Read `.opencode/skills/sprite-animate/references/animation-playbook.md`**
   (path from the project root) for the requested animation type (frame
   counts, fps, pose breakdowns).

2. **Create the animation**: `add_animation`. Frame 0 is auto-copied from the
   base sprite — specifically its **flattened composite** of visible layers.
   Frames are flat: layer targeting does not apply to them, and later layer
   edits do not leak into existing frames.

3. **Keyframe-first**: `copy_frame` frame 0 → all other frames. Then patch
   ONE frame at a time with `draw` + `frame: {anim, index}`. Start with the
   most extreme poses (contact, passing, apex), then the in-betweens.
   Use `shift` ops for whole-body bob (e.g. idle: `shift dy:-1` on alternating
   frames) — it's exact, where hand-redrawing drifts.

4. **Check motion with onion skin**: `get_onion_skin` per frame. Red = previous
   frame, blue = next. Look for: jitter (body parts teleporting), volume loss
   (character shrinking/growing), foot sliding.

5. **Fix per frame.** Bad frame → small patch on that frame only. Never
   regenerate the whole sequence.

6. **Consistency checklist** before declaring done:
   - Same palette indices as the base sprite (no new colors)
   - Head/torso proportions identical across frames
   - Motion reads correctly when you flip through renders in order

## Rules

- Keep sequences short: 4-8 frames. More frames = more drift.
- Small motions beat big ones. A 1-2px bob reads better than limbs flying.
- The base sprite's silhouette should be ~90% preserved per frame — poses
  change limbs and details, not the body mass.
- **If a pose would clip at the grid edge, do not squash it to fit.** Call
  `resize_sprite` to grow the grid (content stays bottom-centered, all frames
  remapped), then animate into the new headroom.
