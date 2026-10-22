# Worked Example: 16x16 Slime (verified output)

This is a real, complete drawing session. Follow this shape: 3 tool calls,
2 renders. Note how little drawing happens by hand — `outline` and ramp
neighbors do the polish work.

Palette indices used (default palette): 1 = outline, 13 = green light,
14 = green mid, 15 = green dark.

## Call 1: create

```
create_sprite({ name: "slime", width: 16, height: 16 })
```

## Call 2: silhouette + outline + details, one draw

Flat dome in mid-green — no outline, no details yet. Note the rows only cover
y=4..13; empty rows above/below come free as 16:0.

```
draw({
  sprite: "slime",
  ops: [
    { type: "rows", rows: "16:0;16:0;16:0;16:0;7:0,2:14,7:0;6:0,4:14,6:0;5:0,6:14,5:0;4:0,8:14,4:0;3:0,10:14,3:0;3:0,10:14,3:0;3:0,10:14,3:0;3:0,10:14,3:0;4:0,8:14,4:0;5:0,6:14,5:0;16:0;16:0" },
    { type: "outline" },   // wraps the dome in color 1 automatically
    { type: "pixels", pixels: [
      { x: 5, y: 9, color: 1 }, { x: 10, y: 9, color: 1 },        // eyes
      { x: 6, y: 6, color: 13 }, { x: 5, y: 7, color: 13 }, { x: 6, y: 7, color: 13 },  // highlight cluster (light = top-left)
      { x: 7, y: 13, color: 15 }, { x: 8, y: 13, color: 15 }      // contact shade at bottom
    ]}
  ]
})
```

## Call 3: look

```
get_render({ sprite: "slime" })
```

Critique honestly: Does it read as a slime? Are the eyes level? Is the
highlight clustered top-left (not scattered)? Is there a darker row where it
meets the ground?

## Call 4 (if needed): small patch, then render again

```
draw({ sprite: "slime", ops: [{ type: "pixels", pixels: [...] }] })
get_render({ sprite: "slime", scale: 2 })   // the game-size truth test
```

## What to copy from this example

- Shape first, outline by op, details last — never hand-draw outlines.
- Shading = ramp neighbor of the body color (14 mid → 13 light → 15 dark).
- Detail budget at 16px: eyes + one highlight cluster + one shade row. That's
  it. Resist adding more.
- The sprite occupies the middle of the grid with air around it.
