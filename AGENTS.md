# AGENTS.md

MCP-first sprite/animation daemon. One Node process serves the MCP endpoint, a REST API, the static viewer, and SSE live updates. No build step, no bundler, no TypeScript — plain ESM (`"type": "module"`), Node >= 20.

## Commands

```sh
npm install
npm test                                   # all tests, node:test
node --test --test-name-pattern="outline" test/model.test.js   # single test
npm run serve                              # http://localhost:7337, MCP at /mcp
npm run serve -- --port=8080 --root=/path/to/project
```

- `--root` (or starting cwd) decides where `sprites/`, `exports/`, `reference-images/`, and `project.json` live. `PORT` env also works.
- Start the daemon before using sprite-studio MCP tools; `opencode.jsonc` points at `http://localhost:7337/mcp`. Run one daemon per project root — sprites are cached in-process.
- There is no lint, typecheck, format, or CI config. Tests are offline-safe (`fetchReference` takes an injected fetch).

## Architecture

| Path | Role |
|---|---|
| `src/server.js` | HTTP wiring only: `/mcp` (stateless, POST-only), `/api/*`, static `public/`, `/api/events` SSE |
| `src/tools.js` | MCP tool registration + zod schemas; `drawOpsSchema` is exported and reused by the REST draw route so both paths validate identically |
| `src/model.js` | Pure sprite/op logic, no I/O. Source of truth for GRID_SIZES, DEFAULT_PALETTE, frame/resize ops |
| `src/storage.js` | fs persistence, in-memory cache, undo/redo snapshots, change events |
| `src/render.js` | palette grid -> PNG (pngjs); renders and onion skins |
| `src/export.js` | PNG sheet + Aseprite-style JSON |
| `src/reference.js` | download -> area-average pixelate -> palette extraction (only outbound network fetch in the project) |
| `public/js/` | viewer as plain ES modules, entry `app.js`; no build artifacts |

## Invariants that break things silently

- Every mutation must call `storage.beginEdit(name)` **before** changing the sprite and `storage.save(sprite)` after. `get()` returns the cached mutable object, and `save()` is what bumps `version`, persists, and emits SSE.
- A draw op needs both a zod variant in `src/tools.js` and a `switch` case in `model.applyOps`; validation and execution are separate, and the REST route reuses `drawOpsSchema`. Add ops to both plus `SERVER_INSTRUCTIONS` and the README op list.
- Palette index 0 is always transparent and locked. Grid dimensions must be one of `16/24/32/48/64`. Animations are created with 2–16 frames and capped at 16 (1-frame animations are allowed only by deleting down); fps 1–60. `pixels` ops cap at 512.
- `rows` ops are full-width RLE and must sum to grid width; `block` rows have independent widths. Don't confuse them.
- MCP is intentionally stateless: a fresh server/transport per POST request. `GET /mcp` returns 405 by design.
- `opencode.jsonc` sets `codemode: false` so PNG image tool results reach the model directly. Don't enable Code Mode unless the harness handles images.

## Repo hygiene

- `sprites/`, `exports/`, `reference-images/`, and `project.json` are gitignored runtime data — a fresh clone starts with zero sprites and tests use temp dirs. Don't commit generated art or rely on example sprites existing.
- Art workflow instructions are in `.opencode/skills/` (auto-discovered). Use those skills for drawing/animating/exporting; don't improvise pixel-art procedure.
- `README.md` is the user-facing doc; `SERVER_INSTRUCTIONS` in `src/tools.js` is the MCP-facing contract sent to every client. Update both when tools or op semantics change.
