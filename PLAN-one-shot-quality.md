# Plan: One-shot character quality and tooling reliability

Status: **Implemented and dogfooded 2026-10-24**

Audience: a worker LLM implementing the changes without further architectural direction.

This plan follows the second 64px side-view archer dogfood. The sprite was
recognizable, but the quiver merged with the drawing arm, the legs were too
thin, and the final review mistook a 2x render for actual game size. The audit
also found two concrete correctness problems: reference palette extraction can
stop after only a few colors, and the MCP capabilities exposed during the
session were older than the current source.

The goal is not to make this one archer prettier by hand. The goal is to make a
fresh agent session produce better first-pass character art from one prompt,
while making the editing tools deterministic and safe.

---

## 0. Worker instructions

Read `AGENTS.md` before changing code. Also read the current source and tests;
line numbers in this plan describe the 2026-10-24 baseline and are not a
substitute for re-reading the implementation.

### Working rules

- Implement the phases in order. Each phase is an independently reviewable
  change set with tests and documentation.
- Run `npm test` after every phase, not only at the end.
- Write failing regression tests before fixing each confirmed bug.
- Keep the project as plain ESM on Node >=20. Do not add a build step, bundler,
  TypeScript, formatter, or new runtime dependency.
- Preserve palette index 0 as transparent, grid sizes `16/24/32/48/64`, and the
  shared MCP/REST `drawOpsSchema` validation path.
- Every committed mutation still needs `storage.beginEdit(name)` before the
  mutation and `storage.save(sprite)` after it. Phase 2 clarifies how staging
  fits around that rule.
- Do not commit generated sprites, exports, references, or other runtime data.
  Test fixtures must be synthetic or committed deliberately under `test/`.
- Do not hand-edit the existing `archer_side` sprite to claim success. Final
  validation is a fresh one-shot prompt in a fresh agent session.
- Update `SERVER_INSTRUCTIONS`, the MCP tool descriptions, `README.md`, and
  relevant skills whenever public semantics change.
- If `PLAN.md` work has landed before this plan is implemented, preserve it and
  adapt the relevant phase rather than reverting it. Integration notes appear
  below.

### Explicitly separate existing roadmap work

Do **not** implement these as part of this plan:

- fractional coverage rasterization (`PLAN.md` Part 1);
- the layer system (`PLAN.md` Part 2);
- preview via `draw({ commit: false })` (`PLAN.md` Part 3).

Phase 2 should make the planned preview easier to implement. Phase 6 must not
change the rasterization behavior of existing `line`, `ellipse`, or `curve`.

### Delivery map

| Phase | Outcome | Main files |
|---|---|---|
| 1 | Correct palette extraction and painter color mixing | `src/reference.js`, `src/generate.js`, their tests |
| 2 | Atomic draw commits for MCP and REST | `src/model.js`, new `src/draw.js`, `src/tools.js`, `src/server.js` |
| 3 | Detect and prevent stale capability confusion | `src/version.js`, `src/tools.js`, `src/server.js`, `test/mcp.test.js` |
| 4 | Correct and consistent agent workflow | skills, `SERVER_INSTRUCTIONS`, README, roadmap wording |
| 5 | Useful reference palettes, explicit outline roles, correct resizing | `src/reference.js`, new `src/palette.js`, palette/tool tests |
| 6 | Better primitives for tapered character anatomy | `src/model.js`, `src/tools.js`, model/MCP tests |
| 7 | Fresh-session one-shot quality validation | dogfood notes only; no generated art committed |

Phases 1, 2, and the documentation corrections in Phase 4 are the highest
value/effort ratio. Do not begin with new drawing primitives while the known
correctness bugs remain.

---

## Phase 1: Fix palette extraction and generator color correctness

### 1.1 Problems to reproduce

`extractPalette()` in `src/reference.js` currently has three defects in its
median-cut branch:

1. It chooses the largest bucket without checking whether that bucket can be
   split. A dominant singleton color can therefore terminate extraction while
   other buckets still contain many colors.
2. Its weighted split is not constrained to produce two nonempty buckets. An
   empty bucket can later produce `NaN` channel averages and invalid hex.
3. Quantized buckets are not sorted by represented pixel count on return, even
   though the function contract says colors are frequency ordered.

The saved archer reference demonstrated the first bug: requesting 16 colors
returned only four, while requesting 31 returned all 25 opaque source colors.
Do not make tests depend on that gitignored file.

Also fix `mix()` in `src/generate.js`: mapping over the first color array while
indexing an unnormalized second array produces `NaN` or drops alpha when RGB
and RGBA inputs are mixed.

### 1.2 Median-cut implementation

Keep the public signature and return type in this phase:

```js
extractPalette(png, maxColors = 12) // -> string[] of #rrggbb colors
```

Preserve the existing fast path: when the number of opaque unique colors is at
most `maxColors`, return those exact colors ordered by frequency.

Replace the bucket loop with these semantics:

1. Ignore pixels with alpha `<128`, as today.
2. Keep entries as `{ r, g, b, count }` and preserve deterministic source order
   for ties.
3. At each iteration, consider only buckets with at least two entries.
4. Select the splittable bucket with the largest represented pixel count. Use a
   deterministic tie-break (largest channel range, then stable original order).
5. Stop only when the target count is reached or no bucket is splittable.
6. Split along the widest RGB channel, as today, but choose a boundary only
   from `1..bucket.length - 1` after sorting:
   - compute cumulative represented weight at every valid boundary;
   - choose the boundary whose left-side weight is closest to half the total;
   - break ties toward the lower boundary index;
   - both slices must be nonempty by construction.
7. Average only nonempty buckets, weighting channels by `count`.
8. Return buckets sorted by represented pixel count, descending, with stable
   deterministic ties. Map to normalized lowercase `#rrggbb` strings.

Do not add chroma-reservation, perceptual quantization, or other aesthetic
changes in this phase. This is a correctness fix with minimal behavioral
change beyond eliminating early stops, empty buckets, and ordering drift.

### 1.3 Guard the generator against invalid internal colors

In `generateSprite()`:

- Replace silent `parseColor(c) ?? [0, 0, 0, 0]` handling for extracted colors
  with an explicit assertion/throw such as
  `internal error: palette extractor returned invalid color "..."`.
- A valid extractor should make this unreachable; the guard prevents a future
  regression from silently producing invisible or incorrectly mapped art.

Normalize painter colors before mixing:

```js
function rgba(c) {
  return c.length === 4 ? c : [c[0], c[1], c[2], 255];
}
```

`mix(a, b, t)` must interpolate all four channels and always return a finite
`[r, g, b, a]` array. Existing RGB calls must produce the same painted RGB and
opaque alpha as before.

### 1.4 Tests

Extend `test/reference.test.js`:

- **Dominant singleton regression:** build a synthetic PNG containing a large
  solid-color region plus enough other distinct colors to require median cut.
  Request four or more colors. Assert the requested count is reached while
  enough source colors remain splittable.
- **Dominant extreme/weighted split regression:** construct heavily unbalanced
  frequencies at channel extremes. Assert no empty bucket and no invalid hex.
- Add a small deterministic property sweep over generated synthetic images:
  every returned color matches `/^#[0-9a-f]{6}$/`, no result contains `NaN`,
  and the count never exceeds either `maxColors` or the opaque unique count.
- Assert quantized results are frequency ordered using a fixture whose bucket
  populations are known.
- Keep the existing few-color verbatim and transparency tests unchanged.

Extend `test/generate.test.js`:

- Generate an image with one dominant flat color plus multicolor accents;
  assert every palette entry is valid and all nonzero grid indices resolve to
  valid opaque colors.
- Test RGB/RGB, RGB/RGBA, and RGBA/RGB `mix()` inputs. Assert all four channels
  are finite and alpha is interpolated correctly.
- Preserve the existing ramp organization and deterministic RNG tests.

### 1.5 Done when

- The new tests fail on the old implementation and pass on the fix.
- `npm test` is green.
- No generated palette can contain invalid hex or silently substitute
  transparent black for an extractor error.

---

## Phase 2: Make MCP and REST draws atomic

### 2.1 Problem

Both MCP and REST currently call `applyOps()` directly on the cached mutable
grid. If a later op fails, earlier writes remain in the cached object even
though `save()` is skipped. That leaves no version bump or SSE event, and a
later save can persist the hidden partial pass. Calling `beginEdit()` before a
failing operation can also pollute undo history.

The fix must guarantee that a failed draw changes none of:

- base grid or animation frame;
- persisted JSON;
- sprite version;
- undo/redo stacks;
- SSE events.

### 2.2 Add a pure staged-draw helper in `src/model.js`

Keep `applyOps(sprite, grid, ops)` unchanged for existing callers and tests.
Add an exported helper with this shape:

```js
const staged = stageDraw(sprite, frame, ops, mirror = false);
// staged.grid is a clone with all ops applied
staged.commit(); // replaces only the intended base/frame grid in sprite
```

Required behavior:

1. Resolve `frame` with `targetGrid()` before cloning so invalid animation
   targets fail before mutation.
2. Clone every row of the target grid.
3. Run all ops against the clone.
4. Apply `mirrorHorizontal()` to the clone when requested.
5. Return the staged grid and a commit closure.
6. `commit()` assigns `sprite.grid = stagedGrid` for the base, or replaces the
   exact animation frame for a frame target. It must not call storage and must
   not alter version/history.
7. Until `commit()` runs, the original sprite must remain byte-for-byte
   equivalent in its grid data.

A closure is intentional: MCP/REST can stage first, then create one undo
snapshot immediately before the single commit.

### 2.3 Share storage-aware commit logic

Create `src/draw.js`:

```js
export function drawAndSave(storage, name, { frame, ops, mirror = false }) {
  // get sprite -> stageDraw (all validation/work happens here)
  // storage.beginEdit(name) only after staging succeeds
  // staged.commit()
  // storage.save(sprite)
  // return { sprite, grid: staged.grid }
}
```

Use this helper from both:

- MCP `draw` in `src/tools.js`;
- REST `/api/sprite/:name/draw` in `src/server.js`.

Keep zod validation before `drawAndSave()`. The returned grid is the one to
render in the MCP response. Preserve headroom notes, inline render behavior,
mirror text, and REST response shape.

Do not refactor the HTTP server merely to add tests. Testing the shared helper
plus an MCP-level test gives useful coverage without changing server startup
semantics.

### 2.4 Tests

Add coverage in `test/editor.test.js` or a focused `test/draw.test.js`:

- A valid first op followed by an out-of-bounds or invalid-color op throws;
  grid JSON, version, persisted file, events, and undo/redo depth are unchanged.
- The same guarantee holds when targeting an animation frame.
- A successful multi-op draw commits exactly once, emits exactly one event,
  advances version once, and creates exactly one undo snapshot.
- Undo after a successful draw restores the whole pre-draw state, not a partial
  operation sequence.
- Mirror is applied to the staged grid and committed to the intended target.
- Direct `stageDraw()` without `commit()` never mutates the source grid.

### 2.5 Integration notes

- `PLAN.md` Part 3 can later reuse `stageDraw()` for `commit: false`; do not add
  the preview flag here.
- If layers have landed, stage the selected layer grid and commit back to that
  same layer. Do not introduce a second composite-grid mutation path.

### 2.6 Done when

A failed multi-op draw is completely invisible to storage, history, version,
SSE, and subsequent reads. MCP and REST use the same commit helper and all
existing draw behavior remains unchanged on success.

---

## Phase 3: Add capability/version reporting and MCP schema tests

### 3.1 Problem

The archer session advertised ten draw ops, while current source supports
`curve`, `litEllipse`, and `rampRect` as well. It also lacked other capabilities
present in source. A fresh MCP server per POST does not reload imported JS
modules, and clients can cache tool schemas. The unchanged `0.1.0` server
version gives no useful diagnostic signal.

A source test cannot force an already-running client to refresh. The solution
is therefore twofold: runtime version/capability diagnostics and explicit
restart/reconnect guidance, backed by an MCP `tools/list` regression test.

### 3.2 Single server version source

Create `src/version.js`:

```js
export const SERVER_VERSION = // read package.json version once via fs + import.meta.url
export const DRAW_SCHEMA_REVISION = 1;
```

Use `SERVER_VERSION` for both `createMcpServer()` metadata and the startup log
in `src/server.js`. Include `DRAW_SCHEMA_REVISION` in the startup log.

Set the package version to `0.2.0` with
`npm version 0.2.0 --no-git-tag-version`; this updates `package.json` and the
lockfile consistently. Do not create a git tag.

Document the rule: any addition or semantic change to a draw op increments
`DRAW_SCHEMA_REVISION`. Phase 6 increments it to 2.

### 3.3 Expose capabilities

Export the supported draw op names from `src/tools.js`, derived from the zod
union rather than maintaining a second hand-written ordering:

```js
export const DRAW_OP_TYPES = Object.freeze(
  drawOp.options.map((option) => option.shape.type.value)
);
```

Add a `get_capabilities` MCP tool returning JSON text with at least:

```json
{
  "serverVersion": "0.2.0",
  "drawSchemaRevision": 1,
  "drawOps": ["rows", "rect", "pixels", "clear", "outline", "fill", "line", "curve", "ellipse", "litEllipse", "rampRect", "block", "shift"],
  "gridSizes": [16, 24, 32, 48, 64],
  "features": {
    "transactionalDraw": true,
    "inlineDrawRender": true,
    "generateSprite": true
  }
}
```

The array above is the Phase 3 baseline; derive it at runtime and let Phase 6
append the new ops. Add `GET /api/capabilities` returning the same object so a
user can diagnose a daemon without an MCP client.

Update the README tool list and development/troubleshooting section:

- after changing tool code or schemas, restart the daemon;
- reconnect the MCP client or start a fresh agent session;
- compare `get_capabilities` with the running daemon when tools appear stale;
- creating a fresh transport per request does not hot-reload source modules.

### 3.4 MCP integration tests

Create `test/mcp.test.js` using the SDK's in-memory transport:

- `Client` from `@modelcontextprotocol/sdk/client/index.js`;
- `InMemoryTransport` from `@modelcontextprotocol/sdk/inMemory.js`;
- a temporary `Storage` root and `createMcpServer(storage)`;
- close client/server/transport resources after each test.

Tests must:

1. Call `tools/list`, locate `draw`, and recursively inspect its JSON schema
   for the op discriminators. Assert the advertised set equals
   `DRAW_OP_TYPES`. Do not depend on irrelevant SDK formatting details.
2. Assert the baseline set contains every currently implemented op, including
   `curve`, `litEllipse`, and `rampRect`. Update the expected set in Phase 6.
3. Call `get_capabilities` and verify version, schema revision, grid sizes, and
   draw op names agree with `tools/list`.
4. Call MCP `draw` with a valid op followed by an invalid op. Assert an
   agent-readable error and verify the Phase 2 no-mutation guarantees through
   `storage.get()` and undo history.

### 3.5 Done when

A worker can identify the running server/schema, tests prove the advertised
MCP draw schema matches the registered zod union, and documentation explains
how to recover from stale capabilities.

---

## Phase 4: Correct the one-shot drawing workflow

This phase changes instructions, not rasterization.

### 4.1 Actual-size and inline-render guidance

Update all relevant locations:

- `SERVER_INSTRUCTIONS` in `src/tools.js`;
- MCP `create_sprite`, `draw`, `get_render`, and `fetch_reference` descriptions
  and result text;
- `.opencode/skills/sprite-draw/SKILL.md`;
- `.opencode/skills/sprite-draw/references/worked-example.md`;
- `.opencode/skills/sprite-research/SKILL.md`;
- scale-check acceptance wording in `PLAN.md`;
- this plan only if a later phase changes the workflow again.

Use one consistent rule:

1. `draw` returns an inline render by default; critique that image instead of
   blindly requesting the same render again.
2. Use `get_render` when changing scale/grid/target or when inline rendering
   was skipped.
3. Inspect an enlarged render for pixel placement.
4. Before completion, inspect `scale: 1` for actual-size readability. An
   additional `scale: 2` view is allowed, but is not the actual-size test.

### 4.2 Shape-first and complex-character checklist

Fix contradictory examples:

- `create_sprite` must not recommend a full-sprite `rows` silhouette. Suggest
  `ellipse`, `line`, `rect`, `block`, and `curve` as appropriate.
- `draw` should describe `line` for straight limbs/props and `curve` for arcs,
  not imply that chained lines are the preferred bow implementation.
- `sprite-draw` should use one `curve` for a bow, not 3–4 chained segments.
- Keep `rows` for whole-sprite fills and the existing small worked example;
  do not rewrite that example merely to use more operations.

Add a mandatory silhouette gate to `sprite-draw` before any detail pass:

- subject and pose read without facial details or shading;
- head/torso/leg proportions are intentional;
- thighs, calves, ankles, and feet have distinct, readable widths;
- feet are grounded and broader than ankles where appropriate;
- bent arms have visible negative space and do not read as straight bars;
- back equipment does not merge with elbows, arms, or the torso;
- touching parts differ in value or hue, and 1–2px separation is provided when
  the design allows it;
- weapons and extremities preserve animation headroom.

If any item fails, patch the silhouette. Do not use shading to conceal an
anatomy or overlap problem. Include a back-to-front order note for rear props,
body, costume, arms, then held props.

Clarify that `generate_sprite` is a candidate for organic/gradient-heavy art
and grids >=48, not an automatic choice for every large character. Direct
shape ops remain appropriate for crisp, hard-edged character silhouettes.

### 4.3 Palette documentation corrections

- In `create_sprite`, replace the hard-coded default “16-color palette” with
  dynamically derived text: 23 opaque colors plus transparent index 0.
- Update `.opencode/skills/palette-design/SKILL.md` with the same default size.
- Correct `.opencode/skills/sprite-refine/SKILL.md`: `set_palette` replaces the
  entire ordered palette and clamps indices when the new palette is shorter;
  it does not swap one entry. For one color change, instruct the agent to get
  the complete palette, preserve its order/length, and change only that hex,
  or use the viewer's single-index REST editor.
- In `sprite-research`, clarify that `fetch_reference` accepts HTTP(S) PNG URLs
  only. A local image can be inspected with the host's image-reading tool; do
  not pass a local path to `fetch_reference`.

### 4.4 Done when

A text search finds no instruction calling `scale: 2` the actual/game-size
truth test, no recommendation to chain bow line segments, no stale default
palette count, and no claim that `set_palette` edits one entry. The silhouette
checklist explicitly covers leg widths and prop/arm tangencies.

---

## Phase 5: Improve reference preparation and palette roles

This phase has three related parts: exact resizing, reusable palette metadata,
and direct reference-to-`set_palette` guidance. Keep the public sprite JSON
backward compatible; old files without new fields must still load.

### 5.1 Make `resizeAvg()` a true area average

The current implementation averages whole source pixels between floored
boundaries. Replace it with fractional source-pixel coverage:

For every destination pixel:

1. Compute source rectangle `[x0,x1) × [y0,y1)` using floating coordinates.
2. Iterate only source pixels intersecting that rectangle.
3. Compute each source pixel's `overlapX * overlapY` area.
4. Accumulate alpha-weighted RGB using `channel * alpha * area`.
5. Accumulate alpha as `alpha * area`, divided by total destination source area.
6. Divide RGB by total accumulated alpha-weight, preserving the current rule
   that transparent RGB cannot muddy edges.

Integer-ratio resizing must produce byte-identical output to the old
implementation. Noninteger ratios should no longer shift or unevenly weight
edge source pixels.

Add hand-computed noninteger downscale tests in `test/reference.test.js`, plus
integer-ratio and alpha-weighting regression tests.

### 5.2 Move shared palette organization into `src/palette.js`

Avoid a dependency cycle between reference preparation and generation. Move
these private/public palette helpers out of `src/generate.js`:

- `rgbToHsl` and hue naming helpers (private);
- `organizePalette(hexes, counts)` (exported);
- new `suggestOutlineIndex(palette)` (exported);
- new `rampTripleSuggestions(family)` (exported).

`generate.js` may re-export `organizePalette` temporarily for compatibility,
but new code should import from `src/palette.js`.

Define helpers as follows:

- `suggestOutlineIndex(palette)` ignores index 0/fully transparent colors and
  returns the opaque index with lowest `(0.2126*r + 0.7152*g + 0.0722*b)`.
  Return 1 for an otherwise empty palette.
- `rampTripleSuggestions({ from, to })` returns adjacent `[light,mid,dark]`
  triples only for families with at least three entries. A four-color family
  yields its two sliding triples; one- and two-color families yield no triple
  and must not be presented as valid `litEllipse` ramps.

Do not generalize `litEllipse` in this phase.

### 5.3 Add explicit outline metadata

Add optional `sprite.outlineIndex`:

- `createSprite()` sets `outlineIndex: 1`.
- Legacy sprites without it behave as 1.
- `generateSprite()` replaces the default with
  `suggestOutlineIndex()` after palette organization, because generated index 1
  can be a light color.
- `outline` ops use `sprite.outlineIndex ?? 1` when no explicit `color` is
  supplied. An explicit op color always wins.
- Include `outlineIndex` in `get_state` and at the top of `get_palette` output.

Extend MCP `set_palette` arguments:

```js
{
  sprite,
  colors,                    // existing complete ordered #rrggbb array
  outlineIndex?: number,     // index after transparent 0 is prepended
  rampFamilies?: Array<{ name: string, from: number, to: number }>
}
```

Semantics:

- Omitting `outlineIndex` preserves current behavior and defaults to 1.
- Omitted `rampFamilies` deletes old generated/reference ramp metadata, as the
  current palette replacement already does.
- Supplied families use final palette indices, including transparent index 0 in
  the indexing scheme; require `1 <= from <= to < palette.length` and nonempty
  names. Reject overlapping families with an agent-readable error.
- Normalize and validate all colors, outline index, and families **before**
  `beginEdit()`. Then replace the palette, clamp existing indices exactly as
  today, save metadata, and call `save()` once.
- REST single-index palette edits continue to delete `rampFamilies` because a
  manual color edit invalidates shade organization; they leave `outlineIndex`
  unchanged because the index itself did not move.

### 5.4 Make custom/generated ramp guidance truthful

Update `get_palette` and `generate_sprite` result text:

- Always print the prop-contrast reminder, not only for the default palette.
- Print generated or supplied `rampFamilies` for custom palettes too.
- For each family, show only valid triples from `rampTripleSuggestions()`.
- For one- and two-color families, say they support manual light/dark shading
  but not a three-stop `litEllipse` ramp.
- Preserve default per-index labels and add a default-family definition for
  guidance without requiring migration of legacy sprite JSON.

### 5.5 Prepare references at the correct dimensions

Refactor reference image preparation into a pure helper in `src/reference.js`,
for example:

```js
prepareReference(png, { width, height, colors = 12 })
```

It should return the capped original view, target-size pixelated image,
nearest-neighbor display image, extracted colors/counts, and suggested palette
arguments. Network download remains in `fetchReference()`.

Use `prepareReference()` from MCP `fetch_reference`:

- Existing sprite: use both `sprite.width` and `sprite.height`.
- Bare `gridSize`: preserve square behavior.
- Display scale is based on the longest target dimension.
- Result text reports actual `width x height`, not an assumed square.

Add `extractPaletteDetailed()` returning final colors plus represented counts;
keep `extractPalette()` as a compatibility wrapper returning only colors. Use
`organizePalette()` to build a **suggested** palette for a new sprite. Since the
research workflow applies it before drawing, reorganizing reference colors is
safe and does not remap existing art.

Return a directly usable JSON argument block in the tool text:

```json
{
  "colors": ["#...", "..."],
  "outlineIndex": 4,
  "rampFamilies": [{ "name": "skin", "from": 5, "to": 7 }]
}
```

`colors` excludes transparent index 0 because `set_palette` adds it; family
and outline indices include that prepended slot. Tell the agent to call
`set_palette` with the block and then `get_palette` for index-specific drawing
guidance. Do not claim frequency ordering for this organized suggestion.

### 5.6 Tests

Add tests for:

- `suggestOutlineIndex()` with dark outlines, light first colors, and empty
  palettes;
- outline op default vs explicit color override;
- generated sprite outline index and preserved grid remapping;
- ramp triple suggestions for 1/2/3/4-entry families;
- valid custom `set_palette` metadata via the Phase 3 in-memory MCP harness;
- invalid outline/family indices and overlapping families leaving palette,
  pixels, history, version, and events unchanged;
- legacy sprites without `outlineIndex` or `rampFamilies`;
- rectangular `prepareReference()` output dimensions and display scaling;
- suggested palette arguments round-tripping through `set_palette` validation;
- integer-ratio resize equivalence and exact noninteger coverage.

### 5.7 Done when

A rectangular reference is prepared without distortion, all resize behavior is
mathematically area weighted, custom palettes can carry usable ramp metadata,
and `outline` never defaults to an arbitrary light color on newly generated or
reference-adopted palettes.

---

## Phase 6: Add anatomy-friendly shape primitives

Add exactly two ops in this phase: `polygon` and `taperedLine`. These target the
observed one-shot limitations without changing existing rasterizers.

### 6.1 `polygon`

Schema:

```js
{
  type: "polygon",
  points: [[x, y], [x, y], [x, y], ...], // 3..16 integer vertices
  color
}
```

Behavior:

- Vertices may be clockwise or counterclockwise.
- Require every vertex to be on-grid. This is consistent with strict line
  endpoint validation and catches coordinate mistakes early.
- Fill a simple polygon using even-odd scan conversion at integer grid sample
  points `(x, y)`, matching the existing `ellipse`/`litEllipse` convention.
  Include pixels exactly on an edge within a small epsilon.
- Clip only the rasterization bounding box to the grid; do not silently accept
  off-grid vertices.
- Reject fewer than three vertices, repeated adjacent vertices, zero-area
  polygons, and self-intersections with clear errors. An O(n²) edge-intersection
  check is sufficient at the 16-vertex cap.
- The op paints one palette index and composes with the existing exterior
  `outline` op.

Tests: axis-aligned quadrilateral vs equivalent `rect`, triangle, concave
L-shape, reversed vertex order equality, boundary pixels, invalid/self-crossing
polygons, and clipping of the raster loop.

### 6.2 `taperedLine`

Schema:

```js
{
  type: "taperedLine",
  x0, y0, x1, y1, // integer on-grid endpoints
  w0, w1,         // integer diameters, each 1..12
  color
}
```

Behavior:

- Draw a round-capped tapered capsule from endpoint 0 to endpoint 1.
- For each pixel in the clipped bounding box, project its integer grid sample
  point `(x, y)` onto the finite segment and clamp projection `t` to `[0,1]`.
- Compute the nearest centerline point and interpolate diameter
  `w(t) = w0 + (w1 - w0) * t`.
- Paint when distance to that centerline point is `<= w(t)/2`.
- Reject coincident endpoints and direct the agent to `ellipse` for a stamp.
- Existing `line.thickness` remains capped at 4 and its square-brush output is
  unchanged.

Tests: horizontal wide-to-narrow and narrow-to-wide strokes, diagonal stroke,
round cap behavior, reversed endpoints with swapped widths equality, edge
clipping, validation, and a representative thigh-to-calf shape that is visibly
wider than a 4px line.

### 6.3 Registration and documentation

For both ops, update all required locations:

- zod `drawOp` union and descriptions in `src/tools.js`;
- `model.applyOps` switch and op JSDoc;
- `SERVER_INSTRUCTIONS` op list and shape-selection guidance;
- README draw op list;
- `AGENTS.md` only if a new invariant is genuinely needed;
- `sprite-draw`: use `polygon` for tunics/boots/quivers and `taperedLine` for
  thighs/calves/upper arms when those shapes improve the silhouette.

Increment `DRAW_SCHEMA_REVISION` to 2. Update the Phase 3 MCP schema/capability
tests to include both ops. REST support must come automatically through the
shared schema and `drawAndSave()` path; do not add a second REST validator.

### 6.4 Explicit limits

- Integer geometry only in this phase. Fractional support belongs to the
  existing coverage-rasterization roadmap if needed later.
- No rotated ellipse, spline, arbitrary mask system, or internal part-outline
  mode in this change set.
- No changes to existing integer `line`, `ellipse`, or `curve` output.
- Layers remain the structural solution for complex z-order; these primitives
  improve anatomy but do not replace that roadmap item.

### 6.5 Done when

Both ops validate and execute identically through MCP and REST, failed draws
remain atomic, the capability revision reflects the schema change, all tests
are green, and the skills teach their use during the silhouette pass.

---

## Phase 7: Dogfood one-shot quality, not just tool correctness

### 7.1 Protocol

Use a temporary project root outside the repo's runtime directories. Start a
new daemon after the final code changes and start a **fresh agent/MCP session**
so schemas cannot be stale. Record `get_capabilities` before drawing.

Run this exact required prompt with no corrective follow-up:

```text
@sprite-draw an archer with a bow in side view 64px
```

The agent may make as many autonomous tool calls as it needs. “One-shot” means
one user prompt, not one draw call. Do not manually repair the result.

Recommended additional prompts to catch overfitting:

```text
@sprite-draw a knight with a sword and shield in side view 32px
@sprite-draw a wizard with a long robe and staff 32px
@sprite-draw a side-view wolf with a saddle 32px
```

Use the same model and equivalent skills for baseline and post-change runs.
Where practical, repeat the archer three times because agent output is not
deterministic. Do not commit the generated art; summarize observations in the
review/PR or a gitignored experiment note.

### 7.2 Measurements

For each run, record:

- server version and draw schema revision;
- reference URL and extracted/suggested palette size, if a reference is used;
- tool errors and any hidden retry count;
- number of draw passes and whether duplicate same-scale renders were used;
- whether an actual-size `scale: 1` review occurred;
- final actual-size and enlarged renders for human comparison.

Use a 0–2 score per category (0 broken, 1 readable with issues, 2 clear):

1. subject and side-view pose recognition;
2. head/torso/limb proportions;
3. leg and foot readability at actual size;
4. arm/weapon/equipment separation;
5. bow/string/arrow or equivalent prop clarity;
6. palette contrast and actual-size readability.

The archer-specific regression check is that the quiver reads as equipment on
the back, not as part of the drawing arm, and the legs do not read as thin
sticks. Also verify that the bow can be made with `curve` and that no skill
requires an unavailable op.

Do not turn subjective art scores into a flaky automated test. The deterministic
unit/MCP tests are the correctness gate; this review is the quality gate.

### 7.3 Final acceptance checklist

- [x] All previous phase acceptance criteria are met and `npm test` is green
      (81 tests).
- [x] The reference regression returns a full valid palette rather than the old
      four-color early stop under equivalent conditions.
- [x] MCP `tools/list` exposes every implemented op and reports the new schema
      revision in a fresh session (live `get_capabilities`: 0.2.0 / rev 2).
- [x] Failed multi-op draws leave no hidden state changes.
- [x] Instructions consistently require actual-size review and a silhouette
      quality gate.
- [x] The one-shot archer is evaluated without manual repair and the two
      observed quality defects are specifically reviewed.
- [x] At least one non-archer prompt is checked to reduce prompt-specific
      overfitting (32px knight with sword and shield).
- [x] No generated runtime files are committed.

### 7.4 Dogfood log (2026-10-24)

**Fresh-session required run** — exact prompt
`@sprite-draw an archer with a bow in side view 64px`, new MCP child session,
server 0.2.0 / schema rev 2:

- sprite `archer_side64`, version 9
- reference: `https://opengameart.org/sites/default/files/archer.png`
  (CC0, LordNeo, 64x64); `fetch_reference` extracted 12 colors and suggested
  a 12-color palette in 2 ramp families (neutral 1-4, orange 5-12,
  outlineIndex 4); the agent kept the default palette instead
- 7 draw calls (initial + 4 silhouette/pose rebuilds + 2 detail/fix passes),
  no tool errors, two `scale: 1` checks
- scores: pose 2, proportions 1, legs/feet 2, arm/equipment separation 1,
  bow/string/arrow 2, palette contrast 2
- regression checks: quiver reads as back equipment and is not the drawing
  arm; legs are not thin sticks; the bow is one `curve` op; no unavailable op
- remaining defect: the drawing arm's brown bracer crowds the quiver/belt at
  actual size, and the bow fist swallows the grip

**Implementation-session smoke runs** (same server, not a fresh context):

- `archer_oneshot` 64x64, 3 draw passes, no reference, no errors, scale 1
  reviewed. Pose 2, proportions 1, legs/feet 2, separation 2, bow/arrow 2,
  contrast 2; quiver and legs pass the regression check.
- `knight_oneshot` 32x32, 3 draw passes (one silhouette redraw after the first
  pass merged the feet and buried a leg behind the shield), no errors, scale 1
  reviewed. Pose 2, proportions 1, legs/feet 1, equipment separation 1,
  sword/shield clarity 2, contrast 2. The sword hand/crossguard still crowds
  the shield rim.
- One duplicate same-scale render was used on the knight with `grid: true` to
  diagnose the leg gap; it was a diagnostic view, not a blind repeat.

Generated sprites live in the gitignored `sprites/` directory and are not part
of this change set.

---

## Deferred ideas and non-goals

These may be valuable later, but they are not required to complete this plan:

- **Layers:** already specified in `PLAN.md` Part 2. This plan's staged draw and
  new ops must integrate with layers if that work lands first.
- **Preview-only draw:** already specified in Part 3. Reuse `stageDraw()` rather
  than creating a second cloning implementation.
- **Fractional geometry:** already specified in Part 1. Keep new Phase 6 ops
  integer-only for now.
- **Accent-reserving/perceptual quantization:** first build a visual benchmark;
  do not combine an aesthetic quantization change with the correctness fix.
- **Reference HTML page resolution/license scraping:** current workflow can use
  web search/fetch to find a direct CC0/CC-BY PNG. Keep `fetchReference()` PNG
  only.
- **Automatic artistic critique service:** the model remains the artist/critic.
  Better renders, instructions, and primitives are in scope; another LLM call
  inside the daemon is not.
- **Generated-art snapshots in git:** repo hygiene still forbids relying on or
  committing runtime art.

## Implementation risk notes

- **Palette behavior regressions:** keep the exact-color fast path unchanged
  and test integer-ratio resizing byte-for-byte.
- **History regressions:** staging must happen before `beginEdit()`; successful
  edits still create exactly one snapshot.
- **MCP SDK coupling:** parse semantic op discriminators in `tools/list`, not the
  entire serialized JSON schema.
- **Roadmap conflicts:** layers change `targetGrid`; fractional geometry changes
  `applyOps`; preview should reuse staging. Re-read `PLAN.md` status before each
  conflicting phase.
- **Overfitting to archer:** the additional dogfood prompts and no-manual-repair
  rule are required to assess general one-shot improvement.
