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
    this.projectFile = path.join(root, "project.json");
    this.cache = new Map();
    this.listeners = new Set();
    for (const dir of [this.spritesDir, this.exportsDir]) {
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
    this.emit({ type: "delete", name });
  }

  exportPath(filename) {
    return path.join(this.exportsDir, filename);
  }
}
