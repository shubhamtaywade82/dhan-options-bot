/**
 * IST (Asia/Kolkata) time utilities.
 * The bot must behave identically regardless of the host machine's timezone,
 * so every clock read goes through these helpers.
 */

export const IST_TZ = 'Asia/Kolkata';

const MARKET_OPEN = { h: 9, m: 15 };   // 09:15 IST
const MARKET_CLOSE = { h: 15, m: 30 }; // 15:30 IST

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
  weekday: 'short',
});

/**
 * Decompose a Date into its IST calendar parts.
 * Returns { date: 'YYYY-MM-DD', time: 'HH:MM:SS', hh, mm, ss, weekday, minutes }
 * `minutes` = hh*60+mm - handy for comparing with HH:MM config strings.
 */
export function istParts(date = new Date()) {
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const hh = parseInt(parts.hour, 10) % 24; // Intl can yield "24" at midnight
  const mm = parseInt(parts.minute, 10);
  const ss = parseInt(parts.second, 10);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
    hh, mm, ss,
    weekday: parts.weekday,
    minutes: hh * 60 + mm,
  };
}

/** 'HH:MM' (IST) -> minutes since midnight */
export function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str).trim());
  if (!m) throw new Error(`Invalid HH:MM value: ${str}`);
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Is the given date a weekday (Mon-Fri) in IST? */
export function isWeekday(date = new Date()) {
  return !['Sat', 'Sun'].includes(istParts(date).weekday);
}

/** Is the date in the configured holiday list (YYYY-MM-DD, IST)? */
export function isHoliday(date = new Date(), holidays = []) {
  return holidays.includes(istParts(date).date);
}

/** Is NSE/BSE cash+F&O session open right now (09:15-15:30 IST, Mon-Fri, not a holiday)? */
export function isMarketOpen(date = new Date(), holidays = []) {
  if (!isWeekday(date) || isHoliday(date, holidays)) return false;
  const { minutes } = istParts(date);
  return minutes >= MARKET_OPEN.h * 60 + MARKET_OPEN.m &&
         minutes < MARKET_CLOSE.h * 60 + MARKET_CLOSE.m;
}

/** Current IST minutes-since-midnight compared to an 'HH:MM' string: -1 before, 0 inside?, +1 after */
export function comparedToHHMM(hhmm, date = new Date()) {
  return istParts(date).minutes - parseHHMM(hhmm);
}

/** True when IST time is at or past `hhmm` */
export function isPastHHMM(hhmm, date = new Date()) {
  return comparedToHHMM(hhmm, date) >= 0;
}

/** True when IST time is within [start,end] inclusive-exclusive */
export function withinWindow(startHHMM, endHHMM, date = new Date()) {
  const m = istParts(date).minutes;
  return m >= parseHHMM(startHHMM) && m < parseHHMM(endHHMM);
}

/** Human-readable IST timestamp for logs: 2026-11-03 10:15:42 IST */
export function istStamp(date = new Date()) {
  const p = istParts(date);
  return `${p.date} ${p.time} IST`;
}
