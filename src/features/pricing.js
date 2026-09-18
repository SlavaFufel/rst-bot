import { itemNameRu } from '../util/items.js';

// Capitalise the first letter (RU item names are stored lowercase).
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Currency-aware shop pricing, shared by the Telegram /price and in-game !price.
// shops: [{ grid, sellOrders: [{ itemId, currencyId, costPerItem, quantity, amountInStock }] }]

// Cheapest in-stock offer of `itemId`, per currency, across all shops.
// Returns { best, byCurrency } where best is constrained to `currencyId` when given.
export function priceLookup(shops, itemId, currencyId = null) {
  const perCurrency = new Map(); // currencyId -> cheapest offer for that currency
  for (const s of shops ?? []) {
    for (const o of s.sellOrders ?? []) {
      if (Number(o.itemId) !== Number(itemId)) continue;
      if ((o.amountInStock ?? 0) <= 0) continue; // can't buy what's out of stock
      const cid = Number(o.currencyId);
      const offer = { currencyId: cid, price: o.costPerItem, qty: o.quantity, grid: s.grid, stock: o.amountInStock };
      const cur = perCurrency.get(cid);
      if (!cur || offer.price < cur.price) perCurrency.set(cid, offer);
    }
  }
  const byCurrency = [...perCurrency.values()].sort((a, b) => a.price - b.price);
  const best = currencyId != null ? perCurrency.get(Number(currencyId)) ?? null : byCurrency[0] ?? null;
  return { best, byCurrency };
}

// Minimal HTML escape for dynamic names interpolated into the Telegram answer.
const escH = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// "12× за 120 сера · D7" (prefixes the bundle size when a shop sells more than one).
function offerStr(o, e = (x) => x) {
  return `${o.qty > 1 ? `${o.qty}× за ` : ''}${o.price} ${e(itemNameRu(o.currencyId))} · ${e(o.grid)}`;
}

// Multi-line Telegram answer (HTML): best price in a panel + every other
// currency it sells for in a collapsible block.
export function renderPriceTG(itemId, currencyId, { best, byCurrency }) {
  const name = escH(cap(itemNameRu(itemId)));
  if (!best) {
    if (currencyId != null) {
      const alt = byCurrency.length
        ? ` Продаётся за: ${byCurrency.map((o) => escH(itemNameRu(o.currencyId))).join(', ')}.`
        : '';
      return `💰 <b>${name}</b> (валюта: ${escH(itemNameRu(currencyId))}) — сейчас не найдено.${alt}`;
    }
    return `💰 <b>${name}</b> сейчас не продаётся.`;
  }
  const head =
    currencyId != null
      ? `💰 <b>${name}</b> — дешевле всего · валюта ${escH(itemNameRu(currencyId))}`
      : `💰 <b>${name}</b> — дешевле всего`;
  let out = `${head}\n<blockquote>🏷️ ${offerStr(best, escH)} · сток ${best.stock}</blockquote>`;
  const others = byCurrency.filter((o) => o.currencyId !== best.currencyId);
  if (others.length) {
    out +=
      '\nЕщё можно купить за:\n<blockquote expandable>' +
      others.map((o) => `• ${offerStr(o, escH)} · сток ${o.stock}`).join('\n') +
      '</blockquote>';
  }
  return out;
}

// One compact line for the in-game team chat (~128 char cap): best + up to 3 alts.
export function renderPriceGame(itemId, currencyId, { best, byCurrency }) {
  const name = cap(itemNameRu(itemId));
  if (!best) return `${name}: не продаётся${currencyId != null ? ` (валюта: ${itemNameRu(currencyId)})` : ''}`;
  const alts = byCurrency.filter((o) => o.currencyId !== best.currencyId).slice(0, 3);
  const line = `${name}: ${[best, ...alts].map((o) => offerStr(o)).join(' · ')}`;
  return line.length > 126 ? line.slice(0, 125) + '…' : line;
}
