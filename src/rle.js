// RLE codec for palette-indexed sprite grids.
//
// Format: one row per sprite row, rows joined by ";".
// Each row is comma-separated runs of "count:paletteIndex".
// Example (width 8): "8:0" = a fully transparent row;
// "2:0,4:3,2:0" = transparent, four pixels of color 3, transparent.

/** Encode a single row (array of palette indices) to RLE. */
export function encodeRow(row) {
  const runs = [];
  let i = 0;
  while (i < row.length) {
    const v = row[i];
    let count = 1;
    while (i + count < row.length && row[i + count] === v) count++;
    runs.push(`${count}:${v}`);
    i += count;
  }
  return runs.join(",");
}

/** Encode a full grid (2D array) to an RLE string. */
export function encodeGrid(grid) {
  return grid.map(encodeRow).join(";");
}

/**
 * Decode one RLE row. Throws on malformed input or wrong width.
 * @returns {number[]}
 */
export function decodeRow(rle, width) {
  const row = decodeRuns(rle);
  if (row.length !== width) {
    throw new Error(`row decodes to ${row.length} pixels, expected width ${width}`);
  }
  return row;
}

/** Decode RLE runs without a width requirement (for "block" ops). */
export function decodeRuns(rle) {
  const row = [];
  if (rle.trim() === "") throw new Error("empty row");
  for (const run of rle.split(",")) {
    const m = /^(\d+):(\d+)$/.exec(run.trim());
    if (!m) throw new Error(`malformed run "${run}", expected "count:index"`);
    const count = Number(m[1]);
    const idx = Number(m[2]);
    if (count === 0) throw new Error(`run with zero count in "${run}"`);
    for (let i = 0; i < count; i++) row.push(idx);
  }
  return row;
}

/**
 * Decode a full RLE grid string.
 * @returns {number[][]}
 */
export function decodeGrid(rle, width, height) {
  const rows = rle.split(";");
  if (rows.length !== height) {
    throw new Error(`grid has ${rows.length} rows, expected height ${height}`);
  }
  return rows.map((r) => decodeRow(r, width));
}
