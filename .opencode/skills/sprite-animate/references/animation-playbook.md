# Animation Playbook

Per-type frame counts, fps, and pose breakdowns. "Frame N" refers to the
frame index passed to `draw` / `copy_frame`.

## idle — 4 frames @ 5fps
Subtle breathing loop. Keep silhouette identical; only interior detail moves.
- f0: base pose
- f1: torso/chest +1px up (or robe hem sway 1px)
- f2: base pose
- f3: torso -1px (slight settle)
Optional: blink by darkening eye pixels on one frame.

## run — 6-8 frames @ 10fps
Legs do the work; arms counter-swing; 1px vertical bob.
- Contact pose: one leg forward-planted, other trailing back
- Passing pose: legs together under body, body 1px higher
- Mirror contact: opposite leg forward
- Mirror passing
For 6 frames: contact → passing → contact(mirrored) → passing(mirrored) →
two transition frames. Keep torso/head nearly static.

## attack — 4-6 frames @ 12fps
Three beats: anticipation → strike → follow-through.
- Anticipation: weapon/arm pulled BACK (opposite of strike direction), 1-2px
- Strike: weapon fully extended, body lunges 1-2px forward
- Follow-through: weapon past the target point, body settling
- Recovery: back toward base pose
The strike frame should be readable — it's the one players see.

## jump — 4 frames @ 8fps
- f0: crouch (squash: body 1px shorter/wider)
- f1: rising (stretch: legs extended down, body 1px taller)
- f2: apex (legs tucked up)
- f3: falling (legs extended, arms out slightly)

## hurt — 2 frames @ 8fps
- f0: flinch — body shifted 1-2px away from hit, eyes/mouth changed
- f1: base pose (or flash: redraw with a light color swapped in)

## die — 4-6 frames @ 6fps
- Stagger (lean back), collapse (body compresses downward), ground (flat
  shape, 2-3 rows tall), optional: fade by re-coloring toward palette index 1.
