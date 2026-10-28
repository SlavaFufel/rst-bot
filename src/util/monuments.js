import { gridFromXY, nearestGrid } from './grid.js';

// Rust+ monument tokens → friendly names + search aliases (RU/EN). Order matters:
// more specific patterns first (large oil before oil, sulfur quarry before quarry).
// Unknown tokens fall back to a cleaned-up token ("water_well_a" → "water well a").
const KNOWN = [
  { re: /large_oil|oil_rig_large/, ru: 'Большая нефтянка', en: 'Large Oil Rig', aliases: ['большая нефтянка', 'бнр', 'large oil', 'large rig'] },
  { re: /oil_rig_small|small_oil/, ru: 'Малая нефтянка', en: 'Small Oil Rig', aliases: ['малая нефтянка', 'мнр', 'small oil', 'small rig'] },
  { re: /airfield/, ru: 'Аэропорт', en: 'Airfield', aliases: ['аэропорт', 'аэродром', 'airfield'] },
  { re: /bandit/, ru: 'Бандитка', en: 'Bandit Camp', aliases: ['бандитка', 'бандит', 'bandit'] },
  { re: /outpost|compound/, ru: 'Аутпост', en: 'Outpost', aliases: ['аутпост', 'outpost'] },
  { re: /dome/, ru: 'Купол', en: 'Dome', aliases: ['купол', 'dome'] },
  { re: /large_fishing/, ru: 'Большая рыбацкая деревня', en: 'Large Fishing Village', aliases: ['большая рыбацкая', 'large fishing'] },
  { re: /fishing/, ru: 'Рыбацкая деревня', en: 'Fishing Village', aliases: ['рыбацкая', 'деревня', 'fishing'] },
  { re: /gas_station|oxum/, ru: 'Заправка', en: 'Gas Station', aliases: ['заправка', 'gas station', 'oxum'] },
  { re: /harbor/, ru: 'Порт', en: 'Harbor', aliases: ['порт', 'гавань', 'harbor', 'harbour'] },
  { re: /junkyard/, ru: 'Свалка', en: 'Junkyard', aliases: ['свалка', 'junkyard'] },
  { re: /launch/, ru: 'Космодром', en: 'Launch Site', aliases: ['космодром', 'лаунч', 'launch'] },
  { re: /lighthouse/, ru: 'Маяк', en: 'Lighthouse', aliases: ['маяк', 'lighthouse'] },
  { re: /military_tunnel/, ru: 'Военные туннели', en: 'Military Tunnels', aliases: ['военные туннели', 'мт', 'military tunnels', 'tunnels'] },
  { re: /mining_outpost/, ru: 'Шахтёрский аванпост', en: 'Mining Outpost', aliases: ['шахтерский', 'шахтёрский', 'mining outpost'] },
  { re: /power_plant/, ru: 'Электростанция', en: 'Power Plant', aliases: ['электростанция', 'пп', 'power plant'] },
  { re: /satellite/, ru: 'Спутниковая тарелка', en: 'Satellite Dish', aliases: ['спутник', 'тарелка', 'satellite', 'dish'] },
  { re: /sewer/, ru: 'Канализация', en: 'Sewer Branch', aliases: ['канализация', 'sewer'] },
  { re: /stables|ranch/, ru: 'Конюшни', en: 'Ranch / Stables', aliases: ['конюшни', 'ранчо', 'stables', 'ranch'] },
  { re: /supermarket/, ru: 'Супермаркет', en: 'Supermarket', aliases: ['супермаркет', 'магазин', 'supermarket'] },
  { re: /train_tunnel/, ru: 'Вход в метро', en: 'Train Tunnel', aliases: ['метро', 'train tunnel', 'subway'] },
  { re: /train_yard/, ru: 'Ж/д депо', en: 'Train Yard', aliases: ['депо', 'жд', 'train yard', 'trainyard'] },
  { re: /underwater_lab/, ru: 'Подводная лаба', en: 'Underwater Lab', aliases: ['подводная', 'лаба', 'underwater', 'lab'] },
  { re: /water_treatment/, ru: 'Водоочистка', en: 'Water Treatment', aliases: ['водоочистка', 'water treatment', 'wtp'] },
  { re: /excavator/, ru: 'Экскаватор', en: 'Giant Excavator', aliases: ['экскаватор', 'excavator'] },
  { re: /quarry_sulfur|sulfur_quarry/, ru: 'Серный карьер', en: 'Sulfur Quarry', aliases: ['серный карьер', 'сера карьер', 'sulfur quarry'] },
  { re: /quarry_hqm|hqm_quarry/, ru: 'МВК карьер', en: 'HQM Quarry', aliases: ['мвк карьер', 'hqm quarry'] },
  { re: /quarry_stone|stone_quarry/, ru: 'Каменный карьер', en: 'Stone Quarry', aliases: ['каменный карьер', 'stone quarry'] },
  { re: /arctic/, ru: 'Арктическая база', en: 'Arctic Research Base', aliases: ['арктическая', 'арктика', 'arctic'] },
  { re: /missile_silo|silo/, ru: 'Ракетная шахта', en: 'Missile Silo', aliases: ['ракетная шахта', 'шахта', 'silo'] },
  { re: /ferry/, ru: 'Паромный терминал', en: 'Ferry Terminal', aliases: ['паром', 'ferry'] },
  { re: /abandoned_military|military_base/, ru: 'Заброшенная военная база', en: 'Abandoned Military Base', aliases: ['военная база', 'military base'] },
];

const cleanToken = (token) =>
  String(token ?? '').replace(/_display_name$|_monument(_name)?$/i, '').replace(/_/g, ' ').trim();

export function monumentInfo(token) {
  const t = String(token ?? '').toLowerCase();
  const k = KNOWN.find((m) => m.re.test(t));
  if (k) return { ru: k.ru, en: k.en, aliases: k.aliases };
  const name = cleanToken(token);
  return { ru: name, en: name, aliases: [name.toLowerCase()] };
}

// Monuments matching a free-text query (alias or name substring), with grids.
// Monuments outside the lettered grid (oil rigs at sea) get the nearest cell, "~"-prefixed.
export function findMonuments(monuments, query, mapSize) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const m of monuments ?? []) {
    const info = monumentInfo(m.token);
    const hay = [info.ru.toLowerCase(), info.en.toLowerCase(), ...info.aliases];
    if (!hay.some((h) => h.includes(q) || (q.length >= 3 && q.includes(h)))) continue;
    const exact = gridFromXY(m.x, m.y, mapSize);
    const near = exact ? null : nearestGrid(m.x, m.y, mapSize);
    out.push({ ...info, grid: exact ?? (near ? `~${near}` : '??') });
  }
  return out;
}
