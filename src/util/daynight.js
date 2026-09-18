// Day/night state + real-world minutes until the next sunrise/sunset, derived
// from the Rust+ AppTime ({ time, sunrise, sunset, dayLengthMinutes }). The raw
// in-game "hour" is confusing to players, so commands surface the real-time
// countdown to the next flip instead.

const hoursForward = (now, target) => (((target - now) % 24) + 24) % 24;

// → { isDay, mins } where mins = real-world minutes until the next day↔night
// flip (null if the server doesn't report dayLengthMinutes), or null if the time
// payload is malformed.
export function dayNight(time) {
  const t = Number(time?.time);
  const sunrise = Number(time?.sunrise);
  const sunset = Number(time?.sunset);
  if (!Number.isFinite(t) || !Number.isFinite(sunrise) || !Number.isFinite(sunset)) return null;
  const isDay = t >= sunrise && t < sunset;
  const target = isDay ? sunset : sunrise;
  const perHourMin =
    Number.isFinite(time.dayLengthMinutes) && time.dayLengthMinutes > 0 ? time.dayLengthMinutes / 24 : null;
  const mins = perHourMin != null ? Math.max(0, Math.round(hoursForward(t, target) * perHourMin)) : null;
  return { isDay, mins };
}

// One-line bilingual label with emoji (Telegram/DM use):
// "☀️ день · до ночи ~12 мин" / "🌙 ночь · до рассвета ~3 мин".
export function dayNightLabel(time, lang = 'ru') {
  const d = dayNight(time);
  if (!d) return lang === 'en' ? '⏱️ time unknown' : '⏱️ время неизвестно';
  const { isDay, mins } = d;
  if (lang === 'en') {
    if (mins == null) return isDay ? '☀️ day' : '🌙 night';
    return isDay ? `☀️ day · ${mins} min to night` : `🌙 night · ${mins} min to dawn`;
  }
  if (mins == null) return isDay ? '☀️ день' : '🌙 ночь';
  return isDay ? `☀️ день · до ночи ~${mins} мин` : `🌙 ночь · до рассвета ~${mins} мин`;
}
