// MCP tool definitions. Bulk-first: a full sprite should be drawable in 1-3
// draw calls. Strict validation with agent-friendly error messages.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodeGrid } from "./rle.js";
import { applyOps, targetGrid, mirrorHorizontal, addAnimation, copyFrame, normalizeHex, resizeSprite, contentBounds, GRID_SIZES, DEFAULT_PALETTE, PALETTE_FAMILIES } from "./model.js";
import { renderPng, renderOnionSkin } from "./render.js";
import { exportSprite } from "./export.js";
import { resizeAvg, upscaleNn, extractPalette, fetchReference } from "./reference.js";
import { PNG } from "pngjs";
import fs from "node:fs";

export const SERVER_INSTRUCTIONS = `Sprite Studio: draw and animate palette-indexed pixel art via tools.

Contract (read before drawing):
- Grids are ${GRID_SIZES.join("/")} px. Default 32. Above 32 quality degrades — warn the user.
- Palette index 0 is ALWAYS transparent. Reference colors by index only.
- Draw in BULK with shape ops, not scanline math: ellipse for heads/round
  shapes, line for limbs/props/arcs, rect for blocks, block for local RLE
  regions (rows have independent widths), rows (full-width RLE, must sum to
  grid width) only for whole-sprite fills. Never hundreds of single pixels.
- Workflow: set_palette (optional) -> draw silhouette -> get_render -> critique
  the render honestly -> fix with small draw patches -> repeat until good.
- ALWAYS get_render after each drawing pass. Never claim success without looking.
- The default palette is ramp-based: each hue family has light/mid/dark as
  adjacent indices. Shade with the darker ramp neighbor, highlight with the lighter.
- Deterministic ops beat hand-drawing: "outline" wraps the silhouette in an
  outline color; "shift" moves a whole frame (animation bob); mirror: true
  mirrors the left half for symmetric characters.
- Before declaring a sprite done: get_render with scale 2 and judge whether it
  still reads at game size. If it only looks good big, it isn't done.
- Leave headroom: characters at ~75-85% of grid height, 2-4px air per side.
  Animations need it. If an existing sprite is too tight, resize_sprite grows
  the grid without redrawing (content stays bottom-centered).
- Refinement = smallest possible patch (pixels/rect ops). Never redraw the whole
  grid unless the user asks for a redo.
- Animation: add_animation -> copy_frame from a neighbor -> patch the pose ->
  get_onion_skin to check motion -> fix per frame. Never regenerate all frames.
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
    type: z.literal("ellipse"),
    cx: z.number().int(),
    cy: z.number().int(),
    rx: z.number().int().min(1),
    ry: z.number().int().min(1),
    color: z.number().int().min(0),
    filled: z.boolean().optional().describe("default true; false = 1px ring"),
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
    { name: "sprite-studio", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "create_sprite",
    {
      description: `Create a new sprite. Grid size must be one of ${GRID_SIZES.join("/")} (default recommendation: 32; above 32 warn the user about quality). Comes with a default 16-color palette (index 0 = transparent).`,
      inputSchema: {
        name: z.string().describe("letters, digits, - and _"),
        width: z.number().int(),
        height: z.number().int(),
      },
    },
    safe(({ name, width, height }) => {
      const s = storage.create(name, width, height);
      const warn = width > 32 || height > 32 ? " WARNING: grids above 32 degrade LLM spatial coherence — expect to need more fix passes." : "";
      return text(`Created "${name}" (${width}x${height}), palette indices 0..${s.palette.length - 1} (0 = transparent).${warn} Draw the character at ~75-85% of grid height, bottom-centered, with 2-4px of air on every side — animations need that headroom. Next: draw the silhouette with a "rows" op, then get_render to look at it.`);
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
      description: "Get sprite metadata: size, palette, animations (names, fps, frame counts), version.",
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
      description: `Replace the sprite palette. Array of #rrggbb hex colors, max 32. Index 0 is forced to transparent. Current default: ${DEFAULT_PALETTE.slice(1).join(" ")}`,
      inputSchema: {
        sprite: z.string(),
        colors: z.array(z.string()).min(1).max(31).describe("hex colors; transparent index 0 is added automatically"),
      },
    },
    safe(({ sprite, colors }) => {
      const s = storage.get(sprite);
      storage.beginEdit(sprite);
      s.palette = ["#00000000", ...colors.map(normalizeHex)];
      // clamp existing grid indices into the new palette
      const max = s.palette.length - 1;
      for (const grid of [s.grid, ...Object.values(s.animations).flatMap((a) => a.frames)]) {
        for (const row of grid) for (let i = 0; i < row.length; i++) row[i] = Math.min(row[i], max);
      }
      storage.save(s);
      return text(`Palette set: ${s.palette.length} colors (index 0 = transparent). Existing pixels clamped to new range.`);
    })
  );

  server.registerTool(
    "get_palette",
    { description: "Get the sprite palette as an indexed list. On the default palette, entries are annotated with their ramp family.", inputSchema: { sprite: z.string() } },
    safe(({ sprite }) => {
      const s = storage.get(sprite);
      const isDefault =
        s.palette.length === DEFAULT_PALETTE.length && s.palette.every((c, i) => c === DEFAULT_PALETTE[i]);
      const lines = s.palette.map((c, i) => {
        const label = i === 0 ? "transparent" : isDefault ? PALETTE_FAMILIES[i] : null;
        return `${i}: ${c}${label ? ` (${label})` : ""}`;
      });
      if (isDefault) {
        lines.push(
          "Ramp families: shading = neighbor index within a family (e.g. green 13 light / 14 mid / 15 dark). " +
            "Distinct props (bow, quiver, clothing) should use DIFFERENT families — same-hue adjacent elements read as one blob."
        );
      }
      return text(lines.join("\n"));
    })
  );

  server.registerTool(
    "draw",
    {
      description:
        "Apply bulk draw ops to the base sprite or one animation frame. Ops run in order. " +
        "Think in shapes, not scanlines: ellipse for heads/round shapes, line for limbs/props/arcs, " +
        "rect for blocks, block for a small local RLE region (rows have independent widths), " +
        'rows (full-width RLE, each row must sum to grid width) for whole-sprite fills. ' +
        'Use "pixels" (max 512) for small fixes, "clear" to wipe. ' +
        '"outline" wraps the silhouette in an outline color automatically (draw flat shapes first, outline after). ' +
        '"fill" flood-fills a region from a point. ' +
        '"shift" translates the whole grid by dx/dy (animation bob/squash). ' +
        "mirror: true mirrors the left half onto the right AFTER ops run (for symmetric sprites). " +
        "Palette ramps: shading = pick the neighbor index within a ramp family (see get_palette). " +
        "Always get_render afterwards and look at the result.",
      inputSchema: {
        sprite: z.string(),
        ops: z.array(drawOp).min(1).max(50),
        frame: frameRef,
        mirror: z.boolean().optional(),
      },
    },
    safe(({ sprite, ops, frame, mirror }) => {
      const s = storage.get(sprite);
      storage.beginEdit(sprite);
      const grid = targetGrid(s, frame);
      applyOps(s, grid, ops);
      if (mirror) mirrorHorizontal(s, grid);
      storage.save(s);
      const target = frame ? `frame ${frame.index} of "${frame.anim}"` : "base sprite";
      return text(`Applied ${ops.length} op(s) to ${target}${mirror ? " (mirrored)" : ""}. Now call get_render and critique the result.${frame ? "" : headroomNote(s)}`);
    })
  );

  server.registerTool(
    "get_render",
    {
      description:
        "Render the sprite (or one animation frame) to an upscaled PNG and LOOK at it. " +
        "This is your only way to see your work — use it after every drawing pass. " +
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
        "Download a reference image for style study. Returns: the original, a pixelated version at " +
        "the sprite's grid size (showing how much detail actually survives at that resolution), and a " +
        "quantized palette ready for set_palette. Use BEFORE drawing when the user references a style " +
        "or quality matters. Prefer CC0/CC-BY sources: kenney.nl, opengameart.org, lospec.com (palettes). " +
        "PNG only.",
      inputSchema: {
        url: z.string().describe("http(s) URL of a PNG image"),
        sprite: z.string().optional().describe("sprite to match grid size against (default 32)"),
        colors: z.number().int().min(2).max(31).optional().describe("palette size target (default 12)"),
      },
    },
    safe(async ({ url, sprite, colors }) => {
      const gridSize = sprite ? storage.get(sprite).width : 32;
      const { png, path } = await fetchReference(url, storage.referencesDir);

      // original view, capped at 512px on the long edge
      const cap = 512 / Math.max(png.width, png.height);
      const original = cap < 1 ? resizeAvg(png, Math.round(png.width * cap), Math.round(png.height * cap)) : png;

      const pixelated = resizeAvg(png, gridSize, gridSize);
      const display = upscaleNn(pixelated, Math.max(1, Math.floor(512 / gridSize)));
      const palette = extractPalette(pixelated, colors ?? 12);

      return {
        content: [
          { type: "text", text: `Reference saved to ${path} (${png.width}x${png.height}). Below: original, then pixelated to ${gridSize}x${gridSize}.` },
          { type: "image", data: PNG.sync.write(original).toString("base64"), mimeType: "image/png" },
          { type: "image", data: PNG.sync.write(display).toString("base64"), mimeType: "image/png" },
          {
            type: "text",
            text:
              `Extracted palette (${palette.length} colors, most frequent first): ${palette.join(", ")}\n` +
              `Study the PIXELATED version — that is how much detail survives at ${gridSize}px; do not copy detail that only exists in the original. ` +
              `The palette is ready for set_palette. Then draw per the sprite-draw workflow; the scale-2 render check still decides when you're done.`,
          },
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
