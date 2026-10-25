import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Storage } from "../src/storage.js";
import { createMcpServer, DRAW_OP_TYPES, getCapabilities } from "../src/tools.js";
import { SERVER_VERSION, DRAW_SCHEMA_REVISION } from "../src/version.js";
import { GRID_SIZES, addAnimation, baseGrid } from "../src/model.js";
import { prepareReference } from "../src/reference.js";
import { PNG } from "pngjs";

function makePng(w, h, paint) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * w + x) * 4;
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a;
    }
  }
  return png;
}

async function harness() {
  const storage = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), "sprite-mcp-")));
  const server = createMcpServer(storage);
  const client = new Client({ name: "sprite-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    storage,
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Collect op discriminators from a JSON schema without depending on SDK formatting. */
function collectTypeDiscriminators(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  const type = node.properties?.type;
  if (type) {
    if (typeof type.const === "string") out.add(type.const);
    if (Array.isArray(type.enum)) for (const v of type.enum) if (typeof v === "string") out.add(v);
  }
  for (const value of Object.values(node)) collectTypeDiscriminators(value, out);
  return out;
}

test("MCP tools/list advertises exactly the registered draw ops", async () => {
  const h = await harness();
  try {
    const { tools } = await h.client.listTools();
    const draw = tools.find((t) => t.name === "draw");
    assert.ok(draw, "draw tool must be registered");
    const advertised = collectTypeDiscriminators(draw.inputSchema.properties.ops);
    assert.deepEqual([...advertised].sort(), [...DRAW_OP_TYPES].sort());
  } finally {
    await h.close();
  }
});

test("MCP tools/list includes every implemented draw op (baseline regression)", async () => {
  const h = await harness();
  try {
    const { tools } = await h.client.listTools();
    const draw = tools.find((t) => t.name === "draw");
    const advertised = collectTypeDiscriminators(draw.inputSchema.properties.ops);
    const expected = [
      "rows", "rect", "pixels", "clear", "outline", "fill", "line", "curve",
      "polygon", "taperedLine", "ellipse", "litEllipse", "rampRect", "block", "shift",
    ];
    for (const op of expected) assert.ok(advertised.has(op), `draw schema is missing "${op}"`);
  } finally {
    await h.close();
  }
});

test("MCP get_capabilities agrees with tools/list, version, revision, and grid sizes", async () => {
  const h = await harness();
  try {
    const result = await h.client.callTool({ name: "get_capabilities", arguments: {} });
    assert.notEqual(result.isError, true);
    const caps = JSON.parse(result.content.find((c) => c.type === "text").text);

    assert.equal(caps.serverVersion, SERVER_VERSION);
    assert.equal(caps.drawSchemaRevision, DRAW_SCHEMA_REVISION);
    assert.deepEqual(caps.gridSizes, GRID_SIZES);
    assert.deepEqual([...caps.drawOps].sort(), [...DRAW_OP_TYPES].sort());
    assert.equal(caps.features.transactionalDraw, true);
    assert.equal(caps.features.inlineDrawRender, true);
    assert.equal(caps.features.generateSprite, true);
    assert.equal(caps.features.previewDraw, true);
    assert.equal(caps.features.layers, true);

    const { tools } = await h.client.listTools();
    const draw = tools.find((t) => t.name === "draw");
    const advertised = collectTypeDiscriminators(draw.inputSchema.properties.ops);
    assert.deepEqual([...advertised].sort(), [...caps.drawOps].sort());
    assert.deepEqual(getCapabilities().drawOps, caps.drawOps);
  } finally {
    await h.close();
  }
});

test("MCP set_palette stores custom outline and ramp metadata", async () => {
  const h = await harness();
  try {
    h.storage.create("p", 16, 16);
    const result = await h.client.callTool({
      name: "set_palette",
      arguments: {
        sprite: "p",
        colors: ["#111111", "#222222", "#333333", "#eeeeee", "#dddddd"],
        outlineIndex: 4,
        rampFamilies: [
          { name: "dark", from: 1, to: 2 },
          { name: "light", from: 3, to: 5 },
        ],
      },
    });
    assert.notEqual(result.isError, true);

    const s = h.storage.get("p");
    assert.equal(s.palette.length, 6);
    assert.equal(s.outlineIndex, 4);
    assert.deepEqual(s.rampFamilies, [
      { name: "dark", from: 1, to: 2 },
      { name: "light", from: 3, to: 5 },
    ]);

    const palette = await h.client.callTool({ name: "get_palette", arguments: { sprite: "p" } });
    const text = palette.content.find((c) => c.type === "text").text;
    assert.match(text, /outlineIndex: 4/);
    assert.match(text, /litEllipse triples: light: \[3,4,5\]/);
    assert.match(text, /Manual light\/dark shading only \(no three-stop litEllipse ramp\): dark 1-2/);
    assert.match(text, /DIFFERENT families/); // prop-contrast reminder always present

    const state = await h.client.callTool({ name: "get_state", arguments: { sprite: "p" } });
    assert.equal(JSON.parse(state.content[0].text).outlineIndex, 4);
  } finally {
    await h.close();
  }
});

test("MCP set_palette rejects invalid outline/families atomically", async () => {
  const h = await harness();
  try {
    const sprite = h.storage.create("p", 16, 16);
    const snapshot = JSON.stringify(sprite);
    const version = sprite.version;
    let events = 0;
    h.storage.onChange(() => events++);

    const colors = ["#111111", "#222222", "#333333", "#eeeeee"];
    const bad = [
      { outlineIndex: 0 },
      { outlineIndex: 5 }, // palette length will be 5 -> max index 4
      { rampFamilies: [{ name: "  ", from: 1, to: 2 }] },
      { rampFamilies: [{ name: "x", from: 0, to: 2 }] },
      { rampFamilies: [{ name: "x", from: 1, to: 5 }] },
      { rampFamilies: [{ name: "x", from: 3, to: 2 }] },
      {
        rampFamilies: [
          { name: "a", from: 1, to: 3 },
          { name: "b", from: 3, to: 4 },
        ],
      },
    ];
    for (const args of bad) {
      const result = await h.client.callTool({ name: "set_palette", arguments: { sprite: "p", colors, ...args } });
      assert.equal(result.isError, true, `expected rejection for ${JSON.stringify(args)}`);
      const message = result.content.find((c) => c.type === "text").text;
      assert.match(message, /Error:/);
    }

    assert.equal(JSON.stringify(h.storage.get("p")), snapshot);
    assert.equal(h.storage.get("p").version, version);
    assert.equal(events, 0);
    assert.equal(h.storage.history.get("p"), undefined);
    assert.throws(() => h.storage.undo("p"), /nothing to undo/);
  } finally {
    await h.close();
  }
});

test("prepareReference suggestion round-trips through set_palette validation", async () => {
  const h = await harness();
  try {
    h.storage.create("ref", 32, 16);
    const src = makePng(40, 20, (x, y) => [x * 6 % 256, y * 12, (x + y) % 256, 255]);
    const { suggestion } = prepareReference(src, { width: 32, height: 16, colors: 5 });

    const result = await h.client.callTool({
      name: "set_palette",
      arguments: { sprite: "ref", ...suggestion },
    });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);

    const s = h.storage.get("ref");
    assert.deepEqual(s.palette.slice(1), suggestion.colors);
    assert.equal(s.outlineIndex, suggestion.outlineIndex);
    assert.deepEqual(s.rampFamilies, suggestion.rampFamilies);
  } finally {
    await h.close();
  }
});

test("legacy sprites without outlineIndex/rampFamilies still read as defaults", async () => {
  const h = await harness();
  try {
    const sprite = h.storage.create("legacy", 16, 16);
    delete sprite.outlineIndex;
    delete sprite.rampFamilies;
    h.storage.save(sprite);

    const palette = await h.client.callTool({ name: "get_palette", arguments: { sprite: "legacy" } });
    const text = palette.content.find((c) => c.type === "text").text;
    assert.match(text, /outlineIndex: 1/);
    assert.match(text, /Ramp families/);

    const state = await h.client.callTool({ name: "get_state", arguments: { sprite: "legacy" } });
    assert.equal(JSON.parse(state.content[0].text).outlineIndex, 1);

    const draw = await h.client.callTool({
      name: "draw",
      arguments: {
        sprite: "legacy",
        render: false,
        ops: [
          { type: "rect", x: 4, y: 4, w: 2, h: 2, color: 14 },
          { type: "outline" },
        ],
      },
    });
    assert.notEqual(draw.isError, true);
    assert.equal(baseGrid(h.storage.get("legacy"))[3][4], 1);
  } finally {
    await h.close();
  }
});

test("MCP draw commit:false previews without touching state, history, or SSE", async () => {
  const h = await harness();
  try {
    const sprite = h.storage.create("preview", 16, 16);
    const snapshot = JSON.stringify(sprite);
    const version = sprite.version;
    let events = 0;
    h.storage.onChange(() => events++);

    const ops = [
      { type: "rect", x: 2, y: 2, w: 4, h: 4, color: 5 },
      { type: "pixels", pixels: [{ x: 8, y: 8, color: 9 }] },
    ];
    const preview = await h.client.callTool({ name: "draw", arguments: { sprite: "preview", ops, commit: false } });
    assert.notEqual(preview.isError, true);
    const previewText = preview.content.find((c) => c.type === "text").text;
    assert.match(previewText, /PREVIEW ONLY — not saved/);
    assert.match(previewText, /Re-run the same ops without commit: false/);
    const previewImage = preview.content.find((c) => c.type === "image");
    assert.ok(previewImage, "preview must return a render");

    // Nothing observable changed.
    assert.equal(JSON.stringify(h.storage.get("preview")), snapshot);
    assert.equal(h.storage.get("preview").version, version);
    assert.equal(events, 0);
    assert.equal(h.storage.history.get("preview"), undefined);
    assert.throws(() => h.storage.undo("preview"), /nothing to undo/);

    // Committing the same ops produces the previewed grid and render.
    const committed = await h.client.callTool({ name: "draw", arguments: { sprite: "preview", ops } });
    assert.notEqual(committed.isError, true);
    const committedImage = committed.content.find((c) => c.type === "image");
    assert.equal(committedImage.data, previewImage.data);
    assert.equal(baseGrid(h.storage.get("preview"))[2][2], 5);
    assert.equal(baseGrid(h.storage.get("preview"))[8][8], 9);
    assert.equal(events, 1);
    assert.equal(h.storage.history.get("preview").undo.length, 1);
  } finally {
    await h.close();
  }
});

test("MCP draw commit:false targets an animation frame without mutating it", async () => {
  const h = await harness();
  try {
    const sprite = h.storage.create("preview-anim", 16, 16);
    addAnimation(sprite, "idle", 2, 5);
    h.storage.save(sprite);
    const baseBefore = JSON.stringify(baseGrid(sprite));
    const frameBefore = JSON.stringify(sprite.animations.idle.frames[1]);
    const version = sprite.version;
    let events = 0;
    h.storage.onChange(() => events++);

    const result = await h.client.callTool({
      name: "draw",
      arguments: {
        sprite: "preview-anim",
        frame: { anim: "idle", index: 1 },
        ops: [{ type: "rect", x: 1, y: 1, w: 2, h: 2, color: 7 }],
        commit: false,
      },
    });
    assert.notEqual(result.isError, true);
    assert.match(result.content.find((c) => c.type === "text").text, /frame 1 of "idle"/);

    assert.equal(JSON.stringify(baseGrid(sprite)), baseBefore);
    assert.equal(JSON.stringify(sprite.animations.idle.frames[1]), frameBefore);
    assert.equal(sprite.version, version);
    assert.equal(events, 0);
    assert.equal(h.storage.history.get("preview-anim"), undefined);
  } finally {
    await h.close();
  }
});

test("MCP draw accepts fractional shape coords but rejects fractional thickness", async () => {
  const h = await harness();
  try {
    h.storage.create("frac", 16, 16);
    const ok = await h.client.callTool({
      name: "draw",
      arguments: {
        sprite: "frac",
        render: false,
        ops: [
          { type: "line", x0: 2.5, y0: 2.5, x1: 12.5, y1: 2.5, color: 5 },
          { type: "ellipse", cx: 7.5, cy: 7.5, rx: 3.5, ry: 2.5, color: 6 },
          { type: "curve", x0: 1.5, y0: 14, cx: 7.5, cy: 10.5, x1: 14.5, y1: 14, color: 7 },
        ],
      },
    });
    assert.notEqual(ok.isError, true, ok.content?.[0]?.text);
    assert.equal(baseGrid(h.storage.get("frac"))[2][7], 5);
    assert.equal(baseGrid(h.storage.get("frac"))[7][7], 6);

    const bad = await h.client.callTool({
      name: "draw",
      arguments: {
        sprite: "frac",
        render: false,
        ops: [{ type: "line", x0: 1, y0: 1, x1: 10, y1: 10, color: 1, thickness: 1.5 }],
      },
    });
    assert.equal(bad.isError, true);
    assert.match(bad.content.find((c) => c.type === "text").text, /thickness|Expected int|Invalid input/i);
  } finally {
    await h.close();
  }
});

test("MCP layer tools manage z-order and draw targets layers", async () => {
  const h = await harness();
  try {
    h.storage.create("layered", 16, 16);

    const add = await h.client.callTool({ name: "add_layer", arguments: { sprite: "layered", name: "costume" } });
    assert.notEqual(add.isError, true, add.content?.[0]?.text);

    const state = await h.client.callTool({ name: "get_state", arguments: { sprite: "layered" } });
    assert.deepEqual(JSON.parse(state.content[0].text).layers, [
      { name: "base", visible: true },
      { name: "costume", visible: true },
    ]);

    // Default draw target = topmost layer.
    const top = await h.client.callTool({
      name: "draw",
      arguments: { sprite: "layered", render: false, ops: [{ type: "rect", x: 2, y: 2, w: 2, h: 2, color: 6 }] },
    });
    assert.notEqual(top.isError, true);
    assert.match(top.content[0].text, /layer "costume"/);
    assert.equal(h.storage.get("layered").grids.costume[2][2], 6);
    assert.equal(h.storage.get("layered").grids.base[2][2], 0);

    // Explicit layer target.
    const baseDraw = await h.client.callTool({
      name: "draw",
      arguments: { sprite: "layered", layer: "base", render: false, ops: [{ type: "rect", x: 5, y: 5, w: 2, h: 2, color: 5 }] },
    });
    assert.notEqual(baseDraw.isError, true);
    assert.match(baseDraw.content[0].text, /layer "base"/);
    assert.equal(h.storage.get("layered").grids.base[5][5], 5);
    assert.equal(h.storage.get("layered").grids.costume[5][5], 0);

    // get_grid can read one layer or the composite.
    const composite = await h.client.callTool({ name: "get_grid", arguments: { sprite: "layered" } });
    assert.match(composite.content[0].text, /16:0/); // RLE text, composite readable
    const oneLayer = await h.client.callTool({ name: "get_grid", arguments: { sprite: "layered", layer: "costume" } });
    assert.equal(oneLayer.content[0].text.includes("6"), true);

    // Visibility and reorder.
    const hide = await h.client.callTool({ name: "set_layer_visibility", arguments: { sprite: "layered", name: "costume", visible: false } });
    assert.notEqual(hide.isError, true);
    assert.equal(h.storage.get("layered").layers.find((l) => l.name === "costume").visible, false);

    const reorder = await h.client.callTool({ name: "reorder_layer", arguments: { sprite: "layered", name: "costume", toIndex: 0 } });
    assert.notEqual(reorder.isError, true);
    assert.deepEqual(h.storage.get("layered").layers.map((l) => l.name), ["costume", "base"]);

    const remove = await h.client.callTool({ name: "remove_layer", arguments: { sprite: "layered", name: "costume" } });
    assert.notEqual(remove.isError, true);
    assert.deepEqual(h.storage.get("layered").layers.map((l) => l.name), ["base"]);
  } finally {
    await h.close();
  }
});

test("MCP invalid layer ops are atomic and agent-readable", async () => {
  const h = await harness();
  try {
    const sprite = h.storage.create("layers-bad", 16, 16);
    const snapshot = JSON.stringify(sprite);
    const version = sprite.version;
    let events = 0;
    h.storage.onChange(() => events++);

    const attempts = [
      { name: "remove_layer", arguments: { sprite: "layers-bad", name: "base" } },
      { name: "remove_layer", arguments: { sprite: "layers-bad", name: "nope" } },
      { name: "add_layer", arguments: { sprite: "layers-bad", name: "base" } },
      { name: "add_layer", arguments: { sprite: "layers-bad", name: "bad name!" } },
      { name: "reorder_layer", arguments: { sprite: "layers-bad", name: "base", toIndex: 4 } },
      {
        name: "draw",
        arguments: { sprite: "layers-bad", layer: "nope", render: false, ops: [{ type: "rect", x: 0, y: 0, w: 1, h: 1, color: 1 }] },
      },
    ];
    for (const attempt of attempts) {
      const result = await h.client.callTool(attempt);
      assert.equal(result.isError, true, `expected rejection for ${attempt.name}`);
      assert.match(result.content.find((c) => c.type === "text").text, /Error:/);
    }

    assert.equal(JSON.stringify(h.storage.get("layers-bad")), snapshot);
    assert.equal(h.storage.get("layers-bad").version, version);
    assert.equal(events, 0);
    assert.equal(h.storage.history.get("layers-bad"), undefined);
  } finally {
    await h.close();
  }
});

test("MCP draw with a valid then invalid op is atomic and agent-readable", async () => {
  const h = await harness();
  try {
    const sprite = h.storage.create("mcp-draw", 16, 16);
    const snapshot = JSON.stringify(sprite);
    const version = sprite.version;
    let events = 0;
    h.storage.onChange(() => events++);

    const result = await h.client.callTool({
      name: "draw",
      arguments: {
        sprite: "mcp-draw",
        render: false,
        ops: [
          { type: "rect", x: 1, y: 1, w: 2, h: 2, color: 5 },
          { type: "rect", x: 1, y: 1, w: 2, h: 2, color: 99 }, // invalid palette index
        ],
      },
    });

    assert.equal(result.isError, true);
    const message = result.content.find((c) => c.type === "text").text;
    assert.match(message, /palette range/);
    assert.match(message, /Error:/);

    assert.equal(JSON.stringify(h.storage.get("mcp-draw")), snapshot);
    assert.equal(h.storage.get("mcp-draw").version, version);
    assert.equal(events, 0);
    assert.equal(h.storage.history.get("mcp-draw"), undefined);

    // A subsequent valid draw succeeds and only the final grid is visible.
    const ok = await h.client.callTool({
      name: "draw",
      arguments: { sprite: "mcp-draw", render: false, ops: [{ type: "pixels", pixels: [{ x: 4, y: 4, color: 7 }] }] },
    });
    assert.notEqual(ok.isError, true);
    assert.equal(baseGrid(h.storage.get("mcp-draw"))[4][4], 7);
    assert.equal(baseGrid(h.storage.get("mcp-draw"))[1][1], 0);
  } finally {
    await h.close();
  }
});
