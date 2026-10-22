#!/usr/bin/env node
// sprite-studio daemon: MCP endpoint (Streamable HTTP) + viewer web app + REST
// API + SSE live updates. Single owner of all project state.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./tools.js";
import { Storage } from "./storage.js";
import { targetGrid } from "./model.js";
import { renderPng } from "./render.js";
import { exportSprite } from "./export.js";

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

  let m = /^\/api\/sprite\/([\w-]+)\/render\.png$/.exec(p);
  if (m && req.method === "GET") {
    try {
      const s = storage.get(m[1]);
      const anim = url.searchParams.get("anim");
      const frame = url.searchParams.get("frame");
      const grid = anim != null && frame != null ? targetGrid(s, { anim, index: Number(frame) }) : s.grid;
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

  m = /^\/api\/sprite\/([\w-]+)\/pixel$/.exec(p);
  if (m && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const s = storage.get(m[1]);
      const grid = body.anim != null ? targetGrid(s, { anim: body.anim, index: Number(body.frame ?? 0) }) : s.grid;
      if (body.x < 0 || body.x >= s.width || body.y < 0 || body.y >= s.height) throw new Error("out of bounds");
      if (!Number.isInteger(body.color) || body.color < 0 || body.color >= s.palette.length) throw new Error("bad color index");
      grid[body.y][body.x] = body.color;
      storage.save(s);
      return json(res, 200, { ok: true, version: s.version });
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
  console.log(`sprite-studio v0.1.0`);
  console.log(`  project root : ${ROOT}`);
  console.log(`  MCP endpoint : http://localhost:${PORT}/mcp`);
  console.log(`  viewer       : http://localhost:${PORT}/`);
});
