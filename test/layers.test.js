import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import {
  createSprite,
  addLayer,
  removeLayer,
  reorderLayer,
  setLayerVisibility,
  layerGrid,
  baseGrid,
  flatten,
  applyLayerOp,
  addAnimation,
  targetGrid,
  resizeSprite,
  stageDraw,
  DEFAULT_PALETTE,
} from "../src/model.js";
import { Storage } from "../src/storage.js";
import { drawAndSave } from "../src/draw.js";
import { exportSprite } from "../src/export.js";

function tmpStorage() {
  return new Storage(fs.mkdtempSync(path.join(os.tmpdir(), "sprite-layers-")));
}

test("legacy single-grid sprite files migrate to layers on load", () => {
  const storage = tmpStorage();
  const legacy = {
    name: "legacy",
    width: 16,
    height: 16,
    palette: [...DEFAULT_PALETTE],
    grid: Array.from({ length: 16 }, () => new Array(16).fill(0)),
    animations: {},
    version: 3,
  };
  legacy.grid[4][5] = 7;
  fs.writeFileSync(storage.spritePath("legacy"), JSON.stringify(legacy));

  const s = storage.get("legacy");
  assert.deepEqual(
    s.layers,
    [{ name: "base", visible: true }],
    "legacy files load as one visible base layer"
  );
  assert.equal(s.grids.base[4][5], 7);
  assert.equal(s.grid, undefined, "legacy .grid is not kept as stored state");
  assert.deepEqual(flatten(s), legacy.grid);

  // Saving writes the new shape and never resurrects `grid`.
  storage.save(s);
  const onDisk = JSON.parse(fs.readFileSync(storage.spritePath("legacy"), "utf8"));
  assert.equal(onDisk.grid, undefined);
  assert.equal(onDisk.grids.base[4][5], 7);
  assert.deepEqual(onDisk.layers, [{ name: "base", visible: true }]);
});

test("flatten composites visible layers bottom-to-top and skips hidden ones", () => {
  const s = createSprite("f", 16, 16);
  addLayer(s, "costume");
  addLayer(s, "prop");
  layerGrid(s, "base")[1][1] = 5;
  layerGrid(s, "costume")[1][1] = 6;
  layerGrid(s, "prop")[1][1] = 7;
  layerGrid(s, "costume")[2][2] = 6;

  assert.equal(flatten(s)[1][1], 7, "topmost non-transparent wins");
  assert.equal(flatten(s)[2][2], 6, "lower layer shows where top is transparent");

  setLayerVisibility(s, "prop", false);
  assert.equal(flatten(s)[1][1], 6, "hidden layers are skipped");
  layerGrid(s, "costume")[1][1] = 0;
  assert.equal(flatten(s)[1][1], 5, "index 0 reveals the layer below");
});

test("draw targets the named layer only; default is the topmost layer", () => {
  const storage = tmpStorage();
  const s = storage.create("d", 16, 16);
  addLayer(s, "costume");
  storage.save(s);

  drawAndSave(storage, "d", { ops: [{ type: "rect", x: 2, y: 2, w: 2, h: 2, color: 6 }] });
  assert.equal(layerGrid(storage.get("d"), "costume")[2][2], 6);
  assert.equal(baseGrid(storage.get("d"))[2][2], 0);

  drawAndSave(storage, "d", {
    layer: "base",
    ops: [{ type: "rect", x: 5, y: 5, w: 2, h: 2, color: 5 }],
  });
  assert.equal(baseGrid(storage.get("d"))[5][5], 5);
  assert.equal(layerGrid(storage.get("d"), "costume")[5][5], 0);

  assert.throws(
    () => drawAndSave(storage, "d", { layer: "nope", ops: [{ type: "rect", x: 0, y: 0, w: 1, h: 1, color: 1 }] }),
    /no layer "nope"/
  );
});

test("outline and fill are layer-local, not composite-aware", () => {
  const s = createSprite("o", 16, 16);
  // Base silhouette at 4..6, 4..6
  s.grids.base[4][4] = 14;
  s.grids.base[4][5] = 14;
  addLayer(s, "detail");
  // A single pixel on the detail layer, far from the base blob.
  layerGrid(s, "detail")[10][10] = 6;

  drawAndSaveNoStorage(s, "detail", [{ type: "outline" }]);
  assert.equal(layerGrid(s, "detail")[9][10], 1, "detail pixel is outlined");
  assert.equal(baseGrid(s)[3][4], 0, "base pixels are not wrapped by a detail-layer outline");
  assert.equal(baseGrid(s)[4][4], 14);

  // fill on the detail layer cannot reach the base layer's region
  drawAndSaveNoStorage(s, "base", [{ type: "fill", x: 0, y: 0, color: 5 }]);
  assert.equal(baseGrid(s)[0][0], 5);
  assert.equal(layerGrid(s, "detail")[0][0], 0);
});

// Local helper: stage + commit without storage (mirrors drawAndSave's steps).
function drawAndSaveNoStorage(sprite, layer, ops) {
  const staged = stageDraw(sprite, undefined, ops, false, layer);
  staged.commit();
  return staged;
}

test("mirror is layer-local and commits to the intended layer", () => {
  const storage = tmpStorage();
  storage.create("mir", 16, 16);
  const s = storage.get("mir");
  addLayer(s, "detail");
  storage.save(s);

  drawAndSave(storage, "mir", {
    layer: "detail",
    mirror: true,
    ops: [{ type: "pixels", pixels: [{ x: 2, y: 5, color: 3 }] }],
  });
  assert.equal(layerGrid(storage.get("mir"), "detail")[5][2], 3);
  assert.equal(layerGrid(storage.get("mir"), "detail")[5][13], 3);
  assert.equal(baseGrid(storage.get("mir"))[5][2], 0, "base layer untouched by a mirrored detail draw");
});

test("add_animation flattens the composite into frame 0 and keeps frames flat", () => {
  const s = createSprite("a", 16, 16);
  addLayer(s, "costume");
  layerGrid(s, "base")[3][3] = 5;
  layerGrid(s, "costume")[3][3] = 6;
  addAnimation(s, "idle", 3, 5);

  assert.equal(s.animations.idle.frames[0][3][3], 6, "frame 0 = flattened composite");
  assert.equal(s.animations.idle.frames[1][3][3], 0, "later frames start blank");

  // Layer edits after animation creation do not leak into existing frames.
  layerGrid(s, "costume")[3][3] = 9;
  layerGrid(s, "base")[4][4] = 5;
  assert.equal(s.animations.idle.frames[0][3][3], 6);
  assert.equal(s.animations.idle.frames[0][4][4], 0);
  assert.equal(targetGrid(s, { anim: "idle", index: 0 })[3][3], 6);

  // Drawing to a frame ignores the layer argument (frames are flat).
  const staged = stageDraw(s, { anim: "idle", index: 1 }, [{ type: "rect", x: 0, y: 0, w: 1, h: 1, color: 2 }], false, "costume");
  staged.commit();
  assert.equal(s.animations.idle.frames[1][0][0], 2);
  assert.equal(layerGrid(s, "costume")[0][0], 0);
});

test("layer add/remove/reorder/visibility validation and flatten order", () => {
  const s = createSprite("l", 16, 16);
  assert.equal(s.layers.length, 1);
  assert.equal(s.layers[0].name, "base");

  addLayer(s, "a");
  addLayer(s, "b");
  layerGrid(s, "a")[5][5] = 5;
  layerGrid(s, "b")[5][5] = 6;
  assert.equal(flatten(s)[5][5], 6);

  reorderLayer(s, "b", 1);
  assert.deepEqual(s.layers.map((l) => l.name), ["base", "b", "a"]);
  assert.equal(flatten(s)[5][5], 5, "a is now on top");

  assert.throws(() => reorderLayer(s, "b", 3), /toIndex/);
  assert.throws(() => addLayer(s, "a"), /already exists/);
  assert.throws(() => addLayer(s, "bad name!"), /invalid layer name/);
  assert.throws(() => removeLayer(s, "nope"), /no layer/);

  removeLayer(s, "a");
  removeLayer(s, "b");
  assert.deepEqual(s.layers.map((l) => l.name), ["base"]);
  assert.throws(() => removeLayer(s, "base"), /last remaining/);
});

test("undo/redo walks across layer creation and drawing", () => {
  const storage = tmpStorage();
  storage.create("u", 16, 16);
  const sprite = storage.get("u");

  storage.beginEdit("u");
  addLayer(sprite, "costume");
  storage.save(sprite);
  drawAndSave(storage, "u", { ops: [{ type: "pixels", pixels: [{ x: 4, y: 4, color: 6 }] }] });
  assert.equal(layerGrid(storage.get("u"), "costume")[4][4], 6);

  let restored = storage.undo("u"); // undo the draw
  assert.equal(layerGrid(restored, "costume")[4][4], 0);
  assert.equal(restored.layers.length, 2);

  restored = storage.undo("u"); // undo layer creation
  assert.equal(restored.layers.length, 1);
  assert.equal(restored.layers[0].name, "base");

  restored = storage.redo("u");
  assert.equal(restored.layers.length, 2);
  // Multiple sequential undo snapshots never corrupt the migrated shape.
  assert.ok(restored.grids.base);
});

test("resizeSprite remaps every layer and animation frame", () => {
  const s = createSprite("r", 16, 16);
  addLayer(s, "detail");
  baseGrid(s)[15][0] = 4;
  layerGrid(s, "detail")[0][15] = 6;
  addAnimation(s, "idle", 2, 5);

  resizeSprite(s, 32, 32);
  assert.equal(baseGrid(s)[31][8], 4);
  assert.equal(layerGrid(s, "detail")[16][23], 6);
  assert.equal(s.animations.idle.frames[0][31][8], 4);
});

test("export writes the flattened composite, not raw layers", () => {
  const storage = tmpStorage();
  const s = storage.create("e", 16, 16);
  addLayer(s, "costume");
  baseGrid(s)[2][2] = 8; // palette index 8 = #d95763
  layerGrid(s, "costume")[2][2] = 14; // #38b764
  layerGrid(s, "costume")[3][3] = 14;
  storage.save(s);

  const { pngPath } = exportSprite(s, storage, { layout: "strip" });
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const at = (x, y) => {
    const i = (y * png.width + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
  };
  assert.deepEqual(at(2, 2), [0x38, 0xb7, 0x64, 255], "top layer wins");
  assert.deepEqual(at(3, 3), [0x38, 0xb7, 0x64, 255]);
  assert.deepEqual(at(5, 5), [0, 0, 0, 0], "transparent background");
});
