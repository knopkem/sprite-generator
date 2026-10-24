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
import { GRID_SIZES } from "../src/model.js";
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
    assert.equal(h.storage.get("legacy").grid[3][4], 1);
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
    assert.equal(h.storage.get("mcp-draw").grid[4][4], 7);
    assert.equal(h.storage.get("mcp-draw").grid[1][1], 0);
  } finally {
    await h.close();
  }
});
