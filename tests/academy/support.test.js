import '../../src/extensions/academy/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { allowedDomains } from '../../src/modules/automod.js';
import config from '../../src/modules/config.js';
import modules from '../../src/modules/index.js';
import privacy from '../../src/modules/privacy.js';
import { computeWorkload } from '../../src/modules/staffing.js';
import tickets from '../../src/modules/tickets.js';
import { checkSetup } from '../../src/setupCheck.js';
import { embedOf, fakeChannel, fakeCtx, fakeInteraction, textOf } from '../helpers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test('la extensión se carga sola y añade sus módulos, comandos y opciones de /config', () => {
  const ids = modules.map((mod) => mod.id);
  for (const id of ['enrollment', 'doubts', 'attendance', 'coursework', 'radar', 'graduation', 'onboarding', 'catalog', 'workshops', 'classDms']) {
    assert.ok(ids.includes(id), id);
  }
  const names = modules.flatMap((mod) => mod.commands ?? []).map((command) => command.toJSON().name);
  assert.equal(new Set(names).size, names.length, 'sin comandos repetidos entre el núcleo y la extensión');
  for (const name of ['grupo', 'matricular', 'canjear', 'duda', 'sesion', 'asistencia', 'ejercicio', 'mi-progreso', 'radar', 'graduar', 'certificado', 'intereses', 'cursos', 'taller', 'hosting', 'tiktok']) {
    assert.ok(names.includes(name), name);
  }
  for (const mod of modules) assert.ok(mod.name, `${mod.id} tiene nombre`);

  const options = Object.fromEntries(config.commands[0].toJSON().options.map((sub) => [sub.name, sub.options?.[0]?.choices?.map((choice) => choice.value)]));
  assert.ok(options.rol.includes('pagos') && options.rol.includes('graduado'));
  assert.ok(options.canal.includes('novedades'));
  assert.ok(options.texto.includes('patrocinador'));
});

test('valores propios de la academia: textos, sitios permitidos, privacidad y roles', async () => {
  const ctx = fakeCtx();
  assert.match(ctx.settings.get('reminder_text'), /tenemos cursos/);
  assert.equal(ctx.settings.get('reminder_title'), '📚 Nuestros cursos');
  assert.ok(allowedDomains(ctx.db).includes('innovateacademy.site'));

  ctx.db.prepare("INSERT INTO enrollments (group_id, user_id, source, enrolled_at) VALUES (1, 'ana', 'staff', 1)").run();
  const mine = fakeInteraction(ctx, { command: 'mis-datos', userId: 'ana', admin: false });
  await privacy.onCommand(mine, ctx);
  assert.match(embedOf(mine.replies[0]).description, /Matrículas en grupos:\*\* 1/);

  // /config revisar vigila también la posición del rol de graduado.
  ctx.settings.set('role_graduate', 'r-borrado');
  const guild = { ...ctx.guild, members: { me: { permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } } } };
  assert.ok(checkSetup(guild, ctx).includes('El rol de graduado configurado ya no existe.'));
});

test('tickets de la academia: pagos y reembolsos solo para su equipo; dudas de curso para el staff', async () => {
  const logs = fakeChannel('logs');
  const category = fakeChannel('cat', ChannelType.GuildCategory);
  const ctx = fakeCtx([logs, category]);
  for (const [key, value] of [['role_staff', 'r-staff'], ['role_supervisor', 'r-super'], ['role_billing', 'r-pagos'], ['channel_logs', 'logs'], ['category_tickets', 'cat']]) {
    ctx.settings.set(key, value);
  }
  for (const role of ['r-super', 'r-pagos']) ctx.guild.roles.cache.set(role, {});
  const openTicket = async (kind, userId = 'u1', fields = { titulo: 'Python', descripcion: 'No me llegó el acceso', pasos: '' }) => {
    await tickets.onComponent(fakeInteraction(ctx, { kind: 'modal', userId, admin: false, fields }), ctx, 'submit', kind);
    return ctx.created.at(-1);
  };
  const press = (action, id, userId, roles, channel) =>
    tickets.onComponent(fakeInteraction(ctx, { kind: 'button', userId, admin: false, roles, channel }), ctx, action, String(id));

  const panel = fakeChannel('soporte');
  await tickets.onCommand(fakeInteraction(ctx, { command: 'tickets', sub: 'panel', channel: panel }), ctx);
  const rows = panel.sent[0].payload.components.map((row) => row.toJSON().components.map((c) => c.label));
  assert.deepEqual(rows, [['Reportar bug', 'Pedir ayuda', 'Reportar a un usuario', 'Duda de un curso', 'Problema con un pago'], ['Reembolso']]);
  for (const kind of ['curso', 'pago', 'reembolso']) {
    const open = fakeInteraction(ctx, { kind: 'button', userId: 'nuevo', admin: false });
    await tickets.onComponent(open, ctx, 'open', kind);
    assert.equal(open.modal.toJSON().custom_id, `tickets:submit:${kind}`, 'el formulario de cada tipo es válido');
  }

  const pago = await openTicket('pago');
  assert.equal(pago.options.name, 'pago-1');
  assert.deepEqual(pago.options.permissionOverwrites.map((o) => o.id), ['everyone', 'u1', 'bot', 'r-pagos']);
  assert.equal(embedOf(pago.sent[0].payload).title, '💳 Pago #1: Python');
  await assert.rejects(press('claim', 1, 'mod', ['r-staff'], pago), /No tienes permiso/);
  await press('claim', 1, 'cobros', ['r-pagos'], pago);
  await press('close', 1, 'cobros', ['r-pagos'], pago);
  assert.equal(logs.sent.length, 0, 'los tickets de pagos no dejan transcripción');

  // Sin rol de pagos configurado, los reembolsos pasan a los supervisores.
  ctx.settings.unset('role_billing');
  const reembolso = await openTicket('reembolso');
  assert.deepEqual(reembolso.options.permissionOverwrites.map((o) => o.id), ['everyone', 'u1', 'bot', 'r-super']);

  const curso = await openTicket('curso', 'u2', { titulo: 'JavaScript', descripcion: '¿Hay grupo de tarde?', pasos: '' });
  assert.deepEqual(curso.options.permissionOverwrites.map((o) => o.id), ['everyone', 'u2', 'bot', 'r-staff']);
  await press('close', 3, 'mod', ['r-staff'], curso);
  assert.equal(logs.sent[0].payload.files[0].name, 'curso-3.txt');
  assert.match(textOf(logs.sent[0].payload), /🎓 Curso #3: JavaScript, de <@u2>, cerrado por <@mod>/);
});

test('carga del staff: cuenta también entregas corregidas y dudas resueltas', () => {
  const { db } = fakeCtx();
  const now = Date.now();
  db.prepare("INSERT INTO submissions (exercise_id, user_id, content, status, reviewed_by, submitted_at, reviewed_at) VALUES (1, 'a', 'x', 'approved', 'profe', 1, ?)").run(now - DAY);
  db.prepare("INSERT INTO doubts (group_id, user_id, title, attempt, channel_id, status, helper_id, created_at, resolved_at) VALUES (1, 'a', 't', 'x', 'c', 'resolved', 'profe', 1, ?)").run(now - DAY);
  db.prepare("INSERT INTO doubts (group_id, user_id, title, attempt, channel_id, status, helper_id, created_at, resolved_at) VALUES (1, 'a', 't', 'x', 'c', 'resolved', 'profe', 1, ?)").run(now - 30 * DAY);
  const { people } = computeWorkload(db, now - 7 * DAY, now, 'bot');
  assert.deepEqual(Object.fromEntries(people), { profe: { tickets: 0, sanctions: 0, reviews: 1, doubts: 1 } });
});
