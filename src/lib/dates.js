const MINUTE = 60_000;
const DAY = 86_400_000;
const UNIT_MS = { d: DAY, h: 3_600_000, m: MINUTE };
const WEEKDAY_CODES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// Tiempo de gracia para enviar un aviso que tocaba mientras el bot estaba apagado.
export const GRACE_MS = 5 * MINUTE;

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Fecha y hora "de reloj" en una zona horaria para un instante dado.
export function wallClock(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAY_CODES.indexOf(p.weekday),
  };
}

// Convierte una fecha y hora de reloj en una zona horaria a milisegundos Unix.
export function zonedToUtc({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (ms) => {
    const w = wallClock(ms, timeZone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - ms;
  };
  // Segunda pasada para acertar alrededor de los cambios de hora.
  const firstPass = guess - offsetAt(guess);
  return guess - offsetAt(firstPass);
}

// "DD/MM/AAAA HH:MM" -> milisegundos Unix, o null si no es válida.
export function parseDateTime(text, timeZone) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [day, month, year, hour, minute] = match.slice(1).map(Number);
  if (hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return zonedToUtc({ year, month, day, hour, minute }, timeZone);
}

// "H:MM" o "HH:MM" -> "HH:MM", o null si no es válida.
export function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

// "30m", "2h", "1d", "1h30m" -> milisegundos, o null si no es válida.
export function parseDuration(text) {
  const clean = text.toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+[dhm])+$/.test(clean)) return null;
  let total = 0;
  for (const [, amount, unit] of clean.matchAll(/(\d+)([dhm])/g)) {
    total += Number(amount) * UNIT_MS[unit];
  }
  return total > 0 ? total : null;
}

// 5_400_000 -> "1 h 30 min"
export function formatDuration(ms) {
  const minutes = Math.round(ms / MINUTE);
  const parts = [
    [Math.floor(minutes / 1440), 'd'],
    [Math.floor((minutes % 1440) / 60), 'h'],
    [minutes % 60, 'min'],
  ];
  return parts.filter(([amount]) => amount > 0).map(([amount, unit]) => `${amount} ${unit}`).join(' ') || 'menos de 1 min';
}

// Si toca enviar ahora un aviso semanal, devuelve el inicio de lo que anuncia; si no, null.
export function weeklyDue(cls, now, timeZone) {
  const [hour, minute] = cls.time.split(':').map(Number);
  // El aviso puede caer el día anterior, así que se mira también mañana.
  for (const probe of [now, now + DAY]) {
    const w = wallClock(probe, timeZone);
    if (w.weekday !== cls.weekday) continue;
    const start = zonedToUtc({ year: w.year, month: w.month, day: w.day, hour, minute }, timeZone);
    const notifyAt = start - cls.lead_minutes * MINUTE;
    const alreadySent = cls.last_sent != null && cls.last_sent >= notifyAt;
    if (now >= notifyAt && now <= start + GRACE_MS && !alreadySent) return start;
  }
  return null;
}

// Marca de tiempo que Discord muestra en la hora local de cada persona.
export function discordTime(ms, style = 'F') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}
