// Build compact RustLabs datasets (craft / recycle / decay / durability) for the
// bot's in-game !craft / !recycle / !decay / !durability commands.
//
// Source: the RustLabs game-stat data mirrored by the rustplusplus project
// (github.com/alexemanuelol/rustplusplus, src/staticFiles/*). Those numbers are
// factual game data (how much sulfur breaks a wall, what a recycler yields). We
// fetch them, keep only what we need, relabel to our own compact schema, and key
// everything by the SAME Rust item ids our src/util/items.js already uses.
//
// Run:  node scripts/import-rustlabs.mjs
// Re-run after a Rust update to refresh src/util/rustlabs-*.json.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CACHE = join(ROOT, '.rl-cache');
const OUT = join(ROOT, 'src', 'util');
const BASE = 'https://raw.githubusercontent.com/alexemanuelol/rustplusplus/master/src/staticFiles';

const SOURCES = [
  'rustlabsCraftData',
  'rustlabsRecycleData',
  'rustlabsDecayData',
  'rustlabsDurabilityData',
];

// Workbench item id -> tier number (0 = none).
const WORKBENCH = { '1524187186': 1, '-41896755': 2, '-1607980696': 3 };

// Durability method groups worth showing for raiding. We keep only practical
// raid tools — explosives and throwables — and drop guns, torpedoes and melee so
// the "top cost-effective" ranking matches what RustLabs surfaces (C4, rockets,
// satchels, grenades) instead of meme stats like "raid with 250 rifle bullets".
const RAID_GROUPS = new Set(['explosive', 'throw', 'fire', 'incendiary']);

function cache(name) {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${name}.json`);
  if (!existsSync(file)) {
    console.log(`fetch ${name}…`);
    execFileSync('curl', ['-sL', '--max-time', '180', '-o', file, `${BASE}/${name}.json`], { stdio: 'ignore' });
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

const num = (v) => (v == null ? null : Number(v));

// ---- craft: { [id]: { i:[[ingId,qty]], wb:0..3, t:sec } } -------------------
function buildCraft(src) {
  const out = {};
  for (const [id, r] of Object.entries(src)) {
    if (!r?.ingredients?.length) continue;
    out[id] = {
      i: r.ingredients.map((x) => [String(x.id), Number(x.quantity)]),
      wb: WORKBENCH[String(r.workbench)] ?? 0,
      t: num(r.time) ?? 0,
    };
  }
  return out;
}

// ---- recycle: { [id]: { r:[[id,qty,prob]], z:[[id,qty,prob]] } } ------------
// r = standard (radtown) recycler, z = safe-zone recycler.
function buildRecycle(src) {
  const out = {};
  const conv = (y) => (y ?? []).map((x) => [String(x.id), Number(x.quantity), Number(x.probability ?? 1)]);
  for (const [id, r] of Object.entries(src)) {
    const rec = conv(r?.recycler?.yield);
    if (!rec.length) continue;
    out[id] = { r: rec, z: conv(r?.['safe-zone-recycler']?.yield) };
  }
  return out;
}

// ---- decay: { items:{[id]:[hp,sec]}, blocks:{[name]:[hp,sec]},
//               other:{[name]:[hp,outSec,inSec,uwSec]} } ----------------------
function buildDecay(src) {
  const itemSec = (e) => num(e.decay) ?? num(e.decayOutside);
  const items = {};
  for (const [id, e] of Object.entries(src.items ?? {})) {
    const s = itemSec(e);
    if (s == null) continue;
    items[id] = [num(e.hp) ?? 0, s];
  }
  const blocks = {};
  for (const [name, e] of Object.entries(src.buildingBlocks ?? {})) {
    const s = itemSec(e);
    if (s == null) continue;
    blocks[name] = [num(e.hp) ?? 0, s];
  }
  const other = {};
  for (const [name, e] of Object.entries(src.other ?? {})) {
    other[name] = [num(e.hp) ?? 0, num(e.decayOutside), num(e.decayInside), num(e.decayUnderwater)];
  }
  return { items, blocks, other };
}

// ---- durability: { items:{[id]:[[tool,q,t,fuel,sulfur]]}, blocks:{...} } -----
// Keep only raid-relevant methods, dedup by tool (best/cheapest variant), sort by
// sulfur, cap per structure. Items are kept only if they have a sulfur explosive
// method (i.e. they're a real raidable structure, not a stackable item).
function compactMethods(list) {
  const byTool = new Map();
  for (const m of list ?? []) {
    if (m.caption && /refill/i.test(m.caption)) continue;
    if (!RAID_GROUPS.has(m.group)) continue; // explosives & throwables only
    const sulfur = num(m.sulfur);
    const fuel = num(m.fuel);
    const tool = String(m.toolId);
    const tuple = [tool, Number(m.quantity) || 0, num(m.time) ?? 0, fuel ?? 0, sulfur ?? 0];
    const prev = byTool.get(tool);
    // Prefer the lower-sulfur (then lower-time) variant of the same tool.
    if (!prev || better(tuple, prev)) byTool.set(tool, tuple);
  }
  const rank = (t) => (t[4] > 0 ? t[4] : Number.MAX_SAFE_INTEGER); // sulfur asc, sulfur-less last
  return [...byTool.values()].sort((a, b) => rank(a) - rank(b) || a[2] - b[2]).slice(0, 8);
}
function better(a, b) {
  const sa = a[4] > 0 ? a[4] : Number.MAX_SAFE_INTEGER;
  const sb = b[4] > 0 ? b[4] : Number.MAX_SAFE_INTEGER;
  return sa < sb || (sa === sb && a[2] < b[2]);
}
function hasSulfurExplosive(list) {
  return (list ?? []).some((m) => m.group === 'explosive' && num(m.sulfur) > 0);
}
function buildDurability(src) {
  const items = {};
  for (const [id, list] of Object.entries(src.items ?? {})) {
    if (!hasSulfurExplosive(list)) continue; // skip non-structures
    const ms = compactMethods(list);
    if (ms.length) items[id] = ms;
  }
  const blocks = {};
  for (const [name, list] of Object.entries(src.buildingBlocks ?? {})) {
    const ms = compactMethods(list);
    if (ms.length) blocks[name] = ms;
  }
  return { items, blocks };
}

function write(name, data) {
  const file = join(OUT, name);
  writeFileSync(file, JSON.stringify(data));
  const kb = (readFileSync(file).length / 1024).toFixed(0);
  console.log(`wrote src/util/${name} (${kb} KB, ${Object.keys(data.items ?? data).length} top-level keys)`);
}

console.log('Loading sources…');
const craftSrc = cache('rustlabsCraftData');
const recycleSrc = cache('rustlabsRecycleData');
const decaySrc = cache('rustlabsDecayData');
const durSrc = cache('rustlabsDurabilityData');

const stamp = { generatedFrom: 'RustLabs via rustplusplus staticFiles', generatedNote: 'factual game data, recompiled' };

write('rustlabs-craft.json', buildCraft(craftSrc));
write('rustlabs-recycle.json', buildRecycle(recycleSrc));
write('rustlabs-decay.json', buildDecay(decaySrc));
write('rustlabs-durability.json', buildDurability(durSrc));
console.log('Done.', stamp.generatedFrom);
