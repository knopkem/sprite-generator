// MCP tool definitions. Bulk-first: a full sprite should be drawable in 1-3
// draw calls. Strict validation with agent-friendly error messages.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodeGrid } from "./rle.js";
import { targetGrid, addAnimation, copyFrame, normalizeHex, resizeSprite, contentBounds, GRID_SIZES, DEFAULT_PALETTE, PALETTE_FAMILIES, DEFAULT_RAMP_FAMILIES } from "./model.js";
import { drawAndSave } from "./draw.js";
import { SERVER_VERSION, DRAW_SCHEMA_REVISION } from "./version.js";
import { renderPng, renderOnionSkin } from "./render.js";
import { exportSprite } from "./export.js";
import { generateSprite } from "./generate.js";
import { prepareReference, fetchReference } from "./reference.js";
import { rampTripleSuggestions } from "./palette.js";
import { PNG } from "pngjs";
import fs from "node:fs";

export const SERVER_INSTRUCTIONS = `Sprite Studio: draw and animate palette-indexed pixel art via tools.

Contract (read before drawing):
- Grids are ${GRID_SIZES.join("/")} px. Default 32. Above 32 quality degrades — warn the user.
- Palette index 0 is ALWAYS transparent. Reference colors by index only.
- Draw in BULK with shape ops, not scanline math: ellipse for heads/round
  shapes; line for straight limbs/props; curve for arcs (quadratic bezier: a
  bow is ONE curve op, not hand-chained segments); polygon for angular
  silhouettes (tunics, boots, quivers, shields); taperedLine for anatomy that
  changes width (thigh->calf, upper arm->forearm, tapered props); rect for
  blocks; block for small local RLE regions (rows have independent widths);
  rows (full-width RLE, must sum to grid width) only for whole-sprite fills.
  Never hundreds of single pixels.
- Workflow: set_palette (optional) -> draw silhouette -> pass the silhouette
  gate below -> detail passes -> actual-size review. undo/redo recover a bad
  pass without redrawing.
- Silhouette gate (mandatory BEFORE any facial detail or shading):
  * subject and side-view/front-view pose read without face or shading;
  * head/torso/leg proportions are intentional;
  * thighs, calves, ankles, and feet have distinct, readable widths;
  * feet are grounded and broader than ankles where appropriate;
  * bent arms leave visible negative space instead of reading as straight bars;
  * back equipment (quiver, pack, cape) does not merge with elbows, arms, or
    torso;
  * touching parts differ in value/hue, or keep 1-2px of separation when the
    design allows it;
  * weapons and extremities preserve animation headroom.
  If an item fails, patch the silhouette. Do NOT use shading to conceal an
  anatomy or overlap problem.
- Build back-to-front: rear props, body, costume, arms, then held props.
- Drawing loop: draw returns an inline render by default; critique THAT image
  instead of requesting the same render again. Use get_render when changing
  scale/grid/target or when inline rendering was skipped. Inspect an enlarged
  render (scale 2-4) for pixel placement. BEFORE completion inspect scale: 1
  for actual-size readability; an extra scale: 2 view is allowed but is NOT
  the actual-size test. Never claim success without looking.
- The default palette has ${DEFAULT_PALETTE.length - 1} opaque colors plus
  transparent index 0. It is ramp-based: each hue family has light/mid/dark as
  adjacent indices. Shade with the darker ramp neighbor, highlight with the
  lighter. Distinct props should use DIFFERENT families — same-hue adjacent
  elements read as one blob.
- Deterministic ops beat hand-drawing: "outline" wraps the silhouette in the
  sprite's outlineIndex (after the base pass use scope: "new" so only pixels
  added in that call get outlined — thin details like bowstrings stay thin);
  "shift" moves a whole frame (animation bob); mirror: true mirrors the left
  half for symmetric characters.
- Shading ops carry the math: "litEllipse" paints a lambert-shaded ellipse
  onto a [light, mid, dark] ramp with ordered dither (one op = a shaded
  blob/sphere; fractional centers allowed; only a 3+ color family is a valid
  ramp); "rampRect" paints a gradient rect along v/h. Prefer them over
  hand-placed shading bands.
- "generate_sprite" = procedural path: your sandboxed JS paints a big canvas
  (gridSize x scale; API: px/over/mix/clamp01/smooth/rng/log), then the server
  downsamples and quantizes it into an indexed sprite. Consider it for organic,
  gradient-heavy art (foliage, rock, slimes, fur) and grids >= 48 — not as an
  automatic choice for every large character. Direct shape ops remain the right
  tool for crisp, hard-edged character silhouettes. Write math (loops, lambert,
  noise), never per-pixel lists. Iterate via overwrite: true. The generated
  palette is auto-organized into light->dark ramp families (reported in the
  result and by get_palette), so litEllipse/rampRect compose on generated
  sprites.
- Leave headroom: characters at ~75-85% of grid height, 2-4px air per side.
  Animations need it. If an existing sprite is too tight, resize_sprite grows
  the grid without redrawing (content stays bottom-centered).
- Refinement = smallest possible patch (pixels/rect ops). Never redraw the whole
  grid unless the user asks for a redo.
- Animation: add_animation -> copy_frame from a neighbor -> patch the pose ->
  get_onion_skin to check motion -> fix per frame. Never regenerate all frames.
- If a tool or draw op seems missing, call get_capabilities. After changing tool
  code/schemas, restart the daemon and reconnect the MCP client (or start a
  fresh agent session); a fresh transport per request does NOT hot-reload
  source modules, and clients can cache old schemas.
- export writes PNG sheet + JSON into the project's exports/ directory.`;

const frameRef = z
  .object({
    anim: z.string().describe("animation name"),
    index: z.number().int().min(0).describe("frame index"),
  })
  .optional()
  .describe("target an animation frame instead of the base sprite");

const drawOp = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rows"),
    rows: z.string().describe('RLE rows, e.g. "8:0;2:0,4:3,2:0;8:0"'),
    y: z.number().int().min(0).optional().describe("first row to paste at (default 0)"),
  }),
  z.object({
    type: z.literal("rect"),
    x: z.number().int(),
    y: z.number().int(),
    w: z.number().int().min(1),
    h: z.number().int().min(1),
    color: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("pixels"),
    pixels: z
      .array(z.object({ x: z.number().int(), y: z.number().int(), color: z.number().int().min(0) }))
      .max(512),
  }),
  z.object({
    type: z.literal("clear"),
    color: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal("outline"),
    color: z.number().int().min(0).optional().describe("outline color index (default 1)"),
    diagonals: z.boolean().optional().describe("also outline diagonal neighbors (thicker)"),
    scope: z
      .enum(["all", "new"])
      .optional()
      .describe('"all" (default) wraps the whole silhouette; "new" only wraps pixels added in THIS draw call — detail passes can grow the shape without re-outlining thin elements (strings, weapon edges)'),
  }),
  z.object({
    type: z.literal("fill"),
    x: z.number().int(),
    y: z.number().int(),
    color: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("line"),
    x0: z.number().int(),
    y0: z.number().int(),
    x1: z.number().int(),
    y1: z.number().int(),
    color: z.number().int().min(0),
    thickness: z.number().int().min(1).max(4).optional(),
  }),
  z.object({
    type: z.literal("curve"),
    x0: z.number().int().describe("start x"),
    y0: z.number().int().describe("start y"),
    cx: z.number().int().describe("bezier control x (may be off-grid for shallow arcs)"),
    cy: z.number().int().describe("bezier control y"),
    x1: z.number().int().describe("end x"),
    y1: z.number().int().describe("end y"),
    color: z.number().int().min(0),
    thickness: z.number().int().min(1).max(4).optional(),
  }),
  z.object({
    type: z.literal("polygon"),
    points: z
      .array(z.tuple([z.number().int(), z.number().int()]))
      .min(3)
      .max(16)
      .describe("3..16 on-grid integer vertices; clockwise or counterclockwise; concave allowed"),
    color: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("taperedLine"),
    x0: z.number().int().describe("start x (on-grid)"),
    y0: z.number().int().describe("start y (on-grid)"),
    x1: z.number().int().describe("end x (on-grid)"),
    y1: z.number().int().describe("end y (on-grid)"),
    w0: z.number().int().min(1).max(12).describe("diameter at the start (1..12)"),
    w1: z.number().int().min(1).max(12).describe("diameter at the end (1..12)"),
    color: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("ellipse"),
    cx: z.number().int(),
    cy: z.number().int(),
    rx: z.number().int().min(1),
    ry: z.number().int().min(1),
    color: z.number().int().min(0),
    filled: z.boolean().optional().describe("default true; false = 1px ring"),
  }),
  z.object({
    type: z.literal("litEllipse"),
    cx: z.number().describe("center x — may be fractional (e.g. 15.5 on a 32-wide grid)"),
    cy: z.number(),
    rx: z.number().min(1),
    ry: z.number().min(1),
    ramp: z
      .array(z.number().int().min(0))
      .length(3)
      .describe("[light, mid, dark] palette indices — use one ramp family from get_palette"),
    light: z.tuple([z.number(), z.number()]).optional().describe("light direction [x, y], default [-0.6, -0.75] (top-left)"),
    hi: z.number().optional().describe("light threshold (default 0.42)"),
    lo: z.number().optional().describe("shadow threshold (default -0.38)"),
    dither: z.boolean().optional().describe("ordered dither at band boundaries (default true)"),
  }),
  z.object({
    type: z.literal("rampRect"),
    x: z.number().int(),
    y: z.number().int(),
    w: z.number().int().min(1),
    h: z.number().int().min(1),
    ramp: z.array(z.number().int().min(0)).min(2).max(8).describe("gradient stops; ramp[0] at top/left"),
    dir: z.enum(["v", "h"]).optional().describe("gradient direction (default v)"),
  }),
  z.object({
    type: z.literal("block"),
    x: z.number().int(),
    y: z.number().int(),
    rows: z.string().describe('RLE rows pasted at (x,y); each row has its own width, e.g. "2:3,1:0,1:4;4:3"'),
  }),
  z.object({
    type: z.literal("shift"),
    dx: z.number().int().optional(),
    dy: z.number().int().optional(),
  }),
]);

/** Reused by the REST API so human and agent edits share one validation path. */
export const drawOpsSchema = z.array(drawOp).min(1).max(50);

/** Every draw op the running server supports, derived from the zod union. */
export const DRAW_OP_TYPES = Object.freeze(drawOp.options.map((option) => option.shape.type.value));

/**
 * Machine-readable identity/capability block. Exposed as the MCP
 * get_capabilities tool and GET /api/capabilities so a stale client can be
 * diagnosed: creating a transport per request does not reload source modules.
 */
export function getCapabilities() {
  return {
    serverVersion: SERVER_VERSION,
    drawSchemaRevision: DRAW_SCHEMA_REVISION,
    drawOps: [...DRAW_OP_TYPES],
    gridSizes: [...GRID_SIZES],
    features: {
      transactionalDraw: true,
      inlineDrawRender: true,
      generateSprite: true,
    },
  };
}

const PROP_CONTRAST_REMINDER =
  "Distinct props (bow, quiver, clothing) should use DIFFERENT families — same-hue adjacent elements read as one blob.";

/**
 * Human-readable ramp guidance from family metadata. Only families with at
 * least three entries get litEllipse triples; shorter families are explicitly
 * described as manual-shading-only instead of being mis-sold as ramps.
 */
function rampGuidance(families) {
  if (!families?.length) return "";
  const labels = [];
  const triples = [];
  const manual = [];
  for (const f of families) {
    const range = `${f.from}${f.to > f.from ? `-${f.to}` : ""}`;
    labels.push(`${f.name} ${range}`);
    const t = rampTripleSuggestions(f);
    if (t.length) triples.push(`${f.name}: ${t.map((x) => `[${x.join(",")}]`).join(" ")}`);
    else manual.push(`${f.name} ${range}`);
  }
  let out = `Ramp families (light→dark): ${labels.join(", ")}.`;
  if (triples.length) out += ` litEllipse triples: ${triples.join("; ")}.`;
  if (manual.length) out += ` Manual light/dark shading only (no three-stop litEllipse ramp): ${manual.join(", ")}.`;
  return out;
}

/** Validate custom ramp metadata before any mutation. */
function normalizeRampFamilies(families, paletteLength) {
  const normalized = families.map((f) => {
    const name = String(f.name).trim();
    if (!name) throw new Error("rampFamilies: every family needs a nonempty name");
    if (!Number.isInteger(f.from) || !Number.isInteger(f.to)) {
      throw new Error(`rampFamilies "${name}": from/to must be integers`);
    }
    if (f.from < 1 || f.to < f.from || f.to >= paletteLength) {
      throw new Error(
        `rampFamilies "${name}": require 1 <= from <= to < ${paletteLength} (final palette indices, index 0 is transparent); got ${f.from}..${f.to}`
      );
    }
    return { name, from: f.from, to: f.to };
  });
  const sorted = [...normalized].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from <= sorted[i - 1].to) {
      throw new Error(
        `rampFamilies overlap: "${sorted[i - 1].name}" (${sorted[i - 1].from}-${sorted[i - 1].to}) and "${sorted[i].name}" (${sorted[i].from}-${sorted[i].to}) share an index`
      );
    }
  }
  return normalized;
}

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

/**
 * Measure content headroom and warn when the sprite crowds the grid edge.
 * This is how a fresh session learns the sprite has no room to animate —
 * surfaced in the tool result, at the moment it matters.
 */
function headroomNote(s) {
  const b = contentBounds(s.grid);
  if (!b) return "";
  const room = {
    top: b.minY,
    right: s.width - 1 - b.maxX,
    bottom: s.height - 1 - b.maxY,
    left: b.minX,
  };
  const tight = Object.entries(room).filter(([, v]) => v < 2).map(([k]) => k);
  if (tight.length === 0) return "";
  return ` ⚠ Headroom top ${room.top}px / right ${room.right}px / bottom ${room.bottom}px / left ${room.left}px — content is at the grid edge (${tight.join(", ")}). Animation poses (squash, lunges, weapon arcs) will clip. resize_sprite grows the grid without redrawing; content stays bottom-centered.`;
}

function err(e) {
  return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
}

function png(buf) {
  return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }] };
}

/** Wrap a handler so thrown errors become agent-readable tool errors. */
const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return err(e);
  }
};

export function createMcpServer(storage) {
  const server = new McpServer(
    { name: "sprite-studio", version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "get_capabilities",
    {
      description:
        "Report the running server version, draw-schema revision, supported draw ops, grid sizes, and feature flags. " +
        "Call this when a tool or draw op seems missing: if this list differs from the tools you were given, restart the daemon and reconnect the MCP session.",
      inputSchema: {},
    },
    safe(() => text(JSON.stringify(getCapabilities(), null, 2)))
  );

  server.registerTool(
    "create_sprite",
    {
      description: `Create a new sprite. Grid size must be one of ${GRID_SIZES.join("/")} (default recommendation: 32; above 32 warn the user about quality). Comes with the default ramp palette: ${DEFAULT_PALETTE.length - 1} opaque colors plus transparent index 0, and outlineIndex 1.`,
      inputSchema: {
        name: z.string().describe("letters, digits, - and _"),
        width: z.number().int(),
        height: z.number().int(),
      },
    },
    safe(({ name, width, height }) => {
      const s = storage.create(name, width, height);
      const warn = width > 32 || height > 32 ? " WARNING: grids above 32 degrade LLM spatial coherence — expect to need more fix passes." : "";
      return text(`Created "${name}" (${width}x${height}), palette indices 0..${s.palette.length - 1} (0 = transparent, ${s.palette.length - 1} opaque colors).${warn} Draw the character at ~75-85% of grid height, bottom-centered, with 2-4px of air on every side — animations need that headroom. Next: draw the silhouette with shape ops (ellipse, line, curve, polygon, taperedLine, rect, block) — not a full-sprite "rows" scanline fill — then check the silhouette gate before adding detail. draw returns the render inline.`);
    })
  );

  server.registerTool(
    "list_sprites",
    { description: "List all sprite names in the project.", inputSchema: {} },
    safe(() => {
      const names = storage.list();
      return text(names.length ? names.join("\n") : "(no sprites yet)");
    })
  );

  server.registerTool(
    "get_state",
    {
      description: "Get sprite metadata: size, palette, outlineIndex, animations (names, fps, frame counts), version.",
      inputSchema: { sprite: z.string() },
    },
    safe(({ sprite }) => {
      const s = storage.get(sprite);
      return text(
        JSON.stringify({
          name: s.name,
          width: s.width,
          height: s.height,
          palette: s.palette,
          outlineIndex: s.outlineIndex ?? 1,
          animations: Object.fromEntries(
            Object.entries(s.animations).map(([k, a]) => [k, { fps: a.fps, frames: a.frames.length }])
          ),
          version: s.version,
        })
      );
    })
  );

  server.registerTool(
    "set_palette",
    {
      description:
        "Replace the ENTIRE ordered palette (not a single entry). Array of #rrggbb hex colors, max 31; transparent index 0 is prepended automatically. " +
        "Existing pixels are clamped into the new range. Omitting rampFamilies deletes previous generated/reference ramp metadata. " +
        "For a one-color change, read the complete palette with get_palette, keep its order/length, and change only that hex (or use the viewer's per-index editor). " +
        `Current default: ${DEFAULT_PALETTE.length - 1} opaque colors — ${DEFAULT_PALETTE.slice(1).join(" ")}`,
      inputSchema: {
        sprite: z.string(),
        colors: z.array(z.string()).min(1).max(31).describe("complete ordered hex palette; transparent index 0 is added automatically"),
        outlineIndex: z
          .number()
          .int()
          .optional()
          .describe("default outline palette index (includes transparent 0); omit for 1"),
        rampFamilies: z
          .array(
            z.object({
              name: z.string(),
              from: z.number().int(),
              to: z.number().int(),
            })
          )
          .optional()
          .describe("light→dark shade families using FINAL palette indices (index 0 = transparent); omit to clear old metadata"),
      },
    },
    safe(({ sprite, colors, outlineIndex, rampFamilies }) => {
      const s = storage.get(sprite);
      // Validate everything before beginEdit(): a rejected palette must not
      // touch pixels, history, version, or SSE.
      const palette = ["#00000000", ...colors.map(normalizeHex)];
      const finalOutline = outlineIndex ?? 1;
      if (!Number.isInteger(finalOutline) || finalOutline < 1 || finalOutline >= palette.length) {
        throw new Error(`outlineIndex must be an integer 1..${palette.length - 1} (index 0 is transparent); got ${finalOutline}`);
      }
      const families = rampFamilies ? normalizeRampFamilies(rampFamilies, palette.length) : null;

      storage.beginEdit(sprite);
      s.palette = palette;
      s.outlineIndex = finalOutline;
      if (families?.length) s.rampFamilies = families;
      else delete s.rampFamilies;
      // clamp existing grid indices into the new palette
      const max = s.palette.length - 1;
      for (const grid of [s.grid, ...Object.values(s.animations).flatMap((a) => a.frames)]) {
        for (const row of grid) for (let i = 0; i < row.length; i++) row[i] = Math.min(row[i], max);
      }
      storage.save(s);
      const extra = families?.length ? ` Ramp families: ${rampGuidance(families)}` : "";
      return text(`Palette set: ${s.palette.length} colors (index 0 = transparent, outline ${finalOutline}). Existing pixels clamped to new range.${extra}`);
    })
  );

  server.registerTool(
    "get_palette",
    {
      description:
        "Get the sprite palette as an indexed list, with its default outline index and ramp-family/litEllipse guidance. " +
        "get_palette is the index-specific drawing reference; call it after set_palette.",
      inputSchema: { sprite: z.string() },
    },
    safe(({ sprite }) => {
      const s = storage.get(sprite);
      const isDefault =
        s.palette.length === DEFAULT_PALETTE.length && s.palette.every((c, i) => c === DEFAULT_PALETTE[i]);
      const lines = [`outlineIndex: ${s.outlineIndex ?? 1} (outline ops default to this index; an explicit color op still wins)`];
      for (const [i, c] of s.palette.entries()) {
        const label = i === 0 ? "transparent" : isDefault ? PALETTE_FAMILIES[i] : null;
        lines.push(`${i}: ${c}${label ? ` (${label})` : ""}`);
      }
      const families = isDefault ? DEFAULT_RAMP_FAMILIES : s.rampFamilies;
      if (families?.length) lines.push(rampGuidance(families));
      lines.push(PROP_CONTRAST_REMINDER);
      return text(lines.join("\n"));
    })
  );

  server.registerTool(
    "draw",
    {
      description:
        "Apply bulk draw ops to the base sprite or one animation frame. Ops run in order and the whole call is atomic: if any op fails, nothing is committed. " +
        "Think in shapes, not scanlines: ellipse for heads/round shapes; line for straight limbs/props; " +
        'curve for arcs (one quadratic bezier: a bow is ONE curve, not chained line segments); ' +
        "polygon for angular silhouettes (tunics, boots, quivers, shields); taperedLine for limbs/props that change width (thigh->calf, upper arm->forearm); " +
        "rect for blocks; block for a small local RLE region (rows have independent widths); " +
        'rows (full-width RLE, each row must sum to grid width) for whole-sprite fills. ' +
        'Use "pixels" (max 512) for small fixes, "clear" to wipe. ' +
        '"outline" wraps the silhouette in the sprite outlineIndex automatically (draw flat shapes first, outline after; scope: "new" re-outlines only pixels added in that call; an explicit color overrides the default). ' +
        '"litEllipse" shades an ellipse onto a [light, mid, dark] ramp with light direction and dithered bands (one op = a shaded blob). ' +
        '"rampRect" paints a gradient rect along v/h. ' +
        '"fill" flood-fills a region from a point. ' +
        '"shift" translates the whole grid by dx/dy (animation bob/squash). ' +
        "mirror: true mirrors the left half onto the right AFTER ops run (for symmetric sprites). " +
        "Palette ramps: shading = pick the neighbor index within a ramp family (see get_palette). " +
        "The result includes an inline render by default (pass render: false to skip) — critique that image instead of asking for the same render again. " +
        "Use get_render when changing scale/grid/target; inspect scale: 1 before declaring the sprite done.",
      inputSchema: {
        sprite: z.string(),
        ops: z.array(drawOp).min(1).max(50),
        frame: frameRef,
        mirror: z.boolean().optional(),
        render: z.boolean().optional().describe("include a PNG render of the result in this response (default true) — the vision loop without a separate get_render call"),
        scale: z.number().int().min(1).max(32).optional().describe("render px scale, default auto (~512px output)"),
        grid: z.boolean().optional().describe("overlay a coordinate grid on the render"),
      },
    },
    safe(({ sprite, ops, frame, mirror, render, scale, grid: showGrid }) => {
      const { sprite: s, grid } = drawAndSave(storage, sprite, { frame, ops, mirror });
      const target = frame ? `frame ${frame.index} of "${frame.anim}"` : "base sprite";
      const msg = `Applied ${ops.length} op(s) to ${target}${mirror ? " (mirrored)" : ""}.${frame ? "" : headroomNote(s)}`;
      if (render === false) return text(`${msg} Render skipped — call get_render to see the result.`);
      return {
        content: [
          { type: "text", text: `${msg} Render below — critique it honestly before the next pass.` },
          png(renderPng(grid, s.palette, { scale, grid: showGrid })).content[0],
        ],
      };
    })
  );

  server.registerTool(
    "undo",
    {
      description:
        "Undo the last change to a sprite (server-side snapshot; the same stack the viewer's Z key uses). " +
        "Recover from a bad pass instead of redrawing: undo, then re-apply a corrected draw.",
      inputSchema: { sprite: z.string() },
    },
    safe(({ sprite }) => {
      const s = storage.undo(sprite);
      return text(`Undid last change on "${sprite}" (now version ${s.version}). Call get_render to see the restored state.`);
    })
  );

  server.registerTool(
    "redo",
    {
      description: "Redo the last undone change to a sprite.",
      inputSchema: { sprite: z.string() },
    },
    safe(({ sprite }) => {
      const s = storage.redo(sprite);
      return text(`Redid change on "${sprite}" (now version ${s.version}).`);
    })
  );

  server.registerTool(
    "get_render",
    {
      description:
        "Render the sprite (or one animation frame) to an upscaled PNG and LOOK at it. " +
        "draw already returns an inline render, so use get_render when changing scale/grid/target or when inline rendering was skipped. " +
        "Inspect an enlarged render (scale 2-4) for pixel placement, and scale: 1 for the actual-size readability test before declaring the sprite done. " +
        "grid: true overlays a coordinate grid (useful when locating pixels to fix).",
      inputSchema: {
        sprite: z.string(),
        frame: frameRef,
        scale: z.number().int().min(1).max(32).optional().describe("px scale, default auto (~512px output)"),
        grid: z.boolean().optional(),
      },
    },
    safe(({ sprite, frame, scale, grid }) => {
      const s = storage.get(sprite);
      const g = targetGrid(s, frame);
      return png(renderPng(g, s.palette, { scale, grid }));
    })
  );

  server.registerTool(
    "export_render",
    {
      description:
        "Fallback for hosts that cannot display image tool results: write the render PNG to exports/ and return the file path, which you can then read as an image file.",
      inputSchema: { sprite: z.string(), frame: frameRef, grid: z.boolean().optional() },
    },
    safe(({ sprite, frame, grid }) => {
      const s = storage.get(sprite);
      const g = targetGrid(s, frame);
      const name = frame ? `${sprite}-${frame.anim}-${frame.index}-preview.png` : `${sprite}-preview.png`;
      const p = storage.exportPath(name);
      fs.writeFileSync(p, renderPng(g, s.palette, { grid }));
      return text(`Render written to: ${p}`);
    })
  );

  server.registerTool(
    "get_grid",
    {
      description: "Get the exact grid as RLE (same format draw accepts). Use to re-read precise state before planning a patch.",
      inputSchema: { sprite: z.string(), frame: frameRef },
    },
    safe(({ sprite, frame }) => {
      const s = storage.get(sprite);
      return text(encodeGrid(targetGrid(s, frame)));
    })
  );

  server.registerTool(
    "add_animation",
    {
      description:
        "Create an animation with N empty frames (2..16). Frame 0 starts as a copy of the base sprite. " +
        "Recommended: idle 4f @ 4-6fps, run 6-8f @ 8-12fps, attack 4-6f @ 10-12fps, jump 4f, hurt 2f, die 4-6f.",
      inputSchema: {
        sprite: z.string(),
        name: z.string().describe("e.g. idle, run, attack, jump, hurt, die"),
        frames: z.number().int().min(2).max(16),
        fps: z.number().int().min(1).max(60),
      },
    },
    safe(({ sprite, name, frames, fps }) => {
      const s = storage.get(sprite);
      storage.beginEdit(sprite);
      addAnimation(s, name, frames, fps);
      storage.save(s);
      return text(`Animation "${name}" created: ${frames} frames @ ${fps}fps. Frame 0 = copy of base sprite. All frames share the base sprite's ${s.width}x${s.height} grid.${headroomNote(s)} Next: copy_frame from frame 0, then patch the pose per frame.`);
    })
  );

  server.registerTool(
    "copy_frame",
    {
      description: "Copy one frame onto another within an animation. Start each new frame from a neighbor, then patch the pose — never draw from scratch.",
      inputSchema: {
        sprite: z.string(),
        anim: z.string(),
        from: z.number().int().min(0),
        to: z.number().int().min(0),
      },
    },
    safe(({ sprite, anim, from, to }) => {
      const s = storage.get(sprite);
      storage.beginEdit(sprite);
      copyFrame(s, anim, from, to);
      storage.save(s);
      return text(`Copied frame ${from} -> ${to} in "${anim}". Now patch the pose with draw (frame: {anim, index: ${to}}).`);
    })
  );

  server.registerTool(
    "get_onion_skin",
    {
      description:
        "Render an onion-skin composite of an animation frame: previous frame tinted red, current full color, next tinted blue. " +
        "Use it to check motion continuity and catch jitter between frames.",
      inputSchema: { sprite: z.string(), anim: z.string(), index: z.number().int().min(0) },
    },
    safe(({ sprite, anim, index }) => {
      const s = storage.get(sprite);
      const a = s.animations[anim];
      if (!a) throw new Error(`no animation "${anim}" on sprite "${sprite}"`);
      if (index >= a.frames.length) throw new Error(`frame index ${index} out of range (${a.frames.length} frames)`);
      const frames = [index > 0 ? a.frames[index - 1] : null, a.frames[index], index < a.frames.length - 1 ? a.frames[index + 1] : null];
      return png(renderOnionSkin(frames, s.palette));
    })
  );

  server.registerTool(
    "export",
    {
      description:
        "Export a sprite to exports/: PNG sheet + Aseprite-style JSON (frames, durations, animation tags). " +
        'layout "grid" = one row per animation (base sprite first), "strip" = all frames in one row. ' +
        "Pass anim to export a single animation as a strip.",
      inputSchema: {
        sprite: z.string(),
        layout: z.enum(["strip", "grid"]).optional(),
        anim: z.string().optional(),
      },
    },
    safe(({ sprite, layout, anim }) => {
      const s = storage.get(sprite);
      const { pngPath, jsonPath, frames } = exportSprite(s, storage, { layout, anim });
      return text(`Exported ${frames.length} frame(s).\nPNG:  ${pngPath}\nJSON: ${jsonPath}`);
    })
  );

  server.registerTool(
    "resize_sprite",
    {
      description:
        "Resize a sprite and all its animation frames to a new grid size without redrawing. " +
        "Content stays horizontally centered and bottom-aligned, so growing the grid adds headroom " +
        "for animation poses (jump, attack lunges). Use when frames clip at the grid edge. " +
        `Sizes: ${GRID_SIZES.join("/")}.`,
      inputSchema: {
        sprite: z.string(),
        width: z.number().int(),
        height: z.number().int(),
      },
    },
    safe(({ sprite, width, height }) => {
      const s = storage.get(sprite);
      storage.beginEdit(sprite);
      const from = `${s.width}x${s.height}`;
      resizeSprite(s, width, height);
      storage.save(s);
      return text(`Resized "${sprite}" from ${from} to ${width}x${height} (content bottom-centered, all frames remapped).`);
    })
  );

  server.registerTool(
    "fetch_reference",
    {
      description:
        "Download a reference image for style study. Accepts HTTP(S) PNG URLs only — local file paths are rejected; inspect a local image with your host's image-reading tool instead. " +
        "Returns: the original, a pixelated version at the exact target width x height (showing how much detail actually survives at that resolution), and a suggested palette " +
        "argument block for set_palette (colors organized into light->dark ramp families, plus outlineIndex and rampFamilies). " +
        "Use BEFORE drawing when the user references a style or quality matters. Prefer CC0/CC-BY sources: kenney.nl, opengameart.org, lospec.com (palettes). " +
        "Pass sprite to match both its width and height, or gridSize for a square target.",
      inputSchema: {
        url: z.string().describe("http(s) URL of a PNG image"),
        sprite: z.string().optional().describe("existing sprite to match grid size against"),
        gridSize: z
          .number()
          .int()
          .optional()
          .describe(`grid size to pixelate against when no sprite exists yet — one of ${GRID_SIZES.join("/")} (default 32)`),
        colors: z.number().int().min(2).max(31).optional().describe("palette size target (default 12)"),
      },
    },
    safe(async ({ url, sprite, colors, gridSize: gridArg }) => {
      let width, height;
      if (sprite) {
        const s = storage.get(sprite);
        width = s.width;
        height = s.height;
      } else {
        width = gridArg ?? 32;
        height = width;
        if (!GRID_SIZES.includes(width)) {
          throw new Error(`gridSize must be one of ${GRID_SIZES.join("/")} (got ${width})`);
        }
      }
      const { png, path } = await fetchReference(url, storage.referencesDir);
      const prepared = prepareReference(png, { width, height, colors: colors ?? 12 });
      const args = JSON.stringify(prepared.suggestion, null, 2);

      return {
        content: [
          {
            type: "text",
            text: `Reference saved to ${path} (${png.width}x${png.height}). Below: original, then pixelated to ${width}x${height} (exact target dimensions, not forced square).`,
          },
          { type: "image", data: PNG.sync.write(prepared.original).toString("base64"), mimeType: "image/png" },
          { type: "image", data: PNG.sync.write(prepared.display).toString("base64"), mimeType: "image/png" },
          {
            type: "text",
            text:
              `Extracted ${prepared.extracted.colors.length} source colors. Study the PIXELATED version — that is how much detail survives at ${width}x${height}px; do not copy detail that only exists in the original.\n` +
              `For a NEW sprite, call set_palette with these arguments (organized light→dark ramp families, NOT frequency ordered):\n` +
              `${args}\n` +
              `Then call get_palette for index-specific drawing guidance (outline index, litEllipse triples). ` +
              `The suggested colors exclude transparent index 0 — set_palette prepends it; family/outline indices already include that slot. ` +
              `The actual-size scale: 1 render still decides when you are done.`,
          },
        ],
      };
    })
  );

  server.registerTool(
    "generate_sprite",
    {
      description:
        "Generate a sprite procedurally: run sandboxed painter JS on a big canvas (gridSize x scale), " +
        "downsample to the grid, and quantize into a palette-indexed sprite. Consider it for organic/gradient-heavy " +
        "art (foliage, rock, slime, fur) and grids >= 48 where hand-placed ops get expensive — not an automatic " +
        "choice for every large character; crisp hard-edged silhouettes are better with direct shape ops. " +
        "Painter API — W, H (canvas px), px(x, y, [r,g,b,a?]) set, over(x, y, [r,g,b,a?]) alpha-composite, " +
        "mix(a, b, t), clamp01(v), smooth(e0, e1, v), rng() (seeded, deterministic), log(...). " +
        "Write math (loops, lambert shading, noise), not per-pixel lists. " +
        "Returns the render — critique it, then regenerate with tweaked code + overwrite: true, or patch with draw.",
      inputSchema: {
        name: z.string().describe("sprite name (letters, digits, - and _)"),
        code: z.string().describe("painter JS, runs once in a sandbox"),
        gridSize: z.number().int().optional().describe(`one of ${GRID_SIZES.join("/")} (default 48)`),
        scale: z.number().int().min(2).max(8).optional().describe("big-canvas multiplier (default 4)"),
        colors: z.number().int().min(2).max(30).optional().describe("palette size target (default 12)"),
        seed: z.number().int().optional().describe("rng seed (default 1)"),
        overwrite: z.boolean().optional().describe("replace an existing sprite (grid + palette + animations reset)"),
      },
    },
    safe(({ name, code, gridSize, scale, colors, seed, overwrite }) => {
      const exists = storage.has(name);
      if (exists && !overwrite) {
        throw new Error(`sprite "${name}" already exists — pass overwrite: true to regenerate (replaces grid, palette, and animations)`);
      }
      const { sprite, logs } = generateSprite({ name, code, gridSize, scale, colors, seed });
      if (exists) storage.beginEdit(name);
      storage.save(sprite);
      const guidance = rampGuidance(sprite.rampFamilies);
      const msg =
        `Generated "${name}" (${sprite.width}x${sprite.height}), ${sprite.palette.length - 1} palette colors, outline index ${sprite.outlineIndex}. ` +
        (guidance ? `${guidance} ` : "") +
        `${PROP_CONTRAST_REMINDER} ` +
        (logs.length ? `Painter log: ${logs.join(" | ")}. ` : "") +
        `Critique the render honestly; regenerate with overwrite: true or patch with draw.${headroomNote(sprite)}`;
      return {
        content: [
          { type: "text", text: msg },
          png(renderPng(sprite.grid, sprite.palette)).content[0],
        ],
      };
    })
  );

  server.registerTool(
    "delete_sprite",
    { description: "Delete a sprite and all its animations. Confirm with the user first.", inputSchema: { sprite: z.string() } },
    safe(({ sprite }) => {
      storage.delete(sprite);
      return text(`Deleted "${sprite}".`);
    })
  );

  return server;
}
