#!/usr/bin/env node
// sprite-studio daemon: MCP endpoint (Streamable HTTP) + viewer web app + REST
// API + SSE live updates. Single owner of all project state.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, drawOpsSchema, getCapabilities } from "./tools.js";
import { SERVER_VERSION, DRAW_SCHEMA_REVISION } from "./version.js";
import { Storage } from "./storage.js";
import { displayGrid, insertFrame, deleteFrame, moveFrame, setFps, normalizeHex, resizeSprite, applyLayerOp } from "./model.js";
import { drawAndSave } from "./draw.js";
import { renderPng } from "./render.js";
import { exportSprite } from "./export.js";
import { generateSprite } from "./generate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith("--port="));
const rootArg = args.find((a) => a.startsWith("--root="));
const PORT = Number(portArg?.split("=")[1] ?? process.env.PORT ?? 7337);
const ROOT = path.resolve(rootArg?.split("=")[1] ?? process.cwd());

const storage = new Storage(ROOT);
const sseClients = new Set();

storage.onChange((event) => {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(msg);
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function notFound(res) {
  res.writeHead(404);
  res.end("not found");
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === "/api/sprites" && req.method === "GET") {
    const names = storage.list();
    return json(res, 200, { sprites: names.map((n) => storage.get(n)) });
  }

  if (p === "/api/capabilities" && req.method === "GET") {
    return json(res, 200, getCapabilities());
  }

  let m = /^\/api\/sprite\/([\w-]+)\/render\.png$/.exec(p);
  if (m && req.method === "GET") {
    try {
      const s = storage.get(m[1]);
      const anim = url.searchParams.get("anim");
      const frameParam = url.searchParams.get("frame");
      const frame = anim != null && frameParam != null ? { anim, index: Number(frameParam) } : undefined;
      const layer = url.searchParams.get("layer") ?? undefined;
      const grid = displayGrid(s, frame, layer);
      const buf = renderPng(grid, s.palette, {
        scale: Number(url.searchParams.get("scale")) || undefined,
        grid: url.searchParams.get("grid") === "1",
      });
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      return res.end(buf);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  m = /^\/api\/sprite\/([\w-]+)\/draw$/.exec(p);
  if (m && req.method === "POST") {
    // Same op format + validation path as the MCP draw tool.
    try {
      const body = JSON.parse(await readBody(req));
      const parsed = drawOpsSchema.safeParse(body.ops);
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
      const frame = body.anim != null ? { anim: body.anim, index: Number(body.frame ?? 0) } : undefined;
      const { sprite: s } = drawAndSave(storage, m[1], {
        frame,
        ops: parsed.data,
        mirror: Boolean(body.mirror),
        layer: body.layer ?? undefined,
      });
      return json(res, 200, { ok: true, version: s.version });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  m = /^\/api\/sprite\/([\w-]+)\/layers$/.exec(p);
  if (m && req.method === "POST") {
    // Validate on a dry-run clone before beginEdit() so a rejected layer op
    // leaves pixels, history, version, and SSE untouched.
    try {
      const body = JSON.parse(await readBody(req));
      const s = storage.get(m[1]);
      applyLayerOp(structuredClone(s), body);
      storage.beginEdit(m[1]);
      applyLayerOp(s, body);
      storage.save(s);
      return json(res, 200, { ok: true, version: s.version, layers: s.layers });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  m = /^\/api\/sprite\/([\w-]+)\/(undo|redo)$/.exec(p);
  if (m && req.method === "POST") {
    try {
      const s = m[2] === "undo" ? storage.undo(m[1]) : storage.redo(m[1]);
      return json(res, 200, { ok: true, version: s.version });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  m = /^\/api\/sprite\/([\w-]+)\/palette$/.exec(p);
  if (m && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const s = storage.get(m[1]);
      const idx = Number(body.index);
      if (!Number.isInteger(idx) || idx < 1 || idx >= s.palette.length) throw new Error("palette index out of range (index 0 is locked to transparent)");
      storage.beginEdit(s.name);
      s.palette[idx] = normalizeHex(String(body.color));
      // A manual color edit invalidates shade organization, but the indices
      // themselves did not move, so outlineIndex stays valid.
      delete s.rampFamilies;
      storage.save(s);
      return json(res, 200, { ok: true, version: s.version });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  m = /^\/api\/sprite\/([\w-]+)\/resize$/.exec(p);
  if (m && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const s = storage.get(m[1]);
      storage.beginEdit(s.name);
      resizeSprite(s, Number(body.width), Number(body.height));
      storage.save(s);
      return json(res, 200, { ok: true, version: s.version });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  m = /^\/api\/sprite\/([\w-]+)\/anim\/([\w-]+)\/frames$/.exec(p);
  if (m && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const s = storage.get(m[1]);
      storage.beginEdit(s.name);
      const idx = Number(body.index);
      switch (body.op) {
        case "add":
          insertFrame(s, m[2], idx, Boolean(body.copy));
          break;
        case "duplicate":
          insertFrame(s, m[2], idx, true);
          break;
        case "delete":
          deleteFrame(s, m[2], idx);
          break;
        case "move":
          moveFrame(s, m[2], Number(body.from), Number(body.to));
          break;
        default:
          throw new Error(`unknown frame op "${body.op}" (add|duplicate|delete|move)`);
      }
      storage.save(s);
      return json(res, 200, { ok: true, version: s.version });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  m = /^\/api\/sprite\/([\w-]+)\/anim\/([\w-]+)\/fps$/.exec(p);
  if (m && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const s = storage.get(m[1]);
      storage.beginEdit(s.name);
      setFps(s, m[2], Number(body.fps));
      storage.save(s);
      return json(res, 200, { ok: true, version: s.version });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  m = /^\/api\/sprite\/([\w-]+)\/generate$/.exec(p);
  if (m && req.method === "POST") {
    // Same generation path as the MCP generate_sprite tool.
    try {
      const body = JSON.parse(await readBody(req));
      if (typeof body.code !== "string" || !body.code) throw new Error("body.code (painter JS string) is required");
      const exists = storage.has(m[1]);
      if (exists && !body.overwrite) {
        throw new Error(`sprite "${m[1]}" already exists — set overwrite: true to regenerate`);
      }
      const { sprite, logs } = generateSprite({
        name: m[1],
        code: body.code,
        gridSize: body.gridSize,
        scale: body.scale,
        colors: body.colors,
        seed: body.seed,
      });
      if (exists) storage.beginEdit(sprite.name);
      storage.save(sprite);
      return json(res, 200, { ok: true, version: sprite.version, colors: sprite.palette.length - 1, ramps: sprite.rampFamilies, logs });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  m = /^\/api\/sprite\/([\w-]+)$/.exec(p);
  if (m && req.method === "DELETE") {
    try {
      storage.delete(m[1]);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  m = /^\/api\/export\/([\w-]+)$/.exec(p);
  if (m && req.method === "POST") {
    try {
      const s = storage.get(m[1]);
      const result = exportSprite(s, storage, {});
      return json(res, 200, { png: result.pngPath, json: result.jsonPath, frames: result.frames.length });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (p === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  return notFound(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        return res.end("Method Not Allowed — this is a stateless MCP endpoint, POST only");
      }
      const body = await readBody(req);
      // Stateless: fresh server + transport per request (local single-user tool)
      const mcpServer = createMcpServer(storage);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(body));
      return;
    }

    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);

    // static viewer
    let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.join(PUBLIC, path.normalize(file));
    if (!filePath.startsWith(PUBLIC) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return notFound(res);
    }
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    res.writeHead(200, { "content-type": types[path.extname(filePath)] ?? "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`sprite-studio v${SERVER_VERSION} (draw schema rev ${DRAW_SCHEMA_REVISION})`);
  console.log(`  project root : ${ROOT}`);
  console.log(`  MCP endpoint : http://127.0.0.1:${PORT}/mcp`);
  console.log(`  viewer       : http://127.0.0.1:${PORT}/`);
});
