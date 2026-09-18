// Converts in-game world coordinates to a Rust map grid cell (e.g. "D7").
// NOTE: CELL_SIZE needs calibration against a real map (see plan, open question #5).
const CELL_SIZE = 146.28571428571428;

function columnToLetters(column) {
  let result = '';
  let n = column;
  do {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return result;
}

export function gridFromXY(x, y, mapSize, cell = CELL_SIZE) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !mapSize) return null;
  // Markers outside the playable square (ocean) have no grid cell.
  if (x < 0 || y < 0 || x > mapSize || y > mapSize) return null;

  const column = Math.floor(x / cell);
  const totalRows = Math.ceil(mapSize / cell);
  const row = totalRows - Math.floor(y / cell) - 1;
  return `${columnToLetters(column)}${row}`;
}

// Like gridFromXY, but clamps out-of-bounds coords into the playable square first,
// so an ocean/edge marker (cargo ship, patrol heli, chinook — they spawn outside
// the lettered grid) maps to the NEAREST edge cell instead of null.
export function nearestGrid(x, y, mapSize, cell = CELL_SIZE) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !mapSize) return null;
  const cx = Math.min(Math.max(x, 0), mapSize - 1);
  const cy = Math.min(Math.max(y, 0), mapSize - 1);
  return gridFromXY(cx, cy, mapSize, cell);
}

function lettersToColumn(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0) - 64; // 'A' -> 1
    if (code < 1 || code > 26) return null;
    n = n * 26 + code;
  }
  return n - 1;
}

// Reverse of gridFromXY: returns the world-coord centre of a grid cell (e.g. "D7").
export function gridCenterXY(cell, mapSize, size = CELL_SIZE) {
  const match = /^([A-Za-z]+)\s*(\d+)$/.exec(String(cell).trim());
  if (!match || !mapSize) return null;
  const column = lettersToColumn(match[1]);
  const row = Number(match[2]);
  if (column == null) return null;
  const totalRows = Math.ceil(mapSize / size);
  if (row < 0 || row >= totalRows) return null;
  const x = column * size + size / 2;
  const y = (totalRows - row - 1) * size + size / 2;
  return { x: Math.round(x), y: Math.round(y) };
}
