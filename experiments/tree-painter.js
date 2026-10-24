// Painter code for the generate_sprite demo: a gnarled tree at 48px grid
// (192px canvas). Organic shapes: canopy blob-field with lambert shading +
// noise speckle, tapered trunk with grain, branch segments.
const cx = W / 2;

// trunk: tapered, light from the left
for (let y = Math.round(H * 0.42); y < H; y++) {
  const t = (y - H * 0.42) / (H * 0.58); // 0 top -> 1 bottom
  const hw = W * 0.030 + t * W * 0.045; // widen downward
  for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) {
    const nx = (x - cx) / hw; // -1..1 across the trunk
    const lam = clamp01(0.5 - 0.45 * nx);
    let col = mix([64, 40, 28], [152, 108, 66], lam);
    if (rng() < 0.12) col = mix(col, [40, 26, 18], 0.5); // bark grain
    px(x, y, col);
  }
}

// branches: thick segments into the canopy
function seg(x0, y0, x1, y1, r, col) {
  for (let y = Math.floor(Math.min(y0, y1) - r * 2); y <= Math.max(y0, y1) + r * 2; y++) {
    for (let x = Math.floor(Math.min(x0, x1) - r * 2); x <= Math.max(x0, x1) + r * 2; x++) {
      const dx = x1 - x0, dy = y1 - y0;
      const t = clamp01(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy));
      if (Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t)) <= r) px(x, y, col);
    }
  }
}
seg(cx, H * 0.58, cx - W * 0.17, H * 0.40, W * 0.018, [84, 54, 34]);
seg(cx, H * 0.52, cx + W * 0.15, H * 0.36, W * 0.016, [84, 54, 34]);

// canopy: union of soft blobs, lambert-shaded, with leaf speckle
const blobs = [
  [-0.23, 0.30, 0.16], [0.0, 0.21, 0.20], [0.23, 0.30, 0.16],
  [-0.09, 0.38, 0.15], [0.11, 0.37, 0.15],
];
for (let y = 0; y < H * 0.62; y++) {
  for (let x = 0; x < W; x++) {
    let f = 0;
    for (const [bx, by, br] of blobs) {
      const d = Math.hypot((x - (cx + bx * W)) / (br * W), (y - by * H) / (br * W));
      f = Math.max(f, 1 - smooth(0.85, 1.05, d));
    }
    if (f <= 0) continue;
    const nx = (x - cx) / (0.36 * W), ny = (y - H * 0.30) / (0.26 * H);
    const lam = clamp01(0.52 + 0.55 * (-0.6 * nx - 0.75 * ny));
    let col = mix([22, 78, 60], [138, 216, 96], lam);
    col = mix(col, [186, 238, 140], Math.max(0, lam - 0.72) * 2.2); // hot rim toward the light
    if (rng() < 0.10) col = mix(col, [18, 56, 44], 0.6); // leaf shadow speckle
    over(x, y, [col[0], col[1], col[2], Math.round(255 * clamp01(f * 3))]);
  }
}
