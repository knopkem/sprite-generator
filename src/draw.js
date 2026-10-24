// Shared storage-aware draw commit. Both the MCP draw tool and the REST draw
// route go through here so a failed multi-op draw is atomic:
//   stage everything first -> one undo snapshot -> one commit -> one save.

import { stageDraw } from "./model.js";

/**
 * Apply ops to a sprite (base grid or one animation frame) and persist once.
 * Validation and all rasterization happen on a clone before beginEdit(), so
 * failures leave grid, file, version, history, and SSE untouched.
 *
 * @param {import("./storage.js").Storage} storage
 * @param {string} name
 * @param {{ frame?: { anim: string, index: number }, ops: object[], mirror?: boolean }} options
 * @returns {{ sprite: object, grid: number[][] }}
 */
export function drawAndSave(storage, name, { frame, ops, mirror = false }) {
  const sprite = storage.get(name);
  const staged = stageDraw(sprite, frame, ops, mirror);
  storage.beginEdit(name);
  staged.commit();
  storage.save(sprite);
  return { sprite, grid: staged.grid };
}
