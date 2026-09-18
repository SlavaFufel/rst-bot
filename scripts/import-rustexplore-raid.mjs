// Importer: scrape rustexplore.com raid tables into rustexplore-raid.json.
//
// rustexplore renders, on every structure page, a raid table:
//   Предмет (method) | Кол-во | Время | Ресурсы (raw resources, each name+amount)
// Resources are already rolled up to raw mats (сера/металл/уголь/HQM/скрап/
// ткань/жир/…) — more accurate and complete than our prostoj rollup.
//
// Targets:
//   • building blocks  → /ru/world/construction/<slug>   (list pulled live)
//   • deployables/doors → /ru/items/<cat>/<slug>          (curated below)
//
// Run:  node scripts/import-rustexplore-raid.mjs
//       SUBSET=1 node scripts/import-rustexplore-raid.mjs   (5 pages, for testing)
// Output: src/util/rustexplore-raid.json  ({ structures, generatedFrom }).
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'util', 'rustexplore-raid.json');
const CACHE = join(tmpdir(), 're-raid-cache');
const BASE = 'https://rustexplore.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36';

// Deployables/doors not under /world/construction (curated from the sitemap).
// Each is a full path under /ru/.
const DEPLOYABLES = [
  'items/construction/door-hinged-wood', 'items/construction/door-hinged-metal', 'items/construction/door-hinged-toptier',
  'items/construction/door-double-hinged-wood', 'items/construction/door-double-hinged-metal', 'items/construction/door-double-hinged-toptier',
  'items/construction/factorydoor',
  'items/construction/floor-ladder-hatch', 'items/construction/floor-triangle-ladder-hatch',
  'items/construction/cupboard-tool',
  'items/construction/wall-external-high', 'items/construction/wall-external-high-stone', 'items/construction/wall-external-high-ice',
  'items/construction/gates-external-high-wood', 'items/construction/gates-external-high-stone',
  'items/construction/wall-frame-garagedoor', 'items/construction/wall-frame-cell-gate', 'items/construction/wall-frame-fence-gate',
  'items/construction/wall-frame-shopfront', 'items/construction/wall-frame-shopfront-metal',
  'items/construction/shutter-metal-embrasure-a', 'items/construction/shutter-metal-embrasure-b',
  'items/electrical/autoturret',
  'items/items/vending-machine',
];

// Long RU resource label → short label used in the bot.
const SHORT = {
  'сера': 'сера', 'фрагменты металла': 'металл', 'уголь': 'уголь',
  'металл высокого качества': 'HQM', 'металлолом': 'скрап', 'ткань': 'ткань',
  'животный жир': 'жир', 'веревка': 'верёвка', 'верёвка': 'верёвка',
  'старые микросхемы': 'тех.мусор', 'металлическая труба': 'трубы',
  'пустой баллон для пропана': 'пропан', 'топливо низкого качества': 'нг топливо',
  'дерево': 'дерево', 'камень': 'камень', 'камни': 'камень', 'шестерни': 'шестерни',
  'шестеренки': 'шестерни', 'лезвие': 'лезвия', 'лезвия': 'лезвия',
  'металлическое лезвие': 'лезвия', 'высококачественный металл': 'HQM',
};

// rustexplore's per-structure construction pages omit the batch-craft yield for
// some ammo (they bill 1× per round), so their resources are N× too high vs the
// calculator tool. Divide back down. Validated: explosive 5.56 → 4550 серы on a
// stone wall (matches the /tools/raid-calculator), not 9100.
const BATCH_YIELD = { 'ammo-rifle-explosive': 2 };

// Method item-slug → display category.
function methodCat(slug, name) {
  const s = slug.toLowerCase();
  if (/fire|molotov|flamethrower|incendiary|arrow.*fire/.test(s)) return 'fire';
  if (/rifle-ak|rifle-bolt|^rifle|^pistol|lr300|mp5|thompson|spas|m249|semiauto/.test(s)) return 'gun';
  if (/pickaxe|hatchet|axe|icepick|jackhammer|chainsaw|hammer|^rock$|salvaged|drill|spear/.test(s)) return 'tool';
  if (/molotov|flamethrower/.test((name || '').toLowerCase())) return 'fire';
  return 'boom';
}

// rustexplore's edge (Cloudflare) 403s undici/node-fetch but allows curl, so we
// shell out to curl. Pages are cached to tmp so re-runs/parsing don't re-fetch.
async function fetchCached(path) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, path.replace(/[/]/g, '__') + '.html');
  if (existsSync(file) && readFileSync(file, 'utf8').length > 1000) return readFileSync(file, 'utf8');
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // curl itself retries transport errors; we also retry on a non-zero exit
      // (intermittent Cloudflare init failures under concurrency) and short bodies.
      execFileSync('curl', ['-sL', '--compressed', '--retry', '3', '--retry-delay', '2', '--max-time', '40', '-A', UA, '-o', file, `${BASE}/ru/${path}`], { stdio: 'ignore' });
      const html = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (html.length < 1000) throw new Error(`empty/blocked (${html.length}b)`);
      await new Promise((r) => setTimeout(r, 400)); // throttle (avoid Cloudflare rate-limit)
      return html;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw new Error(`fetch failed for ${path}: ${lastErr?.message || lastErr}`);
}

function parsePage(html, slug) {
  const u = html.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
  // Structure name: first <h1>.
  const nameRaw = (/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(u) || [])[1] || slug;
  const name = nameRaw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  // Pick the raid table: contains method item links + a "Время" header.
  const tables = [...u.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
  const table = tables.find((tx) => /\/ru\/items\/(tool|ammunition|construction)\//.test(tx) && /Время|tableBodyCell/.test(tx));
  if (!table) return null;

  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const methods = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 3) continue; // header / spacer
    const mlink = /\/ru\/items\/[a-z]+\/([a-z0-9.-]+)"/.exec(cells[0]);
    if (!mlink) continue;
    const mslug = mlink[1];
    const mname = cells[0].replace(/<img[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const count = Number((cells[1].replace(/<[^>]+>/g, '').match(/[\d.,]+/) || [])[0]?.replace(/[.,]/g, ''));
    if (!Number.isFinite(count)) continue;
    // Resources live in the last cell: each is alt="Name" … itemAmount>N<.
    const resCell = cells[cells.length - 1];
    const batch = BATCH_YIELD[mslug] || 1;
    const resources = [];
    for (const rm of resCell.matchAll(/alt="([^"]+)"[\s\S]*?itemAmount[^>]*>\s*([\d .,\s]+?)\s*</g)) {
      const ru = rm[1].trim();
      const amt = Math.round(Number(rm[2].replace(/[\s .,]/g, '')) / batch);
      if (Number.isFinite(amt) && amt > 0) resources.push({ ru: SHORT[ru.toLowerCase()] || ru, amt });
    }
    methods.push({ key: mslug, name: mname, cat: methodCat(mslug, mname), count, resources });
  }
  return methods.length ? { name, methods } : null;
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx).catch((e) => ({ __err: e.message }));
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  // Live list of building-block slugs from the construction index.
  const index = await fetchCached('world/construction');
  let blocks = [...new Set([...index.matchAll(/\/ru\/world\/construction\/([a-z0-9-]+)/g)].map((m) => m[1]))];
  let targets = [
    ...blocks.map((s) => ({ key: s, path: `world/construction/${s}` })),
    ...DEPLOYABLES.map((p) => ({ key: p.split('/').pop(), path: p })),
  ];
  if (process.env.SUBSET) targets = targets.slice(0, 5).concat(targets.filter((t) => /door-hinged-metal|cupboard-tool/.test(t.key)));

  console.log(`Fetching ${targets.length} structure pages (cache: ${CACHE})…`);
  const structures = {};
  let ok = 0;
  const failed = [];
  await pool(targets, 4, async (t) => {
    try {
      const html = await fetchCached(t.path);
      const parsed = parsePage(html, t.key);
      if (parsed) { structures[t.key] = parsed; ok += 1; }
      else failed.push(t.key + ' (no table)');
    } catch (e) { failed.push(`${t.key} (${e.message})`); }
  });

  writeFileSync(OUT, JSON.stringify({ generatedFrom: 'rustexplore.com', structures }, null, 0) + '\n');
  console.log(`Wrote ${ok}/${targets.length} structures → ${OUT}`);
  if (failed.length) console.log('Skipped:', failed.join(', '));
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
