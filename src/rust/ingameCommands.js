import { log } from '../logger.js';
import { MARKER } from './markers.js';
import { raidCost } from '../util/raidcalc.js';
import { itemName, parseItemQuery } from '../util/items.js';
import { craftInfo, recycleInfo, decayInfo, durabilityInfo, fmtDuration, num } from '../util/rustlabs.js';
import { dayNight } from '../util/daynight.js';
import { priceLookup, renderPriceGame } from '../features/pricing.js';
import { resolveSteamId, getSummary, getBans, getRustStats, getPlaytimeMinutes } from '../enemy/steamstats.js';

// "10 rocket" → { qty: 10, rest: 'rocket' }; "rocket" → { qty: 1, rest: 'rocket' }.
// The leading integer means quantity (!craft/!recycle) or current HP (!decay).
function splitLeadingNumber(arg) {
  const m = String(arg ?? '').trim().match(/^(\d+)\s+(.+)$/);
  return m ? { n: Number(m[1]), rest: m[2] } : { n: null, rest: String(arg ?? '').trim() };
}

// Pack "name [value]" parts into one team-chat line within the 128-char budget
// (ChatBridge adds a "[BOT] " prefix), appending "…" if some had to be dropped.
function packLine(prefix, parts, budget = 116) {
  let line = prefix;
  let i = 0;
  for (; i < parts.length; i++) {
    const piece = (i === 0 ? ' ' : ', ') + parts[i];
    if (line.length + piece.length > budget) break;
    line += piece;
  }
  if (i < parts.length) line += ' …';
  return line;
}

// Read-only commands usable from the in-game team chat (prefix '!').
// Replies go back into team chat, which caps at ~128 chars, so keep them short.
const HELP =
  '!pop !time !online !team !teamstats !playtime-all !afktime-all !promote [ник] !cargo !heli !crates !price <предмет> !deals !raid <об> !durability <об> !craft <n> <предмет> !recycle <n> <предмет> !decay <hp> <об> !check <id> !wipe';

// Safe-zone shops (Outpost/Bandit Camp/peace zones) — excluded from deals: their
// prices are NPC-fixed and not real player offers. whereOf() tags them "🏛️ ...".
const isSafeZoneShop = (s) => typeof s.grid === 'string' && s.grid.startsWith('🏛️');

function gridsOf(session, type) {
  return session.liveMarkers().filter((m) => m.type === type).map((m) => m.grid);
}

// Cheapest in-stock offer per item across the server's shops.
function cheapestByItem(session) {
  const best = new Map();
  for (const s of session.shops()) {
    if (isSafeZoneShop(s)) continue;
    for (const o of s.sellOrders ?? []) {
      if (o.amountInStock <= 0) continue;
      const cur = best.get(o.itemId);
      if (!cur || o.costPerItem < cur.price) {
        best.set(o.itemId, { price: o.costPerItem, grid: s.grid, cur: o.currencyId });
      }
    }
  }
  return best;
}

export async function handleInGameCommand(session, teamMessage) {
  const raw = (teamMessage?.message ?? '').trim();
  if (!raw.startsWith('!')) return;
  const [cmd, ...rest] = raw.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  const reply = (text) => session.sendToGame(text);

  try {
    switch ((cmd || '').toLowerCase()) {
      case 'help':
      case 'commands':
        reply(HELP);
        break;

      case 'pop': {
        const info = await session.getInfo();
        const q = info.queuedPlayers ? ` (очередь ${info.queuedPlayers})` : '';
        reply(`Онлайн ${info.players}/${info.maxPlayers}${q}`);
        break;
      }

      case 'time': {
        const d = dayNight(await session.getTime());
        if (!d) return reply('Время сервера недоступно');
        if (d.mins == null) return reply(d.isDay ? 'Сейчас день' : 'Сейчас ночь');
        reply(d.isDay ? `Сейчас день, до ночи ~${d.mins} мин` : `Сейчас ночь, до рассвета ~${d.mins} мин`);
        break;
      }

      case 'online': {
        const team = await session.getTeamInfo();
        const on = (team.members ?? []).filter((m) => m.isOnline).map((m) => m.name);
        reply(on.length ? `В сети: ${on.join(', ')}` : 'Никого нет в сети');
        break;
      }

      case 'team': {
        const team = await session.getTeamInfo();
        const s = (team.members ?? []).map((m) => `${m.name}${m.isOnline ? (m.isAlive ? '+' : 'x') : '-'}`);
        reply(s.length ? `Тима: ${s.join(' ')}` : 'Тима пуста');
        break;
      }

      case 'cargo': {
        const g = gridsOf(session, MARKER.CARGO);
        reply(g.length ? `Карго: ${g.join(', ')}` : 'Карго нет на карте');
        break;
      }

      case 'heli': {
        const g = gridsOf(session, MARKER.HELI);
        reply(g.length ? `Хели: ${g.join(', ')}` : 'Хели нет на карте');
        break;
      }

      case 'crates': {
        const g = gridsOf(session, MARKER.CRATE);
        reply(g.length ? `Ящики: ${g.slice(0, 6).join(', ')}` : 'Ящиков нет на карте');
        break;
      }

      case 'price':
      case 'buy': {
        if (!arg) return reply('Напр.: !price ракета сера');
        const { itemId, currencyId } = parseItemQuery(arg);
        if (itemId == null) return reply('Не знаю такой предмет');
        reply(renderPriceGame(itemId, currencyId, priceLookup(session.shops(), itemId, currencyId)));
        break;
      }

      case 'deals': {
        const rows = [...cheapestByItem(session).entries()]
          .sort((a, b) => b[1].price - a[1].price)
          .slice(0, 4)
          .map(([id, v]) => `${itemName(id)} ${v.price}${v.grid}`);
        reply(rows.length ? `Дорогое: ${rows.join(', ')}` : 'Магазинов нет');
        break;
      }

      case 'raid': {
        if (!arg) return reply('Напр.: !raid дверь');
        const r = raidCost(arg);
        if (!r) return reply('Не знаю такой объект');
        const c4 = r.methods.find((m) => m.key === 'explosive-timed');
        const boom = r.methods
          .filter((m) => m.cat === 'boom' && m.sortSulfur < Number.MAX_SAFE_INTEGER)
          .sort((a, b) => a.sortSulfur - b.sortSulfur)[0];
        const tool = r.methods.filter((m) => m.cat === 'tool').sort((a, b) => a.count - b.count)[0];
        const bits = [];
        if (c4) bits.push(`${c4.count} C4`);
        if (boom) bits.push(`деш. ${boom.sortSulfur} серы (${boom.name})`);
        if (tool) bits.push(`🔨${tool.name}×${tool.count}`);
        reply(`${r.label}: ${bits.join(' · ') || 'нет данных'}`);
        break;
      }

      case 'wipe': {
        const info = await session.getInfo();
        const wipe = info.wipeTime ? new Date(info.wipeTime * 1000).toLocaleDateString('ru-RU') : '?';
        reply(`Seed ${info.seed ?? '?'} · вайп ${wipe}`);
        break;
      }

      case 'check': {
        if (!arg) return reply('Напр.: !check <SteamID|ссылка>');
        let steamId;
        try {
          steamId = await resolveSteamId(arg);
        } catch {
          return reply('Не понял профиль');
        }
        if (!steamId) return reply('Не нашёл SteamID');
        const [summary, bans, stats, playtime] = await Promise.all([
          getSummary(steamId).catch(() => null),
          getBans(steamId).catch(() => null),
          getRustStats(steamId).catch(() => ({ private: true })),
          getPlaytimeMinutes(steamId).catch(() => null),
        ]);
        if (!summary) return reply('Игрок не найден в Steam');
        const nm = (summary.name || '').slice(0, 24);
        const acc = summary.created ? `акк ${new Date(summary.created * 1000).getFullYear()}` : 'акк скрыт';
        const hrs = playtime ? `${Math.round(playtime / 60)}ч` : stats?.private ? 'часы скрыты' : '0ч';
        reply(`${nm}: VAC ${bans?.vacCount ?? 0}, игр.бан ${bans?.gameBans ?? 0}, ${acc}, ${hrs}`);
        break;
      }

      case 'craft':
      case 'crafting': {
        if (!arg) return reply('Напр.: !craft 10 ракета');
        const { n, rest } = splitLeadingNumber(arg);
        const c = craftInfo(rest, n ?? 1);
        if (!c) return reply('Не знаю крафт этого предмета');
        const ing = c.ingredients.map((i) => `${i.nameRu} x${num(i.qty)}`).join(', ');
        const wb = c.wb ? ` | ${c.wbLabel}` : '';
        reply(`Крафт ${c.nameRu} x${c.qty}: ${ing} | ${fmtDuration(c.timeSec)}${wb}`);
        break;
      }

      case 'recycle':
      case 'recycler': {
        if (!arg) return reply('Напр.: !recycle 20 тех мусор');
        const { n, rest } = splitLeadingNumber(arg);
        const safe = /\b(safe|сейф|мирка|мирн)\b/i.test(rest);
        const r = recycleInfo(rest.replace(/\b(safe|сейф|мирка|мирн\w*)\b/gi, '').trim(), n ?? 1, safe);
        if (!r) return reply('Этот предмет не перерабатывается');
        const out = r.yields.map((y) => `${y.nameRu} x${num(y.qty)}${y.prob < 1 ? ` (${Math.round(y.prob * 100)}%)` : ''}`).join(', ');
        reply(`Переработка ${r.nameRu} x${r.qty}${r.safe ? ' [мирка]' : ''}: ${out}`);
        break;
      }

      case 'decay':
      case 'despawn': {
        if (!arg) return reply('Напр.: !decay 350 каменная стена');
        const { n, rest } = splitLeadingNumber(arg);
        const d = decayInfo(rest, n);
        if (!d) return reply('Не знаю распад этого объекта');
        const where = d.kind === 'vehicle' ? ' (снаружи)' : '';
        const at = d.hp != null ? `${d.hp}/${d.maxHp} HP` : `${d.maxHp} HP`;
        reply(`Распад ${d.nameRu || d.name}: ${at} = ${fmtDuration(d.atSec)}${where}`);
        break;
      }

      case 'durability':
      case 'dura':
      case 'raidcost': {
        if (!arg) return reply('Напр.: !durability бронедверь');
        const u = durabilityInfo(arg);
        if (!u || !u.methods.length) return reply('Не знаю прочность этого объекта');
        reply(`Прочность ${u.nameRu || u.name} — топ по сере:`);
        u.methods.slice(0, 5).forEach((m, i) => {
          const fuel = m.fuel ? ` | топл ${m.fuel}` : '';
          reply(`#${i + 1} ${m.nameRu} x${m.qty} | ${fmtDuration(m.timeSec)}${fuel} | сера ${num(m.sulfur)}`);
        });
        break;
      }

      case 'teamstats':
      case 'teamstat': {
        const list = session.teamStats();
        if (!list.length) return reply('Пока нет статистики тимы за вайп');
        const play = list.reduce((a, s) => a + s.playtimeMs, 0);
        const afk = list.reduce((a, s) => a + s.afkMs, 0);
        const deaths = list.reduce((a, s) => a + s.deaths, 0);
        const dist = list.reduce((a, s) => a + s.distanceM, 0);
        reply(`Тима за вайп: в игре ${fmtDuration(play / 1000)} · AFK ${fmtDuration(afk / 1000)}`);
        reply(`Смертей ${deaths} · пройдено ${num(dist)} м`);
        break;
      }

      case 'playtime-all':
      case 'playtime': {
        const list = session.teamStats().filter((s) => s.playtimeMs > 0).sort((a, b) => b.playtimeMs - a.playtimeMs);
        if (!list.length) return reply('Пока нет данных об игровом времени тимы');
        reply(packLine('Время в игре:', list.map((s) => `${s.name || '?'} [${fmtDuration(s.playtimeMs / 1000)}]`)));
        break;
      }

      case 'afktime-all':
      case 'afktime':
      case 'afk': {
        const list = session.teamStats().filter((s) => s.afkMs > 0).sort((a, b) => b.afkMs - a.afkMs);
        if (!list.length) return reply('Пока нет данных об AFK тимы');
        reply(packLine('AFK тимы:', list.map((s) => `${s.name || '?'} [${fmtDuration(s.afkMs / 1000)}]`)));
        break;
      }

      case 'deaths':
      case 'graves': {
        const list = session.recentDeaths();
        if (!list.length) return reply('Смертей тимы пока не зафиксировано');
        const now = Date.now();
        // Compact age ("5м" / "2ч") so all 5 deaths fit the 128-char team-chat line.
        const ago = (ms) => {
          const m = Math.round(ms / 60_000);
          if (m < 1) return 'сейчас';
          return m < 60 ? `${m}м` : `${Math.round(m / 60)}ч`;
        };
        reply(packLine('Смерти тимы:', list.map((d) => `${d.name} ${d.grid} (${ago(now - d.at)})`)));
        break;
      }

      case 'promote':
      case 'leader': {
        // Hand team leadership to the caller (bare) or a named teammate. Rust only
        // lets the CURRENT leader transfer it, so the bot must itself be leader.
        const team = await session.getTeamInfo();
        const members = team.members ?? [];
        if (String(team.leaderSteamId) !== String(session.creds?.playerId)) {
          return reply('Бот не лидер тимы — передай ему лидерку в игре, и команда заработает');
        }
        let target;
        if (!arg) {
          target =
            members.find((m) => String(m.steamId) === String(teamMessage.steamId)) ||
            { steamId: teamMessage.steamId, name: teamMessage.name };
        } else {
          const q = arg.toLowerCase();
          target =
            members.find((m) => (m.name || '').toLowerCase() === q) ||
            members.find((m) => (m.name || '').toLowerCase().includes(q));
        }
        if (!target) return reply(`Не нашёл «${arg}» в тиме`);
        if (String(target.steamId) === String(team.leaderSteamId)) {
          return reply(`${target.name || 'Игрок'} уже лидер`);
        }
        try {
          await session.promoteToLeader(target.steamId);
          reply(`${target.name || 'Игрок'} назначен лидером тимы`);
        } catch {
          reply('Не вышло назначить лидера (бот должен быть текущим лидером)');
        }
        break;
      }

      default:
        // Unknown '!command' — stay silent to avoid spamming team chat.
        break;
    }
  } catch (err) {
    log.warn('in-game command failed:', err.message);
  }
}
