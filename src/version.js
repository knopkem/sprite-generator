// Single source of truth for the running server identity.
// Clients can cache MCP tool schemas; when diagnostics look stale, compare
// get_capabilities / GET /api/capabilities against this source.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

/** package.json version, reported by MCP metadata, startup log and capabilities. */
export const SERVER_VERSION = pkg.version;

/**
 * Increment whenever a draw op is added or its semantics change. Clients must
 * restart the daemon and reconnect the MCP session to pick up new schemas.
 *   1: rows/rect/pixels/clear/outline/fill/line/curve/ellipse/litEllipse/
 *      rampRect/block/shift
 *   2: + polygon, taperedLine
 */
export const DRAW_SCHEMA_REVISION = 2;
