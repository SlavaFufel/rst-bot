import { readFileSync } from 'node:fs';

// Raid data scraped from rustexplore.com (the most complete calculator). See
// scripts/import-rustexplore-raid.mjs to refresh after a Rust update.
//   structures: { slug: { name, methods: [{ key, name, count, resources:[{ru,amt}] }] } }
// Each method's `resources` is the FULL raw-material cost (сера/металл/уголь/
// HQM/жир/ткань/трубы/пропан/…) already rolled up by rustexplore — i.e. exactly
// what you farm. Counts/resources here are for ×1 of the structure.
const DATA = JSON.parse(readFileSync(new URL('./rustexplore-raid.json', import.meta.url), 'utf8'));
const STRUCTURES = DATA.structures;

// Re-derive the display category from the method's item slug (tunable here
// without re-scraping). fire → огонь, boom → взрывчатка, gun, tool.
function classify(key) {
  if (/(?:^|-)(?:fire|molotov|flamethrower|incendiary)(?:-|$)/.test(key)) return 'fire';
  if (/^(?:rifle|pistol|smg|lmg|hmlmg)-|^(?:ak|bolt|mp5|thompson|spas|m249|m39|l96|semiauto)/.test(key)) return 'gun';
  if (/rocket|explosive|grenade|satchel|beancan|torpedo|survey|catapult|charge|c4|dynamite/.test(key)) return 'boom';
  return 'tool';
}

// rustexplore lists every item that can technically touch a wall. Drop the ones
// nobody raids with so the sections stay meaningful:
//   • PvP melee (knives/swords/mace/machete/club/spear-cosmetic)
//   • ~0-structural-damage items (flashbang/smoke/bee/torch/flashlight)
//   • decorative/joke (skull trophy, cake, boomerang, vampire stake, snowball)
//   • cosmetic reskins of the base pickaxe/hatchet (lumberjack/diver/concrete)
const DROP =
  /paddle|pitchfork|mace|baseballbat|machete|knife|longsword|sword|cleaver|candy|snowball|fists|club|skull|boomerang|shovel|vampire|cake|jungle|flashlight|torch|flashbang|bee|smoke|spear-cny|lumberjack|diver|concrete/;

// Walls with a weaker inner face (worth noting — raid from inside is cheaper).
const SOFTSIDE = new Set(['wall-stone', 'wall-metal', 'wall-toptier']);

// Short / RU aliases → rustexplore structure slug. Anything not here still
// resolves via exact slug or RU name substring (e.g. "стена из камня").
const ALIASES = {
  // walls (adjective+noun forms resolve here before the RU-name fallback, which
  // would otherwise match "Высокая внешняя каменная стена" for "каменная стена")
  стена: 'wall-stone', камень: 'wall-stone', каменнаястена: 'wall-stone', sw: 'wall-stone', stone: 'wall-stone',
  деревянная: 'wall-wood', деревяннаястена: 'wall-wood', ww: 'wall-wood', wood: 'wall-wood',
  метал: 'wall-metal', металлическаястена: 'wall-metal', металлстена: 'wall-metal', mw: 'wall-metal', metal: 'wall-metal',
  броня: 'wall-toptier', бронестена: 'wall-toptier', бронированнаястена: 'wall-toptier', мвк: 'wall-toptier', aw: 'wall-toptier', armored: 'wall-toptier',
  ветка: 'wall-twigs', стенаизветок: 'wall-twigs', твигс: 'wall-twigs',
  низкаястена: 'low-wall-stone', полстены: 'half-wall-stone',
  рама: 'wall-frame-stone', фрейм: 'wall-frame-stone',
  // doors
  дверь: 'door-hinged-metal', md: 'door-hinged-metal', дверка: 'door-hinged-metal',
  деревяннаядверь: 'door-hinged-wood',
  бронедверь: 'door-hinged-toptier', ad: 'door-hinged-toptier', броньдверь: 'door-hinged-toptier',
  двойнаядверь: 'door-double-hinged-metal', гаражка: 'wall-frame-garagedoor', гараж: 'wall-frame-garagedoor', garage: 'wall-frame-garagedoor', gd: 'wall-frame-garagedoor',
  заводская: 'factorydoor', фактори: 'factorydoor',
  // openings / frames
  люк: 'floor-ladder-hatch', hatch: 'floor-ladder-hatch',
  окно: 'window-metal', решётка: 'window-metal', решетка: 'window-metal',
  витрина: 'wall-frame-shopfront-metal', shopfront: 'wall-frame-shopfront-metal',
  бойница: 'shutter-metal-embrasure-a', амбразура: 'shutter-metal-embrasure-a', embrasure: 'shutter-metal-embrasure-a',
  // base parts
  фундамент: 'foundation-stone', foundation: 'foundation-stone',
  пол: 'floor-stone', потолок: 'floor-stone', floor: 'floor-stone',
  рампа: 'a-ramp-stone', лестница: 'stairs-spiral-stone', ступени: 'steps-stone',
  // deployables / outside
  тс: 'cupboard-tool', tc: 'cupboard-tool', шкаф: 'cupboard-tool', cupboard: 'cupboard-tool', сейф: 'cupboard-tool',
  турель: 'autoturret', turret: 'autoturret',
  забор: 'wall-external-high-stone', стенка: 'wall-external-high-stone',
  деревянныйзабор: 'wall-external-high', ворота: 'gates-external-high-stone', калитка: 'gates-external-high-stone',
  автомат: 'vending-machine', вендинг: 'vending-machine', vending: 'vending-machine',
};

// Curated common structures shown in /raid help (slug → typing alias).
const COMMON = [
  ['wall-stone', 'стена'],
  ['wall-metal', 'метал'],
  ['wall-toptier', 'броня'],
  ['door-hinged-metal', 'дверь'],
  ['door-hinged-toptier', 'бронедверь'],
  ['wall-frame-garagedoor', 'гаражка'],
  ['floor-ladder-hatch', 'люк'],
  ['cupboard-tool', 'тс'],
  ['autoturret', 'турель'],
  ['wall-external-high-stone', 'забор'],
  ['window-metal', 'окно'],
  ['vending-machine', 'вендинг'],
];

const norm = (t) => String(t).toLowerCase().trim().replace(/[_\s]+/g, '-');

export function lookupStructure(token) {
  const t = String(token).toLowerCase().trim();
  if (!t) return null;
  const dash = norm(t);
  const squished = t.replace(/[\s_-]+/g, '');
  if (STRUCTURES[dash]) return dash;
  if (STRUCTURES[t]) return t;
  if (ALIASES[squished]) return ALIASES[squished];
  if (ALIASES[dash]) return ALIASES[dash];
  // exact RU name, then substring (e.g. "стена из камня", "гаражная")
  for (const [k, s] of Object.entries(STRUCTURES)) if (s.name.toLowerCase() === t) return k;
  for (const [k, s] of Object.entries(STRUCTURES)) if (s.name.toLowerCase().includes(t)) return k;
  return null;
}

export function raidCost(token, qty = 1) {
  const key = lookupStructure(token);
  if (!key) return null;
  const s = STRUCTURES[key];
  const n = Math.max(1, Math.floor(qty) || 1);

  const methods = [];
  for (const w of s.methods) {
    if (DROP.test(w.key)) continue;
    const cat = classify(w.key);
    const raw = (w.resources || []).map((r) => ({ ru: r.ru, amt: r.amt * n }));
    const sulfur = raw.find((r) => r.ru === 'сера')?.amt ?? 0;
    methods.push({
      key: w.key,
      name: w.name,
      cat,
      count: w.count * n,
      raw,
      // cheapest-first ordering within a section; no-sulfur methods sort last.
      sortSulfur: sulfur > 0 ? sulfur : Number.MAX_SAFE_INTEGER,
    });
  }

  return { key, label: s.name, softside: SOFTSIDE.has(key), tip: null, qty: n, methods };
}

export function structureList() {
  return COMMON.filter(([k]) => STRUCTURES[k]).map(([k, alias]) => ({ label: STRUCTURES[k].name, alias }));
}

export function structureCount() {
  return Object.keys(STRUCTURES).length;
}
