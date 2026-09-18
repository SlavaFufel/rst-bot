// Rust+ AppMarker.type enum. VERIFY against the current .proto before relying on
// VENDOR (added in a later game update) — see plan, open question #1.
export const MARKER = Object.freeze({
  PLAYER: 1,
  EXPLOSION: 2,
  VENDING: 3,
  CH47: 4,
  CARGO: 5,
  CRATE: 6,
  RADIUS: 7,
  HELI: 8,
  VENDOR: 9,
});

export function indexById(markers) {
  const map = new Map();
  for (const marker of markers) map.set(marker.id, marker);
  return map;
}

export function diffMarkers(previous, current) {
  const appeared = [];
  const disappeared = [];
  for (const [id, marker] of current) {
    if (!previous.has(id)) appeared.push(marker);
  }
  for (const [id, marker] of previous) {
    if (!current.has(id)) disappeared.push(marker);
  }
  return { appeared, disappeared };
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Returns the nearest monument within `radius`, or null.
export function nearestMonument(marker, monuments, radius = 250) {
  let best = null;
  let bestDistance = radius;
  for (const monument of monuments) {
    const d = distance(marker, monument);
    if (d <= bestDistance) {
      best = monument;
      bestDistance = d;
    }
  }
  return best;
}
