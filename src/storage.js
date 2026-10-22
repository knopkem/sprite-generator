// Project storage: sprites as JSON files under <root>/sprites,
// shared settings in <root>/project.json, exports to <root>/exports.
// In-memory cache; mutations bump version and broadcast to listeners.

import fs from "node:fs";
import path from "node:path";
import { createSprite } from "./model.js";

export class Storage {
  constructor(root) {
    this.root = root;
    this.spritesDir = path.join(root, "sprites");
    this.exportsDir = path.join(root, "exports");
    this.referencesDir = path.join(root, "reference-images");
    this.projectFile = path.join(root, "project.json");
    this.cache = new Map();
    this.listeners = new Set();
    // name -> { undo: string[], redo: string[] } (serialized sprite snapshots)
    this.history = new Map();
    for (const dir of [this.spritesDir, this.exportsDir, this.referencesDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.projectFile)) {
      fs.writeFileSync(this.projectFile, JSON.stringify({ created: new Date().toISOString() }, null, 2));
    }
  }

  /** Subscribe to change events: fn({ type, name }) */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) fn(event);
  }

  spritePath(name) {
    return path.join(this.spritesDir, `${name}.json`);
  }

  list() {
    return fs
      .readdirSync(this.spritesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  }

  has(name) {
    return fs.existsSync(this.spritePath(name));
  }

  get(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const file = this.spritePath(name);
    if (!fs.existsSync(file)) throw new Error(`no sprite "${name}" — create it with create_sprite`);
    const sprite = JSON.parse(fs.readFileSync(file, "utf8"));
    this.cache.set(name, sprite);
    return sprite;
  }

  create(name, width, height) {
    if (this.has(name)) throw new Error(`sprite "${name}" already exists`);
    const sprite = createSprite(name, width, height);
    this.save(sprite);
    return sprite;
  }

  /** Persist + bump version + broadcast. */
  save(sprite) {
    sprite.version = (sprite.version ?? 0) + 1;
    this.cache.set(sprite.name, sprite);
    fs.writeFileSync(this.spritePath(sprite.name), JSON.stringify(sprite));
    this.emit({ type: "sprite", name: sprite.name, version: sprite.version });
  }

  delete(name) {
    if (!this.has(name)) throw new Error(`no sprite "${name}"`);
    fs.unlinkSync(this.spritePath(name));
    this.cache.delete(name);
    this.history.delete(name);
    this.emit({ type: "delete", name });
  }

  /**
   * Snapshot the current state of `name` onto its undo stack and clear redo.
   * Call BEFORE mutating a sprite (both API and MCP tool paths).
   */
  beginEdit(name) {
    const sprite = this.get(name);
    let h = this.history.get(name);
    if (!h) this.history.set(name, (h = { undo: [], redo: [] }));
    h.undo.push(JSON.stringify(sprite));
    if (h.undo.length > 50) h.undo.shift();
    h.redo = [];
  }

  undo(name) {
    const h = this.history.get(name);
    if (!h || h.undo.length === 0) throw new Error(`nothing to undo for "${name}"`);
    const current = this.get(name);
    h.redo.push(JSON.stringify(current));
    const restored = JSON.parse(h.undo.pop());
    restored.version = current.version + 1; // versions only move forward
    this.cache.set(name, restored);
    fs.writeFileSync(this.spritePath(name), JSON.stringify(restored));
    this.emit({ type: "sprite", name, version: restored.version });
    return restored;
  }

  redo(name) {
    const h = this.history.get(name);
    if (!h || h.redo.length === 0) throw new Error(`nothing to redo for "${name}"`);
    const current = this.get(name);
    h.undo.push(JSON.stringify(current));
    const restored = JSON.parse(h.redo.pop());
    restored.version = current.version + 1;
    this.cache.set(name, restored);
    fs.writeFileSync(this.spritePath(name), JSON.stringify(restored));
    this.emit({ type: "sprite", name, version: restored.version });
    return restored;
  }

  exportPath(filename) {
    return path.join(this.exportsDir, filename);
  }
}
