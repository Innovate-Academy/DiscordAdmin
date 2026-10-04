import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xpToNext, levelFromXp, randomXp, canEarnXp } from '../src/lib/xp.js';
import { nextCounter } from '../src/lib/counter.js';
import { pickWinners } from '../src/lib/giveaway.js';
import { parseDateTime, parseTime, parseDuration, weeklyDue, wallClock, isValidTimeZone } from '../src/lib/dates.js';
import { fillTemplate, truncate, chunkMentions, escapeLike } from '../src/lib/text.js';
import { buildTranscript } from '../src/lib/transcript.js';

const MADRID = 'Europe/Madrid';
const MINUTE = 60_000;

test('xp: nivel a partir de la XP total', () => {
  assert.equal(xpToNext(0), 100);
  assert.equal(xpToNext(1), 155);
  assert.deepEqual(levelFromXp(0), { level: 0, progress: 0, needed: 100 });
  assert.deepEqual(levelFromXp(99), { level: 0, progress: 99, needed: 100 });
  assert.deepEqual(levelFromXp(100), { level: 1, progress: 0, needed: 155 });
  assert.deepEqual(levelFromXp(260), { level: 2, progress: 5, needed: 220 });
});

test('xp: la XP por mensaje está entre 15 y 25', () => {
  assert.equal(randomXp(() => 0), 15);
  assert.equal(randomXp(() => 0.999999), 25);
});

test('xp: espera de 60 s entre mensajes que cuentan', () => {
  assert.equal(canEarnXp(null, 1000), true);
  assert.equal(canEarnXp(1000, 1000 + 59_999), false);
  assert.equal(canEarnXp(1000, 1000 + 60_000), true);
});

test('contador: envía al llegar a N y reinicia', () => {
  const opts = { every: 3, minGapMs: 10 * MINUTE, now: 1_000_000 };
  assert.deepEqual(nextCounter({ count: 0, lastSentAt: null }, opts), { count: 1, lastSentAt: null, send: false });
  assert.deepEqual(nextCounter({ count: 2, lastSentAt: null }, opts), { count: 0, lastSentAt: 1_000_000, send: true });
});

test('contador: respeta el tiempo mínimo entre avisos y envía en cuanto se cumple', () => {
  const state = { count: 2, lastSentAt: 1_000_000 };
  const early = nextCounter(state, { every: 3, minGapMs: 10 * MINUTE, now: 1_000_000 + 5 * MINUTE });
  assert.deepEqual(early, { count: 3, lastSentAt: 1_000_000, send: false });
  const later = nextCounter(early, { every: 3, minGapMs: 10 * MINUTE, now: 1_000_000 + 10 * MINUTE });
  assert.equal(later.send, true);
  assert.equal(later.count, 0);
});

test('sorteo: ganadores distintos y nunca más que participantes', () => {
  const entries = ['a', 'b', 'c', 'd', 'e'];
  const winners = pickWinners(entries, 3);
  assert.equal(winners.length, 3);
  assert.equal(new Set(winners).size, 3);
  assert.ok(winners.every((w) => entries.includes(w)));
  assert.deepEqual(pickWinners(['a', 'b'], 5).sort(), ['a', 'b']);
  assert.deepEqual(pickWinners([], 1), []);
  assert.deepEqual(pickWinners(entries, 2, () => 0), ['a', 'b']);
  assert.deepEqual(entries, ['a', 'b', 'c', 'd', 'e'], 'no modifica la lista original');
});

test('fechas: DD/MM/AAAA HH:MM en hora de Madrid (invierno y verano)', () => {
  assert.equal(parseDateTime('15/01/2026 18:00', MADRID), Date.UTC(2026, 0, 15, 17, 0));
  assert.equal(parseDateTime('15/07/2026 18:00', MADRID), Date.UTC(2026, 6, 15, 16, 0));
  assert.equal(parseDateTime(' 5/3/2026 9:05 ', MADRID), Date.UTC(2026, 2, 5, 8, 5));
});

test('fechas: rechaza formatos y fechas imposibles', () => {
  for (const bad of ['mañana', '31/02/2026 10:00', '10/13/2026 10:00', '10/10/2026 24:00', '10/10/2026 10:60', '2026-10-10 10:00']) {
    assert.equal(parseDateTime(bad, MADRID), null, bad);
  }
});

test('fechas: hora y duración', () => {
  assert.equal(parseTime('9:30'), '09:30');
  assert.equal(parseTime('18:00'), '18:00');
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('las seis'), null);
  assert.equal(parseDuration('30m'), 30 * MINUTE);
  assert.equal(parseDuration('1h 30m'), 90 * MINUTE);
  assert.equal(parseDuration('2D'), 2 * 86_400_000);
  assert.equal(parseDuration('0m'), null);
  assert.equal(parseDuration('pronto'), null);
  assert.equal(parseDuration('10'), null);
});

test('fechas: zona horaria válida', () => {
  assert.equal(isValidTimeZone(MADRID), true);
  assert.equal(isValidTimeZone('Marte/Olimpo'), false);
  assert.equal(wallClock(Date.UTC(2026, 9, 5, 16, 0), MADRID).weekday, 1);
});

test('clases: avisa una sola vez dentro de la ventana previa a la clase', () => {
  // Lunes 05/10/2026 18:00 en Madrid = 16:00 UTC.
  const start = Date.UTC(2026, 9, 5, 16, 0);
  const cls = { weekday: 1, time: '18:00', lead_minutes: 10, last_sent: null };
  assert.equal(weeklyDue(cls, start - 11 * MINUTE, MADRID), null);
  assert.equal(weeklyDue(cls, start - 10 * MINUTE, MADRID), start);
  assert.equal(weeklyDue(cls, start + 4 * MINUTE, MADRID), start);
  assert.equal(weeklyDue(cls, start + 6 * MINUTE, MADRID), null);
  assert.equal(weeklyDue({ ...cls, last_sent: start - 10 * MINUTE }, start - 9 * MINUTE, MADRID), null);
  const lastWeek = start - 7 * 86_400_000;
  assert.equal(weeklyDue({ ...cls, last_sent: lastWeek }, start - 5 * MINUTE, MADRID), start);
  assert.equal(weeklyDue({ ...cls, weekday: 2 }, start - 5 * MINUTE, MADRID), null);
});

test('clases: el aviso puede caer el día anterior', () => {
  // Martes 06/10/2026 00:05 en Madrid = lunes 22:05 UTC; aviso 10 minutos antes, aún lunes.
  const start = Date.UTC(2026, 9, 5, 22, 5);
  const cls = { weekday: 2, time: '00:05', lead_minutes: 10, last_sent: null };
  assert.equal(weeklyDue(cls, start - 8 * MINUTE, MADRID), start);
});

test('texto: plantilla, recorte, menciones y LIKE', () => {
  assert.equal(fillTemplate('Hola {usuario} en {servidor} {otro}', { usuario: 'Ana', servidor: 'X' }), 'Hola Ana en X {otro}');
  assert.equal(truncate('hola', 10), 'hola');
  assert.equal(truncate('hola mundo', 5), 'hola…');
  assert.deepEqual(chunkMentions([]), []);
  assert.deepEqual(chunkMentions(['1', '2']), ['<@1> <@2>']);
  const chunks = chunkMentions(Array.from({ length: 200 }, (_, i) => `12345678901234567${i}`), 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.equal(escapeLike('50%_a\\b'), '50\\%\\_a\\\\b');
});

test('transcripción: cabecera y mensajes', () => {
  const ticket = { id: 7, title: 'No carga', user_id: '42', created_at: Date.UTC(2026, 0, 1, 10, 0), description: 'Pantalla en blanco', steps: 'Abrir la web' };
  const text = buildTranscript(ticket, [
    { created_at: Date.UTC(2026, 0, 1, 10, 5), author_name: 'ana', author_id: '42', content: 'hola', attachments: '', deleted_at: null },
    { created_at: Date.UTC(2026, 0, 1, 10, 6), author_name: null, author_id: '99', content: 'foto', attachments: 'http://x/y.png', deleted_at: 1 },
  ]);
  assert.match(text, /^Ticket #7: No carga/);
  assert.match(text, /Pasos para reproducir:\nAbrir la web/);
  assert.match(text, /\[2026-01-01 10:05\] ana: hola\n/);
  assert.match(text, /\[2026-01-01 10:06\] 99: foto \[adjuntos: http:\/\/x\/y\.png\] \(borrado\)$/);
});
