// RustLabs-style lookups for the in-game !craft / !recycle / !decay / !durability
// commands (and their Telegram twins). Reads the compact datasets built by
// scripts/import-rustlabs.mjs. Everything is keyed by the SAME Rust item ids as
// src/util/items.js, so we resolve a typed token (RU slang or EN) → id → data.
//
// Building blocks (walls/floors/roofs/…) aren't items, so they live under
// `blocks` keyed by the canonical English name ("Armored Wall"). We resolve a
// free-typed RU/EN phrase to that name with a tier+part word-subset matcher.
import { readFileSync } from 'node:fs';
import { resolveItemId, itemName, itemNameRu } from './items.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
const CRAFT = load('rustlabs-craft.json'); // { id: { i:[[ingId,qty]], wb, t } }
const RECYCLE = load('rustlabs-recycle.json'); // { id: { r:[[id,qty,prob]], z:[...] } }
const DECAY = load('rustlabs-decay.json'); // { items:{id:[hp,sec]}, blocks:{name:[hp,sec]}, other:{name:[hp,out,in,uw]} }
const DURABILITY = load('rustlabs-durability.json'); // { items:{id:[[tool,q,t,fuel,sulfur]]}, blocks:{...} }

const WB_NAME = ['—', 'ВМ1', 'ВМ2', 'ВМ3']; // workbench tier label (0 = none)

// ---- formatting helpers ----------------------------------------------------
export function num(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Seconds → compact RU/EN duration ("2 ч 6 мин", "3 мин 32 сек", "45 сек").
export function fmtDuration(sec, lang = 'ru') {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const u = lang === 'en' ? ['d', 'h', 'm', 's'] : ['д', 'ч', 'мин', 'сек'];
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const parts = [];
  if (d) parts.push(`${d} ${u[0]}`);
  if (h) parts.push(`${h} ${u[1]}`);
  if (m) parts.push(`${m} ${u[2]}`);
  // Show seconds only for sub-hour durations (keeps "2 ч 6 мин" tidy).
  if (ss && !d && !h) parts.push(`${ss} ${u[3]}`);
  return parts.join(' ') || `0 ${u[3]}`;
}

// ---- building-block resolver (tier + part → "Armored Wall") ----------------
// Synonym → canonical word present in block names (lowercased). RU + EN slang.
const TIER_WORDS = {
  armored: 'armored', armoured: 'armored', броня: 'armored', бронь: 'armored', бронированная: 'armored',
  бронированный: 'armored', бронир: 'armored', брон: 'armored', мвк: 'armored', hqm: 'armored', хкм: 'armored',
  metal: 'metal', sheet: 'metal', sheetmetal: 'metal', металл: 'metal', метал: 'metal',
  металлическая: 'metal', металлический: 'metal',
  stone: 'stone', камень: 'stone', каменная: 'stone', каменный: 'stone', камен: 'stone', кам: 'stone',
  twig: 'twig', twigs: 'twig', ветка: 'twig', ветки: 'twig', прутья: 'twig', твигс: 'twig',
  wood: 'wooden', wooden: 'wooden', дерево: 'wooden', деревянная: 'wooden', деревянный: 'wooden', дерев: 'wooden',
};
const PART_WORDS = {
  wall: 'wall', стена: 'wall', стен: 'wall', стенка: 'wall',
  doorway: 'doorway', проем: 'doorway', проём: 'doorway', дверной: 'doorway',
  floor: 'floor', пол: 'floor', потолок: 'floor',
  foundation: 'foundation', фундамент: 'foundation', фунд: 'foundation',
  roof: 'roof', крыша: 'roof', кровля: 'roof',
  ramp: 'ramp', рампа: 'ramp', пандус: 'ramp',
  stairs: 'stairs', лестница: 'stairs', лестницы: 'stairs', лесенка: 'stairs',
  steps: 'steps', ступени: 'steps', ступеньки: 'steps',
  window: 'window', окно: 'window', окошко: 'window',
  frame: 'frame', рама: 'frame', фрейм: 'frame', каркас: 'frame',
  triangle: 'triangle', треугольная: 'triangle', треугольный: 'triangle', треугольник: 'triangle', три: 'triangle',
  half: 'half', половина: 'half', полустена: 'half', полу: 'half',
  low: 'low', низкая: 'low', низкий: 'low',
  spiral: 'spiral', спираль: 'spiral', спиральная: 'spiral', винтовая: 'spiral',
  l: 'l', u: 'u', shape: 'shape', shaped: 'shaped',
};

// Decay and durability don't list exactly the same blocks, so resolve against
// each dataset's own names — never a shared union (that let decay resolve to a
// durability-only name like "Stone Stairs Spiral" and then return null).
const DECAY_BLOCK_NAMES = Object.keys(DECAY.blocks).sort();
const DUR_BLOCK_NAMES = Object.keys(DURABILITY.blocks).sort();
const ALL_BLOCK_NAMES = [...new Set([...DECAY_BLOCK_NAMES, ...DUR_BLOCK_NAMES])].sort();
const BLOCK_WORDS = new Map(ALL_BLOCK_NAMES.map((n) => [n, new Set(n.toLowerCase().split(/\s+/))]));

// Tie-break for ambiguous bare-part queries (same extra-word count). The "part
// signature" is the block name minus its tier word; lower index = preferred, so
// "frame" → Wall Frame (not Floor Frame), "triangle" → Triangle Foundation,
// "stairs" → Stairs Spiral.
const TIER_SET = new Set(['armored', 'metal', 'stone', 'twig', 'wooden']);
const partSig = (name) => name.split(/\s+/).filter((w) => !TIER_SET.has(w.toLowerCase())).join(' ');
const PART_PREF = [
  'Wall', 'Wall Frame', 'Foundation', 'Triangle Foundation', 'Doorway', 'Window',
  'Floor', 'Floor Frame', 'Floor Triangle', 'Floor Triangle Frame', 'Roof', 'Roof Triangle',
  'Ramp', 'Steps', 'Stairs Spiral', 'Stairs Spiral Triangle', 'Stairs L Shape', 'U Shaped Stairs',
  'Half Wall', 'Low Wall',
];
const prefRank = (name) => {
  const idx = PART_PREF.indexOf(partSig(name));
  return idx < 0 ? 999 : idx;
};

// Resolve a free phrase to a canonical block name within `names`. Requires at
// least one tier AND one part word so tier-only ("armored") stays ambiguous → null.
export function resolveBlockName(token, names = ALL_BLOCK_NAMES) {
  const words = String(token).toLowerCase().split(/[\s_-]+/).filter(Boolean);
  const want = new Set();
  let hasTier = false;
  let hasPart = false;
  for (const w of words) {
    if (TIER_WORDS[w]) { want.add(TIER_WORDS[w]); hasTier = true; }
    else if (PART_WORDS[w]) { want.add(PART_WORDS[w]); hasPart = true; }
  }
  if (!hasTier || !hasPart) return null;
  let best = null;
  let bestExtra = Infinity;
  let bestPref = Infinity;
  for (const name of names) {
    const set = BLOCK_WORDS.get(name);
    if (!set) continue;
    let ok = true;
    for (const w of want) if (!set.has(w)) { ok = false; break; }
    if (!ok) continue;
    const extra = set.size - want.size;
    const pref = prefRank(name);
    if (extra < bestExtra || (extra === bestExtra && pref < bestPref)) {
      best = name;
      bestExtra = extra;
      bestPref = pref;
    }
  }
  return best;
}

const itemRef = (id) => ({ id: String(id), name: itemName(id), nameRu: itemNameRu(id) });

// resolveItemId('') substring-matches the first item — guard blank tokens so an
// empty/whitespace query never silently resolves to a random item.
const resolveItemSafe = (token) => (String(token ?? '').trim() ? resolveItemId(token) : null);

// ---- public lookups --------------------------------------------------------

// Crafting cost + time for `qty` of an item.
export function craftInfo(token, qty = 1) {
  const id = resolveItemSafe(token);
  const r = id != null ? CRAFT[String(id)] : null;
  if (!r) return null;
  const n = Math.max(1, Math.floor(qty) || 1);
  return {
    ...itemRef(id),
    qty: n,
    wb: r.wb,
    wbLabel: WB_NAME[r.wb] ?? '—',
    timeSec: r.t * n,
    ingredients: r.i.map(([ing, q]) => ({ ...itemRef(ing), qty: q * n })),
  };
}

// Recycler output for `qty` of an item. safe=true → safe-zone recycler.
export function recycleInfo(token, qty = 1, safe = false) {
  const id = resolveItemSafe(token);
  const r = id != null ? RECYCLE[String(id)] : null;
  if (!r) return null;
  const n = Math.max(1, Math.floor(qty) || 1);
  const list = safe && r.z?.length ? r.z : r.r;
  return {
    ...itemRef(id),
    qty: n,
    safe: safe && r.z?.length > 0,
    hasSafe: r.z?.length > 0,
    yields: list.map(([y, q, p]) => ({ ...itemRef(y), qty: q * n, prob: p })),
  };
}

// Decay time. Resolves block (tier+part) first, then item id, then vehicle.
// hp = current HP (optional) → scaled time; otherwise full decay from max HP.
export function decayInfo(token, hp = null) {
  const block = resolveBlockName(token, DECAY_BLOCK_NAMES);
  if (block && DECAY.blocks[block]) {
    const [maxHp, sec] = DECAY.blocks[block];
    return mkDecay(block, null, 'block', maxHp, sec, hp);
  }
  const id = resolveItemSafe(token);
  if (id != null && DECAY.items[String(id)]) {
    const [maxHp, sec] = DECAY.items[String(id)];
    return mkDecay(itemName(id), itemNameRu(id), 'item', maxHp, sec, hp);
  }
  const v = matchOther(token);
  if (v) {
    const [maxHp, out, inside, uw] = DECAY.other[v];
    const r = mkDecay(v, null, 'vehicle', maxHp, out, hp);
    return { ...r, insideSec: inside, underwaterSec: uw };
  }
  return null;
}
function mkDecay(name, nameRu, kind, maxHp, fullSec, hp) {
  const cur = hp != null && Number.isFinite(hp) ? Math.max(0, Math.min(hp, maxHp)) : null;
  return {
    name, nameRu, kind, maxHp, fullSec,
    hp: cur,
    atSec: cur != null && maxHp > 0 ? (cur / maxHp) * fullSec : fullSec,
  };
}
// RU/EN aliases → canonical DECAY.other key. Keys are ё-normalized (ё→е) so
// "вертолет" and "вертолёт" both hit. Explicit map first so common short tokens
// ("heli", "sub") don't fall to the insertion-order-dependent substring loop
// (which would pick the NPC "Attack Helicopter" / "Duo Submarine").
const OTHER_ALIASES = {
  миник: 'Minicopter', миникоптер: 'Minicopter', мини: 'Minicopter',
  вертолет: 'Scrap Transport Helicopter', хели: 'Scrap Transport Helicopter',
  скраптранспорт: 'Scrap Transport Helicopter', heli: 'Scrap Transport Helicopter', helicopter: 'Scrap Transport Helicopter',
  патхели: 'Attack Helicopter', патрульный: 'Attack Helicopter', patrol: 'Attack Helicopter',
  лодка: 'Motor Rowboat', рыбацкая: 'Motor Rowboat', риб: 'RHIB', rhib: 'RHIB',
  сабмарина: 'Solo Submarine', подлодка: 'Solo Submarine', sub: 'Solo Submarine', submarine: 'Solo Submarine',
  тагбот: 'Tugboat', тагбоат: 'Tugboat', tug: 'Tugboat',
  шар: 'Hot Air Balloon', воздушныйшар: 'Hot Air Balloon', balloon: 'Hot Air Balloon',
  мотик: 'Motorbike', мотоцикл: 'Motorbike', байк: 'Bike', bike: 'Bike',
  трайк: 'Trike', снегоход: 'Snowmobile', снежик: 'Snowmobile',
};
function matchOther(token) {
  const t = String(token).toLowerCase().trim().replace(/ё/g, 'е');
  if (!t) return null;
  if (OTHER_ALIASES[t]) return OTHER_ALIASES[t];
  for (const k of Object.keys(DECAY.other)) if (k.toLowerCase() === t) return k;
  for (const k of Object.keys(DECAY.other)) if (k.toLowerCase().includes(t)) return k;
  return null;
}

// Top raid methods (explosives/throwables, sorted by sulfur). Block first, then item.
export function durabilityInfo(token) {
  const block = resolveBlockName(token, DUR_BLOCK_NAMES);
  if (block && DURABILITY.blocks[block]) return mkDur(block, null, 'block', DURABILITY.blocks[block]);
  const id = resolveItemSafe(token);
  if (id != null && DURABILITY.items[String(id)]) return mkDur(itemName(id), itemNameRu(id), 'item', DURABILITY.items[String(id)]);
  return null;
}
// Explosive rifle/pistol ammo is the cheapest by sulfur but impractical as a
// raid headline (250 rounds + a gun + long exposure) — RustLabs-style tools omit
// it from the "top cost-effective" list, so we do too.
const AMMO_RE = /explosive.*ammo|разрывн/i;
function mkDur(name, nameRu, kind, methods) {
  return {
    name, nameRu, kind,
    methods: methods
      .map(([tool, q, t, fuel, sulfur]) => ({ ...itemRef(tool), qty: q, timeSec: t, fuel, sulfur }))
      .filter((m) => !AMMO_RE.test(m.name) && !AMMO_RE.test(m.nameRu)),
  };
}
