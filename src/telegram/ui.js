// Telegram HTML theme helpers. Bot API renders <b>/<i>/<u>/<s>/<code>/<pre>/
// <a>/<tg-spoiler> and (7.0+) <blockquote> + <blockquote expandable> — the
// latter collapses long content behind a "Show more" tap, which is the basis of
// the bot's tidy, card-like look.
//
// RULE: any dynamic value (server/player/item names, user input) interpolated
// into an HTML message MUST go through esc() — an unescaped < > & breaks parsing.

export const HTML = { parse_mode: 'HTML' };

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const b = (s) => `<b>${s}</b>`;
export const i = (s) => `<i>${s}</i>`;
export const code = (s) => `<code>${esc(s)}</code>`; // escapes its own content
export const spoiler = (s) => `<tg-spoiler>${s}</tg-spoiler>`;

// Left-bar panel for compact info (status, sub, time).
export const panel = (s) => `<blockquote>${s}</blockquote>`;
// Collapsible panel for long reference content (help sections, raid methods).
export const expand = (s) => `<blockquote expandable>${s}</blockquote>`;

// Thin divider between sections.
export const RULE = '────────────';

// Title + collapsible body — the standard section card.
export const section = (title, body) => `${b(title)}\n${expand(body)}`;
