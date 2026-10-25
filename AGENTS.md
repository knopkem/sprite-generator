# AGENTS.md

MCP-first sprite/animation daemon. One Node process serves the MCP endpoint, a REST API, the static viewer, and SSE live updates. No build step, no bundler, no TypeScript — plain ESM (`"type": "module"`), Node >= 20.

## Commands

```sh
npm install
npm test                                   # all tests, node:test
node --test --test-name-pattern="outline" test/model.test.js   # single test
npm run serve                              # http://127.0.0.1:7337, MCP at /mcp
npm run serve -- --port=8080 --root=/path/to/project
```

- `--root` (or starting cwd) decides where `sprites/`, `exports/`, `reference-images/`, and `project.json` live. `PORT` env also works.
- Start the daemon before using sprite-studio MCP tools; `opencode.jsonc` points at `http://127.0.0.1:7337/mcp`. Use the numeric IPv4 loopback in client configs, not `localhost`: the daemon binds `127.0.0.1` only and Bun-based clients (OpenCode) resolve `localhost` to `::1` without falling back, which gives `ECONNREFUSED`. Run one daemon per project root — sprites are cached in-process.
- There is no lint, typecheck, format, or CI config. Tests are offline-safe (`fetchReference` takes an injected fetch).

## Architecture

| Path | Role |
|---|---|
| `src/server.js` | HTTP wiring only: `/mcp` (stateless, POST-only), `/api/*`, static `public/`, `/api/events` SSE |
| `src/tools.js` | MCP tool registration + zod schemas; `drawOpsSchema` is exported and reused by the REST draw route so both paths validate identically |
| `src/model.js` | Pure sprite/op logic, no I/O. Source of truth for GRID_SIZES, DEFAULT_PALETTE, frame/resize ops, `stageDraw` |
| `src/draw.js` | Shared storage-aware draw commit: stage -> `beginEdit` -> commit -> `save` (MCP + REST) |
| `src/palette.js` | Palette organization: ramp families, outline-index and litEllipse-triple suggestions |
| `src/version.js` | `SERVER_VERSION` (package.json) + `DRAW_SCHEMA_REVISION` |
| `src/storage.js` | fs persistence, in-memory cache, undo/redo snapshots, change events |
| `src/render.js` | palette grid -> PNG (pngjs); renders and onion skins |
| `src/export.js` | PNG sheet + Aseprite-style JSON |
| `src/reference.js` | download -> area-average pixelate (alpha-weighted) -> palette extraction (only outbound network fetch in the project) |
| `src/generate.js` | sandboxed painter JS (node:vm, no modules, CPU timeout) -> downsample -> quantize; palette organized into light->dark ramp families (`sprite.rampFamilies`) |
| `public/js/` | viewer as plain ES modules, entry `app.js`; no build artifacts |

## Invariants that break things silently

- Every mutation must call `storage.beginEdit(name)` **before** changing the sprite and `storage.save(sprite)` after. `get()` returns the cached mutable object, and `save()` is what bumps `version`, persists, and emits SSE.
- MCP and REST draws must go through `drawAndSave()` (`src/draw.js`): `stageDraw()` validates and rasterizes on a clone **before** `beginEdit()`, so a failed multi-op draw leaves grid, file, version, undo/redo, and SSE untouched. Never call `applyOps()` directly from a tool route.
- A draw op needs both a zod variant in `src/tools.js` and a `switch` case in `model.applyOps`; validation and execution are separate, and the REST route reuses `drawOpsSchema`. Add ops to both plus `SERVER_INSTRUCTIONS` and the README op list.
- Palette index 0 is always transparent and locked. Grid dimensions must be one of `16/24/32/48/64`. Animations are created with 2–16 frames and capped at 16 (1-frame animations are allowed only by deleting down); fps 1–60. `pixels` ops cap at 512.
- `line`, `ellipse`, and `curve` have dual rasterizers: all-integer params must reproduce legacy output exactly (Bresenham / legacy `inside()`); any fractional param selects 8×8 coverage sampling with a 50% threshold. Characterization tests pin the legacy path.
- `rows` ops are full-width RLE and must sum to grid width; `block` rows have independent widths. Don't confuse them.
- MCP is intentionally stateless: a fresh server/transport per POST request. `GET /mcp` returns 405 by design.
- Layers are Option A: base-sprite only, frames flat. Stored state is `grids[layerName]` + `layers`; `sprite.grid` does not exist. Render/export must call `flatten()`; `targetGrid(sprite, frame, layer)` resolves a frame or the topmost/named layer. Legacy `grid` files migrate in `storage.get()`.
- Layer mutations validate on a throwaway clone before `beginEdit()` (MCP/REST share `applyLayerOp`), so a rejected op adds no undo snapshot.
- `opencode.jsonc` sets `codemode: false` so PNG image tool results reach the model directly. Don't enable Code Mode unless the harness handles images.

## Repo hygiene

- `sprites/`, `exports/`, `reference-images/`, and `project.json` are gitignored runtime data — a fresh clone starts with zero sprites and tests use temp dirs. Don't commit generated art or rely on example sprites existing.
- Art workflow instructions are in `.opencode/skills/` (auto-discovered). Use those skills for drawing/animating/exporting; don't improvise pixel-art procedure.
- `README.md` is the user-facing doc; `SERVER_INSTRUCTIONS` in `src/tools.js` is the MCP-facing contract sent to every client. Update both when tools or op semantics change.
