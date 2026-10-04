import '../../src/extensions/academy/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, Events } from 'discord.js';
import { looksLikeUnformattedCode, normalizeCode } from '../../src/extensions/academy/courses.js';
import attendance from '../../src/extensions/academy/attendance.js';
import classDms from '../../src/extensions/academy/classDms.js';
import notifications from '../../src/modules/notifications.js';
import weekly from '../../src/modules/weekly.js';
import coursework from '../../src/extensions/academy/coursework.js';
import doubts from '../../src/extensions/academy/doubts.js';
import enrollment from '../../src/extensions/academy/enrollment.js';
import graduation, { missingRequirements } from '../../src/extensions/academy/graduation.js';
import { logMessage } from '../../src/modules/messageLog.js';
import radar, { buildRadar } from '../../src/extensions/academy/radar.js';
import { progressOf, riskReasons } from '../../src/extensions/academy/progress.js';
import { createRouter } from '../../src/router.js';
import { embedOf, fakeChannel, fakeCtx, fakeInteraction, fakeMember, textOf, userOption } from '../helpers.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const flush = () => new Promise((resolve) => setImmediate(resolve));
// Una clase es un aviso semanal del núcleo; la academia añade el recordatorio personal por privado.
const tickClasses = async (ctx, now) => {
  await classDms.tick(ctx, now);
  await weekly.tick(ctx, now);
};

// Grupo "Python · Octubre" con profesor `profe` y dos alumnos, `ana` y `luis`.
async function classroom() {
  const mod = fakeChannel('mod');
  const ctx = fakeCtx([mod]);
  ctx.settings.set('role_staff', 'r-staff');
  ctx.settings.set('channel_mod', 'mod');
  await enrollment.onCommand(fakeInteraction(ctx, { command: 'grupo', sub: 'crear', options: { curso: 'python', nombre: 'Octubre', profesor: { id: 'profe' } } }), ctx);
  const [category, avisos, dudas, entregas] = ctx.created;
  const group = ctx.db.prepare('SELECT * FROM course_groups').get();
  const students = {};
  for (const id of ['ana', 'luis']) {
    students[id] = fakeMember(id);
    ctx.members.set(id, students[id]);
    ctx.db.prepare("INSERT INTO enrollments (group_id, user_id, source, enrolled_at) VALUES (?, ?, 'staff', 0)").run(group.id, id);
  }
  // Atajos para lanzar interacciones como el profesor o como un alumno, desde un canal del grupo.
  const as = (who) => (who === 'profe' ? { userId: 'profe', admin: false } : { member: students[who] ?? fakeMember(who), admin: false });
  const command = (mod_, who, name, sub, options = {}, channel = avisos) => {
    const interaction = fakeInteraction(ctx, { command: name, sub, options, channel, ...as(who) });
    return mod_.onCommand(interaction, ctx).then(() => interaction);
  };
  const component = (mod_, who, kind, action, arg, extra = {}) => {
    const interaction = fakeInteraction(ctx, { kind, channel: avisos, ...as(who), ...extra });
    return mod_.onComponent(interaction, ctx, action, String(arg)).then(() => interaction);
  };
  return { ctx, mod, group, category, avisos, dudas, entregas, students, command, component };
}

test('grupo: guarda los canales de dudas y entregas y los comandos se resuelven por canal', async () => {
  const { group, dudas, entregas, avisos, category } = await classroom();
  assert.equal(group.doubts_id, dudas.id);
  assert.equal(group.submissions_id, entregas.id);
  assert.equal(avisos.parentId, category.id);
});

test('código sin formato: se detecta solo cuando parece código de verdad', () => {
  assert.equal(looksLikeUnformattedCode('def suma(a, b):\n    return a + b\nprint(suma(1, 2))'), true);
  assert.equal(looksLikeUnformattedCode('function hola() {\n  console.log("hola");\n}'), true);
  assert.equal(looksLikeUnformattedCode('```py\ndef suma(a, b):\n    return a + b\nprint(1)\n```'), false);
  assert.equal(looksLikeUnformattedCode('Hola profe\ntengo una duda\nsobre la clase de ayer'), false);
  assert.equal(looksLikeUnformattedCode('print("hola")'), false);
  assert.equal(normalizeCode('cert abcd 2345', 'CERT'), 'CERT-ABCD-2345');
  assert.equal(normalizeCode('IA-ABCD-2345', 'CERT'), null);
});

test('dudas: formulario, hilo con el código, resolver y puntos de ayudante', async () => {
  const { ctx, dudas, command, component } = await classroom();
  await assert.rejects(command(doubts, 'intruso', 'duda'), /No estás matriculado/);
  const opened = await command(doubts, 'ana', 'duda');
  assert.equal(opened.modal.toJSON().custom_id, 'doubts:ask:1');

  const fields = { titulo: 'Bucle infinito', intento: 'Sumar una lista', codigo: 'while True:\n    pass', error: 'No termina nunca' };
  const asked = await component(doubts, 'ana', 'modal', 'ask', 1, { fields });
  const [post] = dudas.sent;
  const [thread] = dudas.createdThreads;
  assert.equal(embedOf(post.payload).title, '❓ Bucle infinito');
  assert.equal(thread.name, 'Duda: Bucle infinito');
  assert.equal(textOf(thread.sent[0].payload), '```py\nwhile True:\n    pass\n```');
  assert.match(textOf(thread.sent[1].payload), /Error o resultado:[\s\S]*No termina nunca/);
  assert.match(textOf(asked.replies[0]), new RegExp(thread.id));

  await assert.rejects(component(doubts, 'luis', 'button', 'resolve', 1), /Solo quien preguntó o el profesor/);
  const menu = await component(doubts, 'ana', 'button', 'resolve', 1);
  assert.deepEqual(menu.replies[0].components.map((row) => row.toJSON().components[0].custom_id), ['doubts:helper:1', 'doubts:solo:1']);
  await assert.rejects(component(doubts, 'ana', 'select', 'helper', 1, { values: ['ana'] }), /no puede llevarse el punto/);

  const done = await component(doubts, 'ana', 'select', 'helper', 1, { values: ['luis'] });
  assert.match(textOf(done.replies[0]), /<@luis> se lleva un punto/);
  assert.equal(embedOf(post.payload).title, '✅ Bucle infinito');
  assert.deepEqual(post.payload.components, []);
  assert.equal(thread.archived, true);
  await assert.rejects(component(doubts, 'ana', 'button', 'solo', 1), /ya estaba resuelta/);

  // El profesor también puede cerrar una duda; sin ayuda no hay punto.
  await component(doubts, 'luis', 'modal', 'ask', 1, { fields: { titulo: 'Otra', intento: 'x' } });
  await component(doubts, 'profe', 'button', 'solo', 2);
  assert.deepEqual(ctx.db.prepare('SELECT user_id, points FROM help_points').all().map((r) => ({ ...r })), [{ user_id: 'luis', points: 1 }]);
  const top = await command(doubts, 'ana', 'ayudantes');
  assert.match(embedOf(top.replies[0]).description, /<@luis> · 1 duda resuelta/);
});

test('dudas: a las 12 h sin respuesta se avisa al profesor, y el menú de ayudante pasa por el router', async () => {
  const { ctx, dudas, component } = await classroom();
  await component(doubts, 'ana', 'modal', 'ask', 1, { fields: { titulo: 'Sin respuesta', intento: 'x' } });
  await component(doubts, 'luis', 'modal', 'ask', 1, { fields: { titulo: 'Con respuesta', intento: 'x' } });
  const [silent, answered] = dudas.createdThreads;
  logMessage(ctx.db, { id: '900', channelId: answered.id, authorId: 'ana', authorName: 'ana', content: 'prueba esto', attachments: '', createdAt: Date.now() });

  await doubts.tick(ctx, Date.now() + 11 * HOUR);
  assert.equal(silent.sent.length, 0);
  await doubts.tick(ctx, Date.now() + 12 * HOUR + MINUTE);
  await doubts.tick(ctx, Date.now() + 13 * HOUR);
  assert.equal(silent.sent.length, 1, 'un solo aviso');
  assert.match(textOf(silent.sent[0].payload), /<@profe> esta duda lleva 12 horas sin respuesta/);
  assert.equal(answered.sent.length, 0);

  const select = fakeInteraction(ctx, { kind: 'select', customId: 'doubts:helper:1', values: ['luis'], member: fakeMember('ana'), admin: false });
  await createRouter([doubts], ctx)(select);
  assert.match(textOf(select.replies[0]), /<@luis> se lleva un punto/);
});

test('dudas: sugiere el bloque de código una vez al día y solo en canales de grupo', async () => {
  const { ctx, dudas } = await classroom();
  ctx.client = Object.assign(new EventEmitter(), ctx.client);
  doubts.register(ctx.client, ctx);
  const replies = [];
  const say = async (channel, content) => {
    ctx.client.emit(Events.MessageCreate, { guildId: 'g1', system: false, author: { id: 'ana', bot: false }, channel, content, reply: async (payload) => replies.push(payload) });
    await flush();
  };
  const code = 'def suma(a, b):\n    return a + b\nprint(suma(1, 2))';
  await say(fakeChannel('general'), code);
  await say(dudas, 'hola, tengo una duda');
  assert.equal(replies.length, 0);
  await say(dudas, code);
  await say(dudas, code);
  assert.equal(replies.length, 1);
  assert.match(textOf(replies[0]), /\\`\\`\\`py/);
});

test('avisos por privado: solo a quien los activa, 1 h y 10 min antes, con el enlace', async () => {
  const { ctx, group, avisos, students, command } = await classroom();
  const on = await command(notifications, 'ana', 'avisos', 'activar');
  assert.match(textOf(on.replies[0]), /privado de prueba/);
  assert.equal(students.ana.user.dms.length, 1);

  await assert.rejects(
    weekly.onCommand(fakeInteraction(ctx, { command: 'aviso-semanal', sub: 'programar', options: { nombre: 'Python', dia: 1, hora: '18:00', canal: avisos, enlace: 'meet.google.com/abc' } }), ctx),
    /http/,
  );
  const options = { nombre: 'Python', dia: 1, hora: '18:00', canal: avisos, rol: { id: group.role_id }, enlace: 'https://meet.google.com/abc' };
  await weekly.onCommand(fakeInteraction(ctx, { command: 'aviso-semanal', sub: 'programar', options }), ctx);

  // Lunes 05/10/2026 18:00 en Madrid = 16:00 UTC.
  const start = Date.UTC(2026, 9, 5, 16, 0);
  await tickClasses(ctx, start - 61 * MINUTE);
  assert.equal(students.ana.user.dms.length, 1);
  await tickClasses(ctx, start - 60 * MINUTE);
  await tickClasses(ctx, start - 59 * MINUTE);
  assert.equal(students.ana.user.dms.length, 2);
  assert.match(students.ana.user.dms[1], /\*\*Python\*\* empieza <t:\d+:R>, a las <t:\d+:t> en tu hora\.\nEnlace: https:\/\/meet\.google\.com\/abc/);
  assert.equal(avisos.sent.length, 0, 'el aviso del canal sale a los 10 minutos');

  await tickClasses(ctx, start - 10 * MINUTE);
  await tickClasses(ctx, start - 9 * MINUTE);
  assert.equal(students.ana.user.dms.length, 3);
  assert.match(textOf(avisos.sent[0].payload), /Enlace: https:\/\/meet\.google\.com\/abc/);
  assert.deepEqual(students.luis.user.dms, [], 'quien no los activó no recibe nada');

  await command(notifications, 'ana', 'avisos', 'desactivar');
  await tickClasses(ctx, start + 7 * 24 * HOUR - 60 * MINUTE);
  assert.equal(students.ana.user.dms.length, 3);
});

test('avisos por privado: si el bot arranca tarde solo envía un recordatorio', async () => {
  const { ctx, group, avisos, students, command } = await classroom();
  await command(notifications, 'ana', 'avisos', 'activar');
  await weekly.onCommand(fakeInteraction(ctx, { command: 'aviso-semanal', sub: 'programar', options: { nombre: 'Python', dia: 1, hora: '18:00', canal: avisos, rol: { id: group.role_id } } }), ctx);
  await tickClasses(ctx, Date.UTC(2026, 9, 5, 16, 0) - 5 * MINUTE);
  assert.equal(students.ana.user.dms.length, 2);
});

test('asistencia: palabra clave, resumen en avisos y privado a quien faltó', async () => {
  const { ctx, avisos, students, command } = await classroom();
  await command(notifications, 'luis', 'avisos', 'activar');

  await assert.rejects(command(attendance, 'ana', 'sesion', 'abrir', { palabra: 'tortuga' }), /Solo el profesor/);
  await assert.rejects(command(attendance, 'profe', 'sesion', 'abrir', { palabra: 'tortuga' }, fakeChannel('general')), /en un canal del grupo/);
  await assert.rejects(command(attendance, 'ana', 'asistencia', null, { palabra: 'tortuga' }), /no hay ninguna clase abierta/);
  await assert.rejects(command(attendance, 'profe', 'sesion', 'cerrar'), /No hay ninguna clase abierta/);

  await command(attendance, 'profe', 'sesion', 'abrir', { palabra: ' Tortuga ' });
  await assert.rejects(command(attendance, 'profe', 'sesion', 'abrir', { palabra: 'otra' }), /Ya hay una clase abierta/);
  await assert.rejects(command(attendance, 'ana', 'asistencia', null, { palabra: 'liebre' }), /no es la palabra/);
  await command(attendance, 'ana', 'asistencia', null, { palabra: 'TORTUGA' });
  await command(attendance, 'ana', 'asistencia', null, { palabra: 'tortuga' });
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM attendance').get().n, 1);

  const closed = await command(attendance, 'profe', 'sesion', 'cerrar', { grabacion: 'https://video/1', recursos: 'Diapositivas en el canal' });
  assert.match(textOf(closed.replies[0]), /asistieron 1 de 2\. Faltaron: <@luis>/);
  const summary = embedOf(avisos.sent[0].payload);
  assert.deepEqual(summary.fields.map((f) => f.value), ['1 de 2 alumnos', 'https://video/1', 'Diapositivas en el canal']);
  assert.match(students.luis.user.dms.at(-1), /Te perdiste la clase de \*\*Python · Octubre\*\*[\s\S]*https:\/\/video\/1/);
  assert.deepEqual(students.ana.user.dms, []);
});

test('entregas: ejercicio, hilo privado con el profesor, rehacer y aprobar', async () => {
  const { ctx, avisos, entregas, command, component } = await classroom();
  await assert.rejects(command(coursework, 'ana', 'ejercicio', 'crear', { titulo: 'Listas' }), /Solo el profesor/);
  await assert.rejects(command(coursework, 'profe', 'ejercicio', 'crear', { titulo: 'Listas', fecha_limite: 'pronto' }), /Fecha no válida/);
  await command(coursework, 'profe', 'ejercicio', 'crear', { titulo: 'Listas', descripcion: 'Suma una lista', fecha_limite: '01/01/2099 10:00' });
  await command(coursework, 'profe', 'ejercicio', 'crear', { titulo: 'Agenda', proyecto_final: true });
  assert.equal(embedOf(avisos.sent[0].payload).title, '📝 Listas');
  assert.equal(embedOf(avisos.sent[1].payload).title, '🎓 Proyecto final: Agenda');
  assert.equal(avisos.sent[0].payload.components[0].toJSON().components[0].custom_id, 'coursework:submit:1');

  await assert.rejects(component(coursework, 'intruso', 'button', 'submit', 1), /Solo los alumnos del grupo/);
  const start = await component(coursework, 'ana', 'button', 'submit', 1);
  assert.equal(start.modal.toJSON().custom_id, 'coursework:send:1');

  const sent = await component(coursework, 'ana', 'modal', 'send', 1, { fields: { entrega: 'https://github.com/ana/listas', comentario: 'Me costó' } });
  const [thread] = entregas.createdThreads;
  assert.equal(thread.options.type, ChannelType.PrivateThread);
  assert.deepEqual(thread.addedMembers, ['ana', 'profe']);
  assert.match(textOf(sent.replies[0]), new RegExp(thread.id));
  const post = thread.sent[0];
  assert.equal(textOf(post.payload), '<@profe>');
  assert.equal(embedOf(post.payload).description, 'https://github.com/ana/listas');
  assert.deepEqual(post.payload.components[0].toJSON().components.map((c) => c.custom_id), ['coursework:approve:1', 'coursework:redo:1']);

  const review = (who, kind, action, extra = {}) => component(coursework, who, kind, action, 1, { channel: thread, message: { embeds: post.payload.embeds, edit: post.edit }, ...extra });
  await assert.rejects(review('luis', 'button', 'approve'), /Solo el profesor/);
  const redo = await review('profe', 'button', 'redo');
  assert.equal(redo.modal.toJSON().custom_id, 'coursework:feedback:1');
  const feedback = await review('profe', 'modal', 'feedback', { fields: { comentario: 'Falta el caso de lista vacía' } });
  assert.match(textOf(feedback.replies[0]), /<@ana> 🔁 hay que rehacer \*\*Listas\*\*\.\n> Falta el caso de lista vacía/);
  assert.deepEqual(post.payload.components, []);
  await assert.rejects(review('profe', 'button', 'approve'), /ya está corregida/);

  // Segunda entrega: mismo hilo, vuelve a estar pendiente.
  await component(coursework, 'ana', 'modal', 'send', 1, { fields: { entrega: 'https://github.com/ana/listas/v2' } });
  assert.equal(entregas.createdThreads.length, 1);
  assert.equal(embedOf(thread.sent[1].payload).title, '📤 Nueva entrega: Listas');
  const approved = await component(coursework, 'profe', 'button', 'approve', 1, { channel: thread, message: { embeds: thread.sent[1].payload.embeds } });
  assert.equal(embedOf(approved.replies[0]).fields.at(-1).value, '✅ Aprobado por <@profe>');
  assert.match(textOf(approved.replies[1]), /<@ana> tu entrega de \*\*Listas\*\* está aprobada/);
  await assert.rejects(component(coursework, 'ana', 'button', 'submit', 1), /Ya tienes este ejercicio aprobado/);

  const mine = await command(coursework, 'ana', 'mi-progreso');
  assert.equal(embedOf(mine.replies[0]).description, '<@ana>\n\n✅ Listas\n▫️ Proyecto final: Agenda');
  assert.equal(embedOf(mine.replies[0]).fields[0].value, '0 de 0 clases');
  const other = await command(coursework, 'profe', 'mi-progreso', null, { alumno: { id: 'luis' } });
  assert.match(embedOf(other.replies[0]).description, /^<@luis>\n\n▫️ Listas — hasta <t:\d+:d>\n▫️ Proyecto final: Agenda$/);
  await assert.rejects(command(coursework, 'ana', 'mi-progreso', null, { alumno: { id: 'luis' } }), /Solo el profesor/);
  const list = await command(coursework, 'luis', 'ejercicio', 'lista');
  assert.match(embedOf(list.replies[0]).description, /📝 \*\*Listas\*\* — hasta .*\n🎓 \*\*Proyecto final: Agenda\*\*/);
  assert.equal(ctx.db.prepare('SELECT status FROM submissions').get().status, 'approved');
});

// Clases cerradas en las que solo asistió quien se indica.
function pastSessions(ctx, groupId, attendees) {
  attendees.forEach((present, index) => {
    const { lastInsertRowid } = ctx.db
      .prepare("INSERT INTO class_sessions (group_id, keyword, opened_by, opened_at, closed_at) VALUES (?, 'x', 'profe', ?, ?)")
      .run(groupId, 1000 + index, 2000 + index);
    for (const userId of present) ctx.db.prepare('INSERT INTO attendance (session_id, user_id, at) VALUES (?, ?, 1)').run(Number(lastInsertRowid), userId);
  });
}

test('radar: detecta faltas y ejercicios vencidos, e informa los lunes', async () => {
  const { ctx, mod, group, students, command } = await classroom();
  const now = Date.UTC(2026, 9, 5, 7, 30); // lunes 09:30 en Madrid
  assert.deepEqual(buildRadar(ctx.db, now), []);

  pastSessions(ctx, group.id, [['ana', 'luis'], ['ana'], ['ana']]);
  assert.deepEqual(riskReasons(progressOf(ctx.db, group.id, 'luis'), now), ['faltó a las 2 últimas clases']);
  assert.deepEqual(riskReasons(progressOf(ctx.db, group.id, 'ana'), now), []);

  for (const title of ['A', 'B']) {
    ctx.db.prepare("INSERT INTO exercises (group_id, title, due_at, created_by, created_at) VALUES (?, ?, ?, 'profe', 1)").run(group.id, title, now - HOUR);
  }
  ctx.db.prepare("INSERT INTO submissions (exercise_id, user_id, content, submitted_at) VALUES (1, 'luis', 'x', 1)").run();
  assert.deepEqual(riskReasons(progressOf(ctx.db, group.id, 'ana'), now), ['2 ejercicios vencidos sin entregar']);
  assert.deepEqual(riskReasons(progressOf(ctx.db, group.id, 'luis'), now), ['faltó a las 2 últimas clases'], 'con una entrega ya no son 2 vencidos');

  ctx.settings.set('role_supervisor', 'r-super');
  await command(notifications, 'luis', 'avisos', 'activar');
  await radar.tick(ctx, now - 24 * HOUR); // domingo
  await radar.tick(ctx, now - HOUR); // lunes 08:30
  assert.equal(mod.sent.length, 0);
  await radar.tick(ctx, now);
  await radar.tick(ctx, now + HOUR);
  assert.equal(mod.sent.length, 1, 'un informe por semana');
  assert.equal(textOf(mod.sent[0].payload), '<@&r-super>');
  assert.equal(embedOf(mod.sent[0].payload).description, '**Python · Octubre**\n<@ana>: 2 ejercicios vencidos sin entregar\n<@luis>: faltó a las 2 últimas clases');
  assert.match(students.luis.user.dms.at(-1), /faltó a las 2 últimas clases[\s\S]*estamos para ayudarte/);
  assert.deepEqual(students.ana.user.dms, [], 'sin avisos activados no hay privado');

  await assert.rejects(command(radar, 'ana', 'radar'), /Solo el staff/);
  const manual = await radar.onCommand(fakeInteraction(ctx, { command: 'radar' }), ctx);
  assert.equal(manual, undefined);
});

test('graduación: requisitos, certificado verificable y siguiente curso', async () => {
  const { ctx, group, avisos, students, command } = await classroom();
  ctx.settings.set('role_graduate', 'r-grad');
  const alumno = (id) => ({ alumno: userOption(students[id]) });

  assert.deepEqual(missingRequirements({ exercises: [], sessions: [], attended: [] }), []);
  pastSessions(ctx, group.id, [['ana'], ['ana'], ['ana', 'luis'], []]);
  ctx.db.prepare("INSERT INTO exercises (group_id, title, is_final, created_by, created_at) VALUES (?, 'Agenda', 1, 'profe', 1)").run(group.id);
  ctx.db.prepare("INSERT INTO submissions (exercise_id, user_id, content, status, submitted_at) VALUES (1, 'ana', 'x', 'approved', 1)").run();

  await assert.rejects(command(graduation, 'ana', 'graduar', null, alumno('ana')), /Solo el profesor/);
  await assert.rejects(command(graduation, 'profe', 'graduar', null, { alumno: { id: 'intruso' } }), /no está matriculada/);
  await assert.rejects(command(graduation, 'profe', 'graduar', null, alumno('luis')), /proyecto final sin aprobar \(Agenda\); asistencia de 1 de 4 clases \(mínimo 70 %\)/);

  const done = await command(graduation, 'profe', 'graduar', null, alumno('ana'));
  const [code] = textOf(done.replies[0]).match(/CERT-[A-Z2-9]{4}-[A-Z2-9]{4}/);
  assert.deepEqual(students.ana.actions, [['role', 'r-grad']]);
  const announcement = embedOf(avisos.sent[0].payload);
  assert.equal(announcement.description, '<@ana> ha completado **Python**.');
  assert.equal(announcement.fields.at(-1).value, 'SQL', 'siguiente curso del pack Backend Starter');
  await assert.rejects(command(graduation, 'profe', 'graduar', null, alumno('ana')), new RegExp(`ya está graduado.*${code}`));

  const forced = await command(graduation, 'profe', 'graduar', null, { ...alumno('luis'), forzar: true });
  assert.match(textOf(forced.replies[0]), /<@luis> graduado/);

  const check = (codigo) => command(graduation, 'cualquiera', 'certificado', 'verificar', { codigo });
  assert.match(textOf((await check(code.toLowerCase())).replies[0]), /✅ Certificado auténtico de <@ana>: \*\*Python\*\* \(Octubre\)/);
  assert.match(textOf((await check('CERT-ZZZZ-9999')).replies[0]), /No existe/);
  assert.match(textOf((await check('hola')).replies[0]), /No existe/);
  assert.match(textOf((await command(graduation, 'ana', 'certificado', 'mios')).replies[0]), new RegExp(`🎓 \\*\\*Python\\*\\* \\(Octubre\\).*${code}`));
  assert.match(textOf((await command(graduation, 'cualquiera', 'certificado', 'mios')).replies[0]), /no tienes certificados/);
});
