// Datums in Nederlandse tijd, ook als de router in UTC draait.
export const zone = process.env.TZ_HOUSEHOLD || 'Europe/Amsterdam';
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});
export const weekdays = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const day = 86_400_000;

/** 'YYYY-MM-DD' in de huishoudtijdzone. */
export function localDate(time: number | Date = Date.now()): string {
  return dateFormat.format(time);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 = zondag … 6 = zaterdag. */
export function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** ISO-weeknummer als 'YYYY-Www', voor het herkennen van opeenvolgende weken. */
export function isoWeek(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const start = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - start) / day + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function previousWeek(week: string): string {
  const [y, w] = week.split('-W').map(Number);
  // Maandag van die week, min 7 dagen.
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * day + (w - 1) * 7 * day);
  return isoWeek(new Date(monday.getTime() - 7 * day).toISOString().slice(0, 10));
}

function offset(time: number): number {
  const parts = Object.fromEntries(partsFormat.formatToParts(time).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(time / 1000) * 1000;
}

/** Tijdstip (ms) van een lokale datum en klok, bijv. ('2026-11-10', 22, 0). */
export function zonedTime(date: string, hour: number, minute = 0): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const first = guess - offset(guess);
  return guess - offset(first);
}

const timeFormat = new Intl.DateTimeFormat('nl-NL', { timeZone: zone, hour: '2-digit', minute: '2-digit' });
const longFormat = new Intl.DateTimeFormat('nl-NL', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' });
export const clock = (time: number | string) => timeFormat.format(new Date(time));
export const longDate = (time: number | string) => longFormat.format(new Date(time));
export function dayName(date: string) {
  return weekdays[weekday(date)];
}

/** Herken 'vandaag', 'morgen', 'vrijdag', '2026-11-13' of '13-11'. Toekomstige weekdag binnen 7 dagen. */
export function resolveDay(text: string, today = localDate()): string | null {
  const value = text.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (value === 'vandaag') return today;
  if (value === 'morgen') return addDays(today, 1);
  if (value === 'overmorgen') return addDays(today, 2);
  const dm = /^(\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (dm) {
    const year = Number(today.slice(0, 4));
    let date = `${year}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    if (date < today) date = `${year + 1}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    return date;
  }
  const index = weekdays.findIndex(name => name === value || name.slice(0, 2) === value || name.slice(0, 3) === value);
  if (index < 0) return null;
  const diff = (index - weekday(today) + 7) % 7;
  return addDays(today, diff);
}
