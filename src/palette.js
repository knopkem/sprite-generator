// Shared palette organization/metadata helpers. Lives outside generate.js so
// reference preparation can suggest palettes without depending on the sandboxed
// generator (and without a dependency cycle).

import { parseColor } from "./render.js";

const HUE_GAP = 28; // degrees; a larger hue jump starts a new family
const NEUTRAL_SAT = 0.18; // below this saturation a color joins the neutral family
const HUE_NAMES = [
  [15, "red"], [48, "orange"], [68, "yellow"], [150, "green"], [180, "teal"],
  [200, "cyan"], [250, "blue"], [285, "purple"], [330, "pink"], [361, "red"],
];

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hueName(h) {
  for (const [limit, name] of HUE_NAMES) if (h < limit) return name;
  return "red";
}

/**
 * Organize extracted palette hexes into ramp families: same-hue shades become
 * adjacent, ordered light -> dark (the DEFAULT_PALETTE ramp convention, so
 * litEllipse ramp: [i, i+1, i+2] picks shading neighbors). Families are
 * ordered by pixel usage, most-used first; low-saturation colors form a
 * "neutral" family. Hue is circular — reds at both ends merge.
 * @returns {{ palette: string[], families: Array<{name, from, to}>, remap: number[] }}
 *   palette includes transparent at index 0; families use palette indices;
 *   remap maps extracted-color index -> final palette index.
 */
export function organizePalette(hexes, counts) {
  const entries = hexes.map((hex, i) => {
    const parsed = parseColor(hex);
    if (!parsed) throw new Error(`invalid palette color "${hex}"`);
    return { hex, ...rgbToHsl(parsed[0], parsed[1], parsed[2]), count: counts?.[i] ?? 1, old: i };
  });
  const neutral = entries.filter((e) => e.s < NEUTRAL_SAT);
  const chromatic = entries.filter((e) => e.s >= NEUTRAL_SAT).sort((a, b) => a.h - b.h);

  let clusters = [];
  for (const e of chromatic) {
    const last = clusters.at(-1);
    if (!last || e.h - last.at(-1).h > HUE_GAP) clusters.push([]);
    clusters.at(-1).push(e);
  }
  // hue is circular: merge the two end clusters when they wrap (e.g. reds)
  if (clusters.length > 1) {
    const first = clusters[0], last = clusters.at(-1);
    if (first[0].h + 360 - last.at(-1).h <= HUE_GAP) {
      clusters = [[...last, ...first], ...clusters.slice(1, -1)];
    }
  }
  if (neutral.length) clusters.push(neutral);

  // light -> dark within a family; families by usage
  for (const c of clusters) c.sort((a, b) => b.l - a.l);
  clusters.sort((a, b) => b.reduce((s, e) => s + e.count, 0) - a.reduce((s, e) => s + e.count, 0));

  // merge adjacent families that share a name (hue gap split one family)
  const merged = [];
  for (const c of clusters) {
    const name = c[0].s < NEUTRAL_SAT ? "neutral" : hueName(c[0].h);
    const prev = merged.at(-1);
    if (prev && prev.name === name) prev.entries.push(...c);
    else merged.push({ name, entries: [...c] });
  }
  for (const f of merged) f.entries.sort((a, b) => b.l - a.l);

  const palette = ["#00000000"];
  const families = [];
  const remap = new Array(hexes.length).fill(0);
  for (const f of merged) {
    const from = palette.length;
    for (const e of f.entries) {
      remap[e.old] = palette.length;
      palette.push(e.hex);
    }
    families.push({ name: f.name, from, to: palette.length - 1 });
  }
  return { palette, families, remap };
}

/**
 * Opaque palette index with the lowest luminance — the natural outline color.
 * Ignores index 0 and any fully transparent entries. Returns 1 for a palette
 * with no opaque color.
 */
export function suggestOutlineIndex(palette) {
  let best = null;
  let bestLum = Infinity;
  for (let i = 1; i < palette.length; i++) {
    const c = parseColor(palette[i]);
    if (!c) continue;
    const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    if (lum < bestLum) { bestLum = lum; best = i; }
  }
  return best ?? 1;
}

/**
 * Adjacent [light, mid, dark] triples that are valid litEllipse ramps.
 * Families with fewer than three entries have no triple: they support manual
 * light/dark shading but cannot drive a three-stop litEllipse ramp.
 */
export function rampTripleSuggestions(family) {
  const triples = [];
  const { from, to } = family;
  for (let i = from; i + 2 <= to; i++) triples.push([i, i + 1, i + 2]);
  return triples;
}
