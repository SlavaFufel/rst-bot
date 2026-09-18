import Jimp from 'jimp';
import { MARKER } from './markers.js';

// Render a tactical map: the server's map JPEG with live markers, teammates,
// oil rigs, recent death spots and the owner's labelled pins drawn on top.
// World coords (0..mapSize) map into the playable area (inset by oceanMargin px
// on each side); the Y axis is flipped.

const COLORS = {
  [MARKER.CARGO]: [0, 140, 255], // cargo — blue
  [MARKER.HELI]: [170, 70, 255], // patrol heli — violet (distinct from the red death X)
  [MARKER.CH47]: [255, 150, 0], // chinook — orange
  [MARKER.CRATE]: [255, 255, 255], // locked crate — white
  [MARKER.EXPLOSION]: [255, 0, 0], // explosion — red
  [MARKER.VENDING]: [40, 220, 90], // shop — green
  [MARKER.VENDOR]: [255, 230, 0], // travelling vendor — yellow
  [MARKER.PLAYER]: [0, 220, 220], // player — cyan
};
const TEAM_COLOR = [0, 220, 255]; // teammates — cyan (distinct from the green shop squares)
const OIL_COLOR = [255, 140, 0]; // oil-rig monuments — orange
const DEATH_COLOR = [235, 30, 30]; // recent deaths / dead teammates — red
const PIN_COLOR = [255, 80, 200]; // user pins — magenta
const MAPNOTE_COLOR = [255, 200, 30]; // in-game map notes placed in Rust — amber ring

// Jimp's bundled bitmap font, loaded once (64px so labels survive the downscale).
let fontPromise = null;
function loadFont() {
  if (!fontPromise) fontPromise = Jimp.loadFont(Jimp.FONT_SANS_64_WHITE).catch(() => null);
  return fontPromise;
}

function project(x, y, mapSize, size, margin) {
  const playable = size - 2 * margin;
  return [
    Math.round(margin + (x / mapSize) * playable),
    Math.round(margin + ((mapSize - y) / mapSize) * playable), // Y flipped
  ];
}

function dot(image, cx, cy, r, rgb) {
  const color = Jimp.rgbaToInt(rgb[0], rgb[1], rgb[2], 255);
  const ring = Jimp.rgbaToInt(0, 0, 0, 255);
  const { width, height } = image.bitmap;
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      image.setPixelColor(d2 > (r - 2) * (r - 2) ? ring : color, px, py); // dark outline
    }
  }
}

// Filled square with a dark outline. Shops read as a distinct shape from the
// round teammate dots even though both are green.
function square(image, cx, cy, r, rgb) {
  const color = Jimp.rgbaToInt(rgb[0], rgb[1], rgb[2], 255);
  const ring = Jimp.rgbaToInt(0, 0, 0, 255);
  const { width, height } = image.bitmap;
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const edge = Math.abs(dx) >= r - 1 || Math.abs(dy) >= r - 1;
      image.setPixelColor(edge ? ring : color, px, py);
    }
  }
}

// Thick "X" — death spots read differently from the round dots.
function cross(image, cx, cy, r, rgb) {
  const color = Jimp.rgbaToInt(rgb[0], rgb[1], rgb[2], 255);
  const { width, height } = image.bitmap;
  for (let d = -r; d <= r; d += 1) {
    for (let t = -2; t <= 2; t += 1) {
      for (const [px, py] of [[cx + d, cy + d + t], [cx + d, cy - d + t]]) {
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        image.setPixelColor(color, px, py);
      }
    }
  }
}

// Hollow ring with a dark rim — in-game map notes read distinctly from filled dots.
function ring(image, cx, cy, r, rgb) {
  const color = Jimp.rgbaToInt(rgb[0], rgb[1], rgb[2], 255);
  const dark = Jimp.rgbaToInt(0, 0, 0, 255);
  const { width, height } = image.bitmap;
  const outer = r * r;
  const inner = (r - 3) * (r - 3);
  const rim = (r - 1) * (r - 1);
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      const d2 = dx * dx + dy * dy;
      if (d2 > outer || d2 < inner) continue;
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      image.setPixelColor(d2 > rim ? dark : color, px, py);
    }
  }
}

function fillRect(image, x, y, w, h, int) {
  const { width, height } = image.bitmap;
  for (let dy = 0; dy < h; dy += 1) {
    for (let dx = 0; dx < w; dx += 1) {
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      image.setPixelColor(int, px, py);
    }
  }
}

// Dark "chip" behind white text so labels stay legible over any terrain.
function chip(image, font, x, y, text) {
  const w = Jimp.measureText(font, text);
  const h = Jimp.measureTextHeight(font, text, w + 8);
  fillRect(image, x - 6, y - 4, w + 16, h + 8, Jimp.rgbaToInt(15, 15, 20, 235));
  image.print(font, x, y, text);
}

async function drawLegend(image, items) {
  const font = await loadFont();
  if (!font) return;
  const lh = 70;
  const sw = 44;
  const padX = 18;
  const padY = 16;
  const boxW = 430;
  const boxH = padY * 2 + items.length * lh;
  fillRect(image, 10, 10, boxW, boxH, Jimp.rgbaToInt(12, 12, 16, 235));
  let y = 10 + padY;
  for (const [rgb, label] of items) {
    fillRect(image, 10 + padX, y + 8, sw, sw, Jimp.rgbaToInt(rgb[0], rgb[1], rgb[2], 255));
    image.print(font, 10 + padX + sw + 14, y, label);
    y += lh;
  }
}

// markers: getMapMarkers(); teammates: getTeamInfo().members; mapSize: getInfo.
// extras: { monuments, deaths:[{x,y}], pins:[{x,y,label}] }. Pin labels are short
// numbers (the bundled font is Latin-only) — the caller spells them out in the
// Telegram caption, which renders Cyrillic natively.
export async function renderMapImage(map, markers, teammates, mapSize, extras = {}) {
  const { monuments = [], deaths = [], pins = [], mapNotes = [] } = extras;
  const image = await Jimp.read(Buffer.from(map.jpgImage));
  const size = map.width;
  const margin = map.oceanMargin ?? 0;
  const r = Math.max(7, Math.round(size / 170));

  // Oil rigs (static monuments) under the live markers.
  for (const mon of monuments) {
    if (!/oil/i.test(mon.token || '')) continue;
    const [px, py] = project(mon.x, mon.y, mapSize, size, margin);
    dot(image, px, py, r, OIL_COLOR);
  }

  for (const m of markers ?? []) {
    const rgb = COLORS[m.type];
    if (!rgb) continue;
    const [px, py] = project(m.x, m.y, mapSize, size, margin);
    if (m.type === MARKER.VENDING) square(image, px, py, r, rgb);
    else dot(image, px, py, r, rgb);
  }

  for (const d of deaths) {
    if (d.x == null) continue;
    const [px, py] = project(d.x, d.y, mapSize, size, margin);
    cross(image, px, py, r, DEATH_COLOR);
  }

  for (const member of teammates ?? []) {
    if (member.x == null) continue;
    const [px, py] = project(member.x, member.y, mapSize, size, margin);
    dot(image, px, py, r, member.isAlive === false ? DEATH_COLOR : TEAM_COLOR);
  }

  // In-game map notes the player/team placed in Rust (drawn as amber rings).
  for (const n of mapNotes) {
    if (n.x == null) continue;
    const [px, py] = project(n.x, n.y, mapSize, size, margin);
    ring(image, px, py, r + 1, MAPNOTE_COLOR);
  }

  // User pins with short numeric labels (capped to keep the image readable).
  const font = await loadFont();
  for (const p of pins.slice(0, 20)) {
    if (p.x == null) continue;
    const [px, py] = project(p.x, p.y, mapSize, size, margin);
    dot(image, px, py, r, PIN_COLOR);
    if (font && p.label) chip(image, font, px + r + 8, py - 28, String(p.label).slice(0, 4));
  }

  await drawLegend(image, [
    [TEAM_COLOR, 'Team'],
    [COLORS[MARKER.VENDING], 'Shop'],
    [COLORS[MARKER.CARGO], 'Cargo'],
    [OIL_COLOR, 'Oil rig'],
    [COLORS[MARKER.HELI], 'Heli'],
    [DEATH_COLOR, 'Death'],
    [PIN_COLOR, 'Pin'],
    [MAPNOTE_COLOR, 'Map note'],
  ]);

  // Downscale for Telegram (3000px+ is heavy); keep it crisp but lighter.
  if (size > 1600) image.resize(1600, Jimp.AUTO);
  return image.getBufferAsync(Jimp.MIME_PNG);
}
