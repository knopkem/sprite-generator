# Plan: Deferred work from the 64px archer session

Status: **implemented 2026-10-24** (server 0.3.0, draw schema rev 4)
Three independent work items, deferred after the archer test exposed toolkit
weaknesses. Each part below is a self-contained brief: motivation, design
decisions, file-by-file changes, tests, risks, acceptance criteria.

Suggested order by value/effort: **Part 3 (preview)** → **Part 1 (fractional
geometry)** → **Part 2 (layers)**. Parts 1 and 3 are independent; Part 2 is a
standalone multi-day change.

Shared invariants every part must preserve (from `AGENTS.md`):
- Every mutation: `storage.beginEdit(name)` before, `storage.save(sprite)` after.
- A draw op needs both a zod variant in `src/tools.js` and a `switch` case in
  `model.applyOps`; the REST draw route reuses `drawOpsSchema` — one
  validation path.
- Palette index 0 is always transparent. Grid sizes 16/24/32/48/64.
- Update `SERVER_INSTRUCTIONS` (`src/tools.js`) and `README.md` with any op
  or tool semantic change.

---

# Part 1: Fractional geometry & coverage rasterization for shape ops

## 1.1 Motivation

The 64px archer exposed the ceiling of integer-only rasterization:

- The bow needed 4 hand-computed `line` segments (still visibly angular). The
  shipped `curve` op helps, but its bezier control point is integer-only and
  each sample is `Math.round`-ed onto the grid — fine arcs still quantize hard.
- Diagonals (bowstring, braced legs) can only start/end on whole pixels; a
  line that "should" run from (26.5, 24) to (45, 10.5) loses its endpoints.
- The only fractional geometry in the codebase today is `litEllipse`
  (`src/model.js`, accepts fractional cx/cy/rx/ry) — proof the concept fits,
  but it only paints shaded blobs, not strokes/outlines.

Goal: let `line`, `ellipse`, and `curve` accept **fractional coordinates** and
rasterize via **coverage sampling**, so placement accuracy (not hand-tuning)
decides which pixels light up.

## 1.2 Hard constraint: indexed grids have no alpha

Each grid cell holds one palette index. There is no per-pixel alpha channel,
so classic anti-aliasing (blending edge pixels toward the background) is
impossible in the general case. Therefore:

- **This plan is about fractional *placement* with a coverage threshold** —
  crisp pixels chosen by subpixel coverage — not soft/blurred edges.
  Pixel art at 16–64px wants crisp clusters; mushy AA edges fight the
  aesthetic (see `.opencode/skills/sprite-draw/references/pixel-art-basics.md`:
  banding and pillow shading are anti-patterns).
- Whole-sprite anti-aliasing already exists and stays the right tool for
  organic art: `generate_sprite` (`src/generate.js`) paints an RGBA canvas at
  grid×scale and area-averages down (`resizeAvg`, `src/reference.js:24`).
  Per-op coverage rasterization is the complement for **precise indexed
  edits** on an existing sprite. Document this division so agents pick
  correctly (see 1.5 docs).

## 1.3 Design decisions

### Trigger: integer input → legacy path, any fractional param → coverage path

The same op keeps two rasterizers:

- **All-integer parameters** → existing Bresenham/`inside()` code, untouched.
  Byte-identical output to today. Zero regression risk for reproducible
  prompts, the viewer's REST strokes (always integers), and existing tests.
- **Any fractional parameter** (e.g. `x0: 26.5`) → coverage rasterizer.

Rejected alternatives:
- *New op names (`fline`, `fellipse`)* — fragments the op vocabulary; agents
  already struggle to pick the right op.
- *A `smooth: true` flag* — redundant: fractionality is itself the signal.
  (A flag also allows the nonsensical `smooth: true` with all-int params.)
- *Always-on coverage rasterizer* — changes pixels for existing integer call
  sites (legacy `ellipse` has a deliberate `+0.5` radius fudge; coverage
  ellipse differs). Reproducibility matters more than elegance.

Runtime dispatch: `params.every(Number.isInteger)` in `applyOps`. Zod schemas
relax from `z.number().int()` to `z.number()` (see 1.4).

### Coverage by supersampling, threshold 0.5

Per op, iterate only the shape's bounding-box pixels. For each pixel, evaluate
the shape at an **8×8 subpixel grid** (64 samples; coverage quantization error
~1.6%, cost is trivial: worst case 64×64 grid = 262k point tests, sub-ms in JS).
Paint when `coverage >= 0.5`.

- Fixed threshold 0.5; a configurable threshold adds surface area for no
  proven gain (rejected, revisit if art direction asks).
- S=8 fixed. S=4 visibly misplaces thin strokes; S=16 is 4× cost for
  imperceptible change.

Shape tests per op:
- `line`: distance from subpixel to segment ≤ thickness/2 (capsule — round
  brush). **Note:** the legacy path uses a *square* brush; the coverage path's
  round brush is the one intentional visual divergence, documented in
  SERVER_INSTRUCTIONS. Thickness 1 → 1px-diameter stroke that places
  smoothly.
- `ellipse`: implicit test `((sx-cx)/rx)² + ((sy-cy)/ry)² ≤ 1` — no `+0.5`
  fudge (that fudge is legacy-path-only behavior). `filled: false` ring =
  coverage of outer ellipse minus interior of the (rx−1, ry−1) ellipse.
- `curve`: flatten the quadratic bezier to a polyline (~2× chord-length
  segments, min 16), then capsule-coverage over segments (max coverage, not
  additive). Replaces the current round-per-sample painting for fractional
  input; integer input keeps the existing implementation.

### Future hook (do not build now)

Coverage ∈ [0,1] is computed at paint time. A later `edgeShade: true` param
could map partial coverage to ramp-neighbor indices (darken toward the edge)
for ramp-organized palettes — a true AA look within the indexed model. This
plan's structure (coverage value available per pixel) must not preclude it.

## 1.4 File-by-file changes

### `src/model.js` (~+140 lines)

- New private helpers:
  - `isIntParams(op, keys)` — dispatch check.
  - `distToSegment(px, py, x0, y0, x1, y1)` — point-segment distance.
  - `paintCoverage(grid, sprite, bbox, testFn, color)` — shared 8×8 sampling
    loop, threshold 0.5, clips at grid edges (same clipping semantics as the
    legacy square brush).
- `case "line"`: dispatch; coverage branch = capsule over segment.
- `case "ellipse"`: dispatch; coverage branch = implicit test (filled) or
  ring (outer minus inner). Bounds loop uses `Math.floor/ceil` of
  cx±rx, cy±ry like `litEllipse` does.
- `case "curve"`: dispatch; coverage branch = flatten + capsule union.
- Keep legacy branches verbatim — do not "clean up" while touching; the
  characterization tests (1.6) pin their exact output.

### `src/tools.js` (~+30 lines)

- `line`/`ellipse`/`curve` schemas: coordinate fields `z.number().int()` →
  `z.number()`. `thickness` stays `int 1..4`. `ellipse` rx/ry keep `.min(1)`
  (fractional radii like 2.5 allowed; sub-1 radii rejected to avoid
  degenerate specks — decide during implementation, document either way).
- Descriptions: note that fractional coordinates trigger smooth
  coverage-based placement; integers keep the classic crisp rasterizer.

### Docs

- `SERVER_INSTRUCTIONS` (`src/tools.js`): extend the shape-ops bullet —
  fractional coords for line/ellipse/curve; one sentence on int→legacy vs
  float→coverage; one on when to prefer `generate_sprite` (organic AA)
  vs fractional ops (precise edits).
- `README.md` op list: same note, short.
- `AGENTS.md` "Invariants": add — *line/ellipse/curve have dual rasterizers:
  all-integer params must reproduce legacy output exactly; any fractional
  param selects coverage sampling. Characterization tests pin the legacy
  path.*

## 1.5 Validation / error behavior

- Floats accepted by zod; NaN/Infinity rejected (`z.number()` is finite by
  default in zod v3 — verify; if not, add `.finite()`).
- Bounds checks unchanged: `line`/`curve` endpoints must be on-grid — for
  fractional endpoints, check the **rounded** point against bounds (message:
  `endpoint (26.5,24) rounds to (27,24), out of bounds for 64x64 grid`).
  `ellipse` stays unclipped-loop style like today (partially off-grid
  ellipses paint their visible part) — match legacy semantics per branch.
- `curve` control point: remains unbounds-checked (off-grid shallow arcs),
  clipping identical in both branches.

## 1.6 Testing plan (`test/model.test.js`)

Phase 0 — **write characterization tests FIRST**, before touching
rasterizers, pinning current integer behavior:

1. Reference-copy approach: copy the existing legacy `line`/`ellipse`/`curve`
   bodies into the test file as `legacyLine(...)` etc.; property test —
   for a fixed sweep of integer params (horizontal, vertical, 45°, shallow
   slope, thick variants; a few ellipses incl. `filled:false`; one curve),
   assert `applyOps` output equals the reference copy output. This survives
   any internal refactor and *is* the regression net.
2. Keep the existing pixel-exact tests untouched (outline/shift/litEllipse/
   rampRect already pass and must not move).

Phase 1+ — new behavior tests:

3. Fractional line: `(2.5, 2.5) → (13.5, 2.5)` paints exactly one row per
   coverage (assert the chosen row and that neighbors stay empty);
   a line grazing a pixel at <50% coverage leaves it empty.
4. Symmetry invariants: reversed endpoints give identical pixels; ellipse
   `cx: 7.5` on a 16-grid is perfectly mirror-symmetric (use
   `mirrorHorizontal` to compare).
5. Fractional curve: control `(8, 1.5)` apex lands between the integer
   outcomes; endpoints `(3,11)`/`(13,11)` still painted exactly.
6. Ellipse ring with fractional radii: ring is 1px thick, no fill leak.
7. Schema tests (where tool-level tests exist): floats pass, `thickness: 1.5`
   rejected.
8. Thickness: `thickness: 2` fractional line ≈ legacy thickness-2 pixel count
   (±25% band, not exact — brush shape differs intentionally).

## 1.7 Rollout & risks

- **Phases:** 0 characterization tests → 1 coverage helper + line →
  2 ellipse (+ring) → 3 curve → 4 schemas + docs → 5 dogfood.
- **Dogfood (phase 5):** redraw the archer's bow as ONE fractional `curve`
  (tips (45,10)/(45,42), control ≈ (50.5,26)) replacing the 4 segments;
  inspect an enlarged render (scale 2) for arc placement, and render at
  scale 1 for the actual-size readability check; compare against `exports/`
  of the hand-drawn version. Success = visibly smoother arc at both sizes, no
  stray nubs.
- Risks:
  - *Coverage nubs*: single isolated pixels at arc tips. Mitigate by
    threshold 0.5 (no sub-half pixels ever); accept the rest as pixel-art
    character. No post-pass cleanup — determinism beats cleverness.
  - *Agent confusion over two rasterizers*: mitigate via one clear rule in
    SERVER_INSTRUCTIONS ("integers = classic crisp, fractions = smooth
    placement") and tool descriptions.
  - *Viewer/agent divergence*: none — viewer strokes are integers, legacy
    path, identical output.
  - *Performance*: bounded by bbox × 64 samples; worst realistic op
    (full-grid ellipse at 64px) ≈ 260k tests, sub-ms. No timing work needed;
    if a future grid size >64 appears, revisit S adaptively.

## 1.8 Acceptance criteria

1. `npm test` green, including the phase-0 characterization suite
   (integer output byte-identical to pre-change implementation).
2. Fractional line/ellipse/curve produce symmetric, threshold-clean results
   per 1.6 tests.
3. MCP + REST both accept fractional ops (shared `drawOpsSchema` — one
   validation path preserved).
4. Docs updated: `SERVER_INSTRUCTIONS`, `README.md`, `AGENTS.md` invariants.
5. Archer bow dogfood: one `curve` op replaces four segments; include a
   scale-1 actual-size render comparison (plus an enlarged scale-2 view for
   placement) in the closing commit/PR.

## 1.9 Explicit non-goals

- No per-pixel alpha, no blend modes, no RGBA grid.
- No changes to `generate_sprite` (it is the whole-canvas AA path and stays).
- No configurable coverage threshold or subpixel resolution.
- No viewer work, no export-format changes.
- No `rect` coverage (deferred; hard edges are usually wanted).

---

# Part 2: Layers

## 2.1 Motivation

The archer's worst workflow moment was op **ordering on a single shared
grid**: painting the red tabard overwrote the draw-arm, forcing a redraw of
the arm on top. Every overlap decision (tabard/arm, arrow/bow, string/chest)
required manual painter's-algorithm thinking, and one bad pass meant
pixel-surgery or a redraw.

Layers fix this structurally: body on one layer, costume on another, prop
(bow/arrow) on a third. They also enable non-destructive experiments (a
"sketch" layer that gets discarded) and per-layer outline.

This is the big one: it touches the data model, storage format, render,
export, REST, the viewer, and MCP tools.

## 2.2 Design decisions

### Scope: Option A (recommended) vs Option B

- **Option A — base-sprite layers, flat animation frames (MVP).**
  Layers exist on the base sprite only. `add_animation` flattens the
  composite into frame 0; frames stay single-grid as today.
  Solves the actual draw-ordering pain with a contained change.
- **Option B — Aseprite-style per-frame cels.** Layer definitions are
  sprite-wide; every frame (base + every animation frame) holds one grid per
  layer. Full power (animate a weapon layer independently), but it touches
  everything: `copy_frame`/`insert_frame`/`move_frame` semantics, memory
  (16 frames × L layers × 4096 cells), export, viewer timeline interplay.

**Recommendation: Option A**, with a JSON layout that doesn't foreclose B
(layer-keyed grids on the base sprite; B later extends the same shape to
frames). If A ships and agents/users actually ask for animated layers,
revisit B as its own plan.

### Data model (Option A)

```jsonc
{
  "name": "archer",
  "width": 64, "height": 64,
  "palette": ["#00000000", "..."],
  "layers": [
    { "name": "body", "visible": true },
    { "name": "costume", "visible": true }
  ],                       // order = z-order, index 0 = bottom
  "grids": { "body": [[...]], "costume": [[...]] },
  "animations": { /* unchanged: flat frames */ },
  "version": 42
}
```

- `sprite.grid` **ceases to exist as stored state** — replaced by
  `grids[layerName]`. The composite is derived, never stored (stored derived
  state = sync bugs).
- **Migration** in `storage.get()`: a file without `layers` loads as
  `layers: [{name: "base", visible: true}]`, `grids: { base: oldGrid }`.
  Written back on next save. Old files keep working; no version flag needed.
- `createSprite` starts with one `"base"` layer.
- No `activeLayer` in the JSON — that's per-client UI state. MCP/REST `draw`
  accepts `layer: "<name>"`; **default = topmost layer** (the natural "draw
  on top" behavior). The viewer tracks its own active layer and includes it
  in stroke uploads.

### Flatten semantics

`flatten(sprite)` in `src/model.js`: composite grid, bottom-to-top; per
pixel, the topmost **visible** layer with a non-zero index wins (index 0 is
transparent; all other indices opaque — no blending in an indexed model).
`renderPng`, `renderOnionSkin`, `exportSprite`, and the REST render route all
call `flatten` first.

### Op semantics under layers

- All draw ops target **one layer's grid** — `targetGrid(sprite, frame)`
  becomes `targetGrid(sprite, frame, layerName)` (layer ignored for frames;
  frames are flat in Option A).
- `outline`, `fill`, `mirror` are **layer-local** (outline wraps the active
  layer's silhouette, not the composite). Predictable and documented;
  composite-aware outline would couple layers and cascade weirdly when one
  layer changes.
- `outline scope: "new"` (shipped) keeps working — its pre-call snapshot is
  the layer's grid.

### Tool / API surface

- MCP: `draw` gains `layer` (name, default topmost). `get_render` gains
  optional `layer` to inspect one layer (default: composite).
- New MCP tools, minimal set: `add_layer(name)` (appends on top),
  `remove_layer(name)` (refuses the last remaining layer),
  `reorder_layer(name, toIndex)`, `set_layer_visibility(name, visible)`.
  Rename: skip (remove+add covers it; renaming breaks grid keys).
- REST: `/api/sprite/:name/draw` accepts `layer`; new route
  `/api/sprite/:name/layers` POST for add/remove/reorder/visibility.
- Undo/redo: snapshots are `JSON.stringify(sprite)` — layers flow through
  for free. ✓ (Regression-test this.)
- SSE events unchanged (whole-sprite version bumps).
- Export: flattened composite per frame — **sheet format unchanged** (engines
  never see layers). Non-goal: writing layer metadata into the Aseprite JSON.

### Viewer (`public/js/`)

The largest single chunk of Part 2:

- Sidebar layer panel: list in z-order, click to activate, eye toggles,
  add/remove buttons, drag or arrows to reorder.
- Canvas renders the composite (flatten); strokes upload with the active
  layer name.
- Onion skin still operates on flattened frames — unchanged conceptually.
- Plain ES modules, no build — moderate but real work; keep the panel dumb
  (server is source of truth, SSE refreshes).

## 2.3 File-by-file changes

- `src/model.js`: `createSprite` (layered shape), `flatten()`, layer-aware
  `targetGrid`, `addLayer/removeLayer/reorderLayer/setLayerVisibility`
  helpers, `addAnimation` flattens composite into frame 0.
- `src/storage.js`: migration on `get()` (wrap legacy `grid`), nothing else —
  save/history are shape-agnostic.
- `src/tools.js`: `layer` params on `draw`/`get_render`, four layer tools,
  `SERVER_INSTRUCTIONS` (one bullet: layers = z-ordered grids, draw targets
  topmost by default, ops are layer-local, animation flattens).
- `src/server.js`: `layer` passthrough in draw route, layers route.
- `src/render.js`, `src/export.js`: flatten before render/export.
- `public/js/`: layer panel + active-layer stroke uploads + composite canvas.
- `README.md`: layers section (model, flatten rule, why frames are flat).
- `AGENTS.md`: invariant addition — *sprite.grid is derived via flatten();
  stored state is grids[layer]; legacy files migrate on load.*

## 2.4 Testing plan

- Migration: legacy JSON (no `layers`) loads as one base layer; grid content
  preserved; save writes new shape.
- Flatten: 3 layers, top non-transparent wins; hidden layer skipped; index 0
  on top reveals lower layer.
- Draw targets the named layer only; default = topmost.
- Layer-local outline: a blob on layer 2 outlined does not wrap layer 1
  pixels.
- `add_animation`: frame 0 equals the flattened composite; subsequent frames
  blank; layer edits afterwards don't leak into frames.
- `remove_layer` refuses the last layer; `reorder_layer` changes flatten
  output correctly.
- Undo across layer ops (add layer → draw → undo → draw gone → undo →
  layer gone).
- Export: sheet equals composite.
- Existing 45+ tests keep passing (they exercise `createSprite` grids — the
  migration shim must make old call sites behave as before; if
  `createSprite` changes shape, update tests to go through a `baseGrid()`
  helper rather than `sprite.grid` directly).

## 2.5 Risks

- **Blast radius**: `sprite.grid` is referenced across model/render/export/
  viewer/tests. Mitigate with a `baseGrid()`/`flatten()` accessor and a
  grep-driven migration checklist; do the mechanical swap in one commit
  before adding features.
- **Agent confusion** ("where did my pixels go" when drawing on the wrong
  layer): default-topmost + headroom-note-style reminder in the draw result
  naming the target layer.
- **Scope creep toward Option B**: frames stay flat in this plan, full stop.
- **Viewer desync**: active layer is client state; SSE refresh must not
  reset the user's selected layer (store selection in viewer state, not from
  sprite JSON).

## 2.6 Acceptance criteria

1. Legacy sprite files load and render identically (migration).
2. Draw on named layers via MCP and REST; composite renders match manual
   expectation; per-layer render works.
3. Layer add/remove/reorder/visibility via MCP and viewer; undo/redo across
   all of it.
4. Animations created from a layered base flatten correctly; export sheet
   unchanged in format.
5. Dogfood: rebuild the archer with body/costume/prop layers — tabard pass
   must NOT require redrawing the arm (that's the regression test for the
   original pain).
6. Tests green; docs updated (`SERVER_INSTRUCTIONS`, `README.md`,
   `AGENTS.md`).

## 2.7 Non-goals

- No per-frame cels (Option B), no layer blend modes/opacity (indexed model),
  no layer locking, no layer export metadata, no layer naming conventions
  enforced.

---

# Part 3: Preview-without-commit for `draw`

## 3.1 Motivation

The vision loop is now one call (draw returns the render inline), but every
draw still **commits**: a speculative pass ("would this helmet look better a
pixel up?") costs an undo to retract. The archer session needed exactly one
such retraction (the silhouette redraw) — cheap here, expensive on a detailed
sprite where `undo` also discards the *good* ops in the same call.

`undo` covers recovery; preview covers **exploration** — see the result
without touching state, history, or the viewer.

## 3.2 Design

- `draw` gains `commit: boolean` (default `true` — current behavior).
- With `commit: false`: clone the target grid (`grid.map(r => [...r])`),
  run `applyOps` on the clone, render the clone, return text + image.
  No `beginEdit`, no `save`, no version bump, no SSE event, no history entry.
- Works with `frame` targeting and `mirror` (both operate on the clone).
- Response text must be unambiguous to prevent state confusion:
  *"PREVIEW ONLY — not saved. Re-run without commit:false to apply."*
- **Viewer**: previews are agent-eyes-only; the viewer keeps showing the last
  committed state. (Rejected: broadcasting a `{type:"preview"}` SSE event and
  ghost-rendering it in the viewer — real viewer complexity for a niche
  benefit; revisit only if users ask.)
- **REST**: not added — the REST draw route exists for viewer strokes, which
  are always committed. Keeps one validation path, zero viewer impact.
- Not extended to `generate_sprite` in this plan (it already returns its
  render; a `commit:false` there means "return render, persist nothing" —
  easy follow-up, separate decision about the overwrite-exists guard).

## 3.3 File-by-file changes

- `src/tools.js`: schema + handler branch (~25 lines), tool description,
  `SERVER_INSTRUCTIONS` one-liner (use preview for speculative passes; it
  saves and history-pollutes nothing).
- `README.md` tools paragraph: one clause.
- No `model.js`/`storage.js` changes — preview is a pure handler-side clone.

## 3.4 Testing plan

- Preview does not bump `version`, does not push history (subsequent `undo`
  errors with "nothing to undo"), does not emit SSE (subscribe-and-assert-
  silence), and the returned render matches what a committed run of the same
  ops produces.
- Preview against an animation frame target clones the frame, not the base.
- Tool-level: these need a storage-backed harness like `test/editor.test.js`
  uses; add cases there rather than in `model.test.js`.

## 3.5 Risks

- *State confusion* (agent believes preview committed): mitigated by the
  response text and by `get_grid`/render always reflecting committed state.
- Near-zero technical risk; the clone is 16–64×16–64 ints.

## 3.6 Acceptance criteria

1. `commit:false` renders the would-be result; committed state, history,
   version, and SSE are untouched.
2. Re-running the same ops without `commit:false` produces a grid identical
   to the previewed one.
3. Tests green; `SERVER_INSTRUCTIONS` + `README.md` updated.

## 3.7 Non-goals

- No REST/viewer preview, no SSE preview events, no `generate_sprite`
  preview, no multi-op "transaction" staging area.

---

# Implementation notes (2026-10-24)

All three parts landed together at server **0.3.0 / draw schema rev 4**;
`npm test` is green (107 tests).

- **Part 3 (preview):** MCP `draw` accepts `commit: false`; `previewDraw()` in
  `src/draw.js` reuses `stageDraw()` so the preview and the committed run
  produce the identical grid/render. Capabilities advertise `previewDraw`.
  Tests cover base/frame previews, no version/history/SSE mutation, and
  preview-vs-commit render equality.
- **Part 1 (fractional geometry):** `line`, `curve`, and `ellipse` schemas
  accept finite floats. Any fractional param selects the 8×8 coverage
  rasterizer (`paintCoverage`); all-integer params keep the legacy
  Bresenham/sample/`inside(+0.5)` paths byte-for-byte (pinned by reference-copy
  characterization tests in `test/fractional.test.js`). Coverage samples around
  the pixel's integer center (the same convention as legacy ops and
  `litEllipse`), so half-pixel-centered shapes stay symmetric under
  `mirrorHorizontal`. Fractional endpoints are bounds-checked after rounding.
- **Part 2 (layers, Option A):** stored state is `layers` + `grids[layer]`;
  `sprite.grid` is gone and legacy files migrate in `Storage.get()`.
  `flatten()` is used by render/export/animation frame 0. `draw`, `get_render`,
  `export_render`, and `get_grid` accept `layer` (default topmost/composite).
  New MCP tools `add_layer` / `remove_layer` / `reorder_layer` /
  `set_layer_visibility` and `POST /api/sprite/:name/layers` validate on a
  throwaway clone before `beginEdit()`. The viewer has a layer panel (activate,
  eye, reorder, add/remove) and uploads strokes to the active layer while the
  canvas shows the composite.
- **Dogfood:** a 16px smoke sprite was drawn in a throwaway project root with a
  fractional-thickness-2 bow `curve` on a `prop` layer and a fractional
  `line` string; composite and per-layer renders were inspected at 24×. No
  generated art was committed and the temporary root was deleted. The
  project's gitignored `sprites/` directory was not modified by the smoke run.

