import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, ChannelType } from 'discord.js';
import { onDutyId } from '../src/duty.js';
import applications from '../src/modules/applications.js';
import config from '../src/modules/config.js';
import { logMessage } from '../src/modules/messageLog.js';
import staffing, { computeWorkload } from '../src/modules/staffing.js';
import tickets from '../src/modules/tickets.js';
import { registerConfig, registerTicketKind, registry } from '../src/registry.js';
import { createRouter } from '../src/router.js';
import { startScheduler } from '../src/scheduler.js';
import { addSanction, sendModLog } from '../src/sanctions.js';
import { isEnabled } from '../src/settings.js';
import { embedOf, fakeChannel, fakeCtx, fakeInteraction, fakeMember, textOf } from './helpers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup() {
  const mod = fakeChannel('mod');
  const logs = fakeChannel('logs');
  const category = fakeChannel('cat', ChannelType.GuildCategory);
  const ctx = fakeCtx([mod, logs, category]);
  for (const [key, value] of [['role_staff', 'r-staff'], ['role_supervisor', 'r-super'], ['channel_mod', 'mod'], ['channel_logs', 'logs'], ['category_tickets', 'cat']]) {
    ctx.settings.set(key, value);
  }
  ctx.guild.roles.cache.set('r-super', {});
  const openTicket = async (kind, userId = 'u1', fields = { titulo: 'Acceso', descripcion: 'No puedo entrar a un canal', pasos: '' }) => {
    await tickets.onComponent(fakeInteraction(ctx, { kind: 'modal', userId, admin: false, fields }), ctx, 'submit', kind);
    return ctx.created.at(-1);
  };
  const press = (action, id, userId, roles, channel) =>
    tickets.onComponent(fakeInteraction(ctx, { kind: 'button', userId, admin: false, roles, channel }), ctx, action, String(id));
  return { ctx, mod, logs, openTicket, press };
}

test('tickets: los tres tipos del núcleo llegan a su equipo', async () => {
  const { ctx, logs, openTicket, press } = setup();
  const panel = fakeChannel('soporte');
  await tickets.onCommand(fakeInteraction(ctx, { command: 'tickets', sub: 'panel', channel: panel }), ctx);
  const labels = panel.sent[0].payload.components.flatMap((row) => row.toJSON().components.map((c) => c.label));
  assert.deepEqual(labels.slice(0, 3), ['Reportar bug', 'Pedir ayuda', 'Reportar a un usuario']);
  for (const kind of registry.ticketKinds.keys()) {
    const open = fakeInteraction(ctx, { kind: 'button', userId: 'nuevo', admin: false });
    await tickets.onComponent(open, ctx, 'open', kind);
    assert.equal(open.modal.toJSON().custom_id, `tickets:submit:${kind}`, `el formulario de "${kind}" es válido`);
  }

  const ayuda = await openTicket('soporte');
  assert.equal(ayuda.options.name, 'ayuda-1');
  assert.deepEqual(ayuda.options.permissionOverwrites.map((o) => o.id), ['everyone', 'u1', 'bot', 'r-staff']);
  assert.equal(embedOf(ayuda.sent[0].payload).title, '💬 Consulta #1: Acceso');
  await press('claim', 1, 'mod', ['r-staff'], ayuda);
  await press('close', 1, 'mod', ['r-staff'], ayuda);
  assert.equal(logs.sent[0].payload.files[0].name, 'ayuda-1.txt');
  assert.match(textOf(logs.sent[0].payload), /💬 Consulta #1: Acceso, de <@u1>, cerrado por <@mod>/);
  assert.deepEqual({ ...ctx.db.prepare('SELECT status, closed_by FROM tickets WHERE id = 1').get() }, { status: 'closed', closed_by: 'mod' });

  const reporte = await openTicket('report', 'u2', { titulo: 'Pepe#1234', descripcion: 'Me insulta', pasos: '' });
  assert.deepEqual(reporte.options.permissionOverwrites.map((o) => o.id), ['everyone', 'u2', 'bot', 'r-super']);
  await assert.rejects(press('claim', 2, 'mod', ['r-staff'], reporte), /No tienes permiso/);
  await press('close', 2, 'jefa', ['r-super'], reporte);
  assert.equal(logs.sent.length, 1, 'un reporte no deja transcripción');

  // Un tipo desconocido (panel antiguo, extensión retirada) se trata como bug.
  const raro = await openTicket('inventado', 'u3');
  assert.equal(raro.options.name, 'bug-3');
});

test('tickets: una extensión puede añadir tipos con su propio equipo', async (t) => {
  const { ctx, openTicket, press } = setup();
  registerTicketKind('ventas', {
    button: 'Ventas',
    style: ButtonStyle.Primary,
    help: '🛒 **Ventas:** pedidos y facturas.',
    prefix: 'venta',
    roles: ['role_sales', 'role_supervisor'],
    modalTitle: 'Ventas',
    labels: ['Pedido', '¿Qué necesitas?', 'Detalles'],
    heading: (ticket) => `🛒 Venta #${ticket.id}: ${ticket.title}`,
    author: 'Cliente',
    steps: 'Detalles',
    color: 0x57f287,
  });
  t.after(() => registry.ticketKinds.delete('ventas'));

  const panel = fakeChannel('soporte');
  await tickets.onCommand(fakeInteraction(ctx, { command: 'tickets', sub: 'panel', channel: panel }), ctx);
  assert.match(embedOf(panel.sent[0].payload).description, /Ventas:\*\* pedidos y facturas/);
  assert.ok(panel.sent[0].payload.components.flatMap((row) => row.toJSON().components).some((c) => c.custom_id === 'tickets:open:ventas'));

  // Sin el rol de ventas configurado, pasa al siguiente de la lista: los supervisores.
  const venta = await openTicket('ventas');
  assert.deepEqual(venta.options.permissionOverwrites.map((o) => o.id), ['everyone', 'u1', 'bot', 'r-super']);
  await assert.rejects(press('claim', 1, 'mod', ['r-staff'], venta), /No tienes permiso/);
  await press('claim', 1, 'jefa', ['r-super'], venta);
});

test('tickets: aviso a las 12 h sin respuesta y escalado a las 20 h', async () => {
  const { ctx, mod, openTicket, press } = setup();
  const now = Date.now();
  // Jueves de guardia para "jefa": 08/10/2026 es jueves.
  const thursday = Date.UTC(2026, 9, 8, 10, 0);
  ctx.db.prepare("INSERT INTO duty (weekday, user_id) VALUES (4, 'jefa')").run();
  assert.equal(onDutyId(ctx, thursday), 'jefa');
  assert.equal(onDutyId(ctx, thursday + DAY), null);

  const silent = await openTicket('soporte', 'u1');
  const answered = await openTicket('soporte', 'u2');
  const claimed = await openTicket('bug', 'u3');
  const report = await openTicket('report', 'u4', { titulo: 'Pepe#1234', descripcion: 'Me insulta', pasos: '' });
  ctx.db.prepare('UPDATE tickets SET created_at = ?').run(thursday - 12 * HOUR);
  logMessage(ctx.db, { id: 'r1', channelId: answered.id, authorId: 'mod', authorName: 'mod', content: 'Te cuento', attachments: '', createdAt: thursday - 11 * HOUR });
  logMessage(ctx.db, { id: 'r2', channelId: silent.id, authorId: 'u1', authorName: 'u1', content: '¿hola?', attachments: '', createdAt: thursday - 10 * HOUR });
  await press('claim', 3, 'mod', ['r-staff'], claimed);

  await tickets.tick(ctx, thursday - HOUR);
  assert.equal(silent.sent.length, 1, 'antes de las 12 h no hay aviso');
  await tickets.tick(ctx, thursday);
  await tickets.tick(ctx, thursday + HOUR);
  assert.equal(silent.sent.length, 2, 'un solo aviso; los mensajes de quien abrió el ticket no cuentan como respuesta');
  assert.equal(textOf(silent.sent[1].payload), '<@jefa> <@&r-staff> ⏰ este ticket lleva 12 horas sin respuesta.');
  assert.deepEqual(silent.sent[1].payload.allowedMentions, { roles: ['r-staff'], users: ['jefa'] });
  assert.equal(answered.sent.length, 1);
  assert.equal(claimed.sent.length, 1);
  assert.equal(ctx.db.prepare('SELECT first_response_at FROM tickets WHERE id = 2').get().first_response_at, thursday - 11 * HOUR);
  assert.ok(ctx.db.prepare('SELECT first_response_at FROM tickets WHERE id = 3').get().first_response_at >= now);

  await tickets.tick(ctx, thursday + 8 * HOUR);
  await tickets.tick(ctx, thursday + 9 * HOUR);
  const escalations = mod.sent.map((m) => textOf(m.payload));
  assert.equal(escalations.length, 2, 'una escalada por ticket');
  assert.match(escalations[0], /<@&r-super> 🚨 \*\*💬 Consulta #1: Acceso\*\* \(<#created-1>\) lleva 20 horas sin respuesta/);
  assert.match(escalations[1], /\*\*Reporte confidencial #4\*\*/);
  assert.equal(escalations[1].includes('Pepe'), false, 'la escalada de un reporte no dice a quién se reporta');
});

test('guardias: asignar, ver, quitar y mención en las alertas', async () => {
  const { ctx, mod } = setup();
  const run = (sub, options = {}, extra = {}) => {
    const interaction = fakeInteraction(ctx, { command: 'guardia', sub, options, ...extra });
    return staffing.onCommand(interaction, ctx).then(() => interaction);
  };
  const staff = { admin: false, roles: ['r-staff'] };

  await assert.rejects(run('asignar', { dia: 1, persona: { id: 'ana' } }, staff), /administradores/);
  await assert.rejects(run('ver', {}, { admin: false }), /Solo el staff/);
  for (let day = 0; day < 7; day++) await run('asignar', { dia: day, persona: { id: day === 1 ? 'ana' : 'luis' } });
  await run('asignar', { dia: 2, persona: { id: 'marta' } });
  const view = await run('ver', {}, staff);
  assert.match(embedOf(view.replies[0]).description, /^\*\*lunes:\*\* <@ana>\n\*\*martes:\*\* <@marta>\n\*\*miércoles:\*\* <@luis>/);

  await sendModLog(ctx, { content: 'alerta', allowedMentions: { parse: [] } }, { notifyDuty: true });
  await sendModLog(ctx, { content: 'informe' });
  assert.match(textOf(mod.sent[0].payload), /^<@(ana|luis|marta)> alerta$/);
  assert.equal(mod.sent[0].payload.allowedMentions.users.length, 1);
  assert.equal(textOf(mod.sent[1].payload), 'informe');

  for (let day = 0; day < 7; day++) await run('quitar', { dia: day });
  await sendModLog(ctx, { content: 'alerta' }, { notifyDuty: true });
  assert.equal(textOf(mod.sent[2].payload), 'alerta');
  assert.match(embedOf((await run('ver', {}, staff)).replies[0]).footer.text, /Hoy no hay nadie de guardia/);
});

test('carga del staff: trabajo por persona y plazos de los tickets', async () => {
  const { ctx, mod } = setup();
  const { db } = ctx;
  const now = Date.UTC(2026, 9, 5, 7, 30); // lunes 09:30 en Madrid
  const ticket = (createdAgo, responseAfter, closedBy, userId = 'u1') =>
    db.prepare("INSERT INTO tickets (user_id, kind, title, description, created_at, first_response_at, closed_at, closed_by, status) VALUES (?, 'bug', 't', 'd', ?, ?, ?, ?, ?)")
      .run(userId, now - createdAgo, responseAfter === null ? null : now - createdAgo + responseAfter, closedBy ? now - HOUR : null, closedBy, closedBy ? 'closed' : 'open');
  ticket(2 * DAY, 2 * HOUR, 'mod');
  ticket(3 * DAY, 30 * HOUR, 'mod');
  ticket(2 * DAY, null, null);
  ticket(DAY / 2, 4 * HOUR, 'u1'); // cerrado por quien lo abrió
  ticket(20 * DAY, HOUR, 'mod'); // abierto fuera del periodo: no cuenta en los plazos, pero cerrarlo sí es trabajo de esta semana
  addSanction(db, { userId: 'x', moderatorId: 'mod', type: 'warn', reason: 'r', now: now - DAY });
  addSanction(db, { userId: 'x', moderatorId: 'otra', type: 'warn', reason: 'r', now: now - DAY });
  addSanction(db, { userId: 'x', moderatorId: 'bot', type: 'timeout', reason: 'auto', now: now - DAY });

  const { people, tickets: sla } = computeWorkload(db, now - 7 * DAY, now, 'bot');
  assert.equal(people.get('mod').tickets, 3);
  assert.equal(people.get('mod').sanctions, 1);
  assert.equal(people.get('otra').sanctions, 1);
  assert.equal(people.has('bot'), false, 'las sanciones automáticas no cuentan como trabajo de nadie');
  assert.equal(people.has('u1'), false);
  assert.deepEqual({ opened: sla.opened, average: sla.average, late: sla.late }, { opened: 4, average: 12 * HOUR, late: 2 });

  await assert.rejects(staffing.onCommand(fakeInteraction(ctx, { command: 'carga', admin: false }), ctx), /Solo el staff/);
  await staffing.tick(ctx, now - DAY);
  assert.equal(mod.sent.length, 0);
  await staffing.tick(ctx, now);
  await staffing.tick(ctx, now + HOUR);
  assert.equal(mod.sent.length, 1, 'un resumen por semana');
  const embed = embedOf(mod.sent[0].payload);
  assert.match(embed.description, /^<@mod> — 3 tickets · 1 sanciones.*\n<@otra> — 0 tickets · 1 sanciones/);
  assert.equal(embed.fields[0].value, '4 abiertos · primera respuesta en 12 h de media · 2 sin respuesta en 24 h');
});

test('postulaciones: formulario, votos del staff y decisión de un admin', async () => {
  const equipo = fakeChannel('equipo');
  const ctx = fakeCtx([equipo]);
  ctx.settings.set('role_staff', 'r-staff');
  const ana = fakeMember('ana');
  ctx.members.set('ana', ana);
  const fields = { puesto: 'Moderadora', experiencia: '3 años en otros servidores', disponibilidad: 'Tardes', motivo: 'Me gusta ayudar' };
  const component = (action, arg, extra) => {
    const interaction = fakeInteraction(ctx, { kind: 'button', message: null, ...extra });
    return applications.onComponent(interaction, ctx, action, arg === undefined ? undefined : String(arg)).then(() => interaction);
  };
  const asAna = { member: ana, admin: false };
  const staff = (userId) => ({ userId, admin: false, roles: ['r-staff'] });

  const panel = fakeChannel('info');
  await applications.onCommand(fakeInteraction(ctx, { command: 'postulaciones', sub: 'panel', channel: panel }), ctx);
  assert.equal(panel.sent[0].payload.components[0].toJSON().components[0].custom_id, 'applications:open');
  assert.equal((await component('open', undefined, asAna)).modal.toJSON().custom_id, 'applications:send');

  await assert.rejects(component('send', undefined, { ...asAna, kind: 'modal', fields }), /aún no están configuradas/);
  ctx.settings.set('channel_applications', 'equipo');
  const sent = await component('send', undefined, { ...asAna, kind: 'modal', fields });
  assert.match(textOf(sent.replies[0]), /te responderemos por mensaje privado/);
  const post = equipo.sent[0];
  assert.equal(embedOf(post.payload).title, '📨 Postulación #1: Moderadora');
  assert.deepEqual(post.payload.components.map((row) => row.toJSON().components.map((c) => c.custom_id)), [
    ['applications:up:1', 'applications:down:1'],
    ['applications:accept:1', 'applications:reject:1'],
  ]);
  await assert.rejects(component('open', undefined, asAna), /ya tienes una postulación/i);

  const votes = (interaction) => embedOf(interaction.replies[0]).fields[2].value;
  await assert.rejects(component('up', 1, { userId: 'curioso', admin: false }), /Solo el staff/);
  assert.equal(votes(await component('up', 1, staff('m1'))), '👍 1 · 👎 0');
  assert.equal(votes(await component('up', 1, staff('m2'))), '👍 2 · 👎 0');
  assert.equal(votes(await component('down', 1, staff('m2'))), '👍 1 · 👎 1', 'cambiar el voto no lo duplica');
  assert.equal(votes(await component('down', 1, staff('m2'))), '👍 1 · 👎 0', 'repetir el voto lo retira');

  await assert.rejects(component('accept', 1, staff('m1')), /administradores/);
  const accepted = await component('accept', 1, { userId: 'jefa', admin: true });
  assert.equal(embedOf(accepted.replies[0]).fields.at(-1).value, '✅ Aceptada por <@jefa>');
  assert.deepEqual(accepted.replies[0].components, []);
  assert.match(ana.user.dms[0], /Moderadora\*\* en \*\*Mi Servidor\*\* ha sido aceptada/);
  await assert.rejects(component('up', 1, staff('m1')), /ya está resuelta/);
  await assert.rejects(component('reject', 1, { userId: 'jefa', admin: true }), /ya está resuelta/);

  // Tras la decisión puede volver a postularse; si tiene los privados cerrados, se avisa a quien decide.
  await component('send', undefined, { ...asAna, kind: 'modal', fields });
  ana.user.send = async () => {
    throw new Error('Cannot send messages to this user');
  };
  const rejected = await component('reject', 2, { userId: 'jefa', admin: true });
  assert.equal(embedOf(rejected.replies[0]).fields.at(-1).value, '❌ Rechazada por <@jefa>');
  assert.match(textOf(rejected.replies[1]), /No he podido avisar a <@ana>/);
});

test('módulos: se activan y desactivan por servidor, salvo los imprescindibles', async () => {
  const ctx = fakeCtx();
  const ticked = [];
  const sorteos = { id: 'giveaways', name: 'Sorteos', commands: [{ name: 'sorteo' }], onCommand: async (i) => i.reply('sorteo'), tick: () => ticked.push('giveaways') };
  const copias = { id: 'backup', name: 'Copias de seguridad', required: true, tick: () => ticked.push('backup') };
  ctx.modules = [config, sorteos, copias];
  let refreshed = 0;
  ctx.refreshCommands = async () => refreshed++;
  const route = createRouter(ctx.modules, ctx);
  const run = async (sub, options = {}, extra = {}) => {
    const interaction = fakeInteraction(ctx, { command: 'config', sub, options, ...extra });
    await route(interaction);
    return interaction;
  };
  const useSorteo = async () => {
    const interaction = fakeInteraction(ctx, { command: 'sorteo', admin: false });
    await route(interaction);
    return textOf(interaction.replies[0]);
  };

  assert.match(embedOf((await run('modulos')).replies[0]).description, /`giveaways` · Sorteos — 🟢 activo\n`backup` · Copias de seguridad — 🔒 siempre activo/);
  assert.equal(await useSorteo(), 'sorteo');

  assert.match(textOf((await run('modulo', { accion: 'off', nombre: 'Giveaways' })).replies[0]), /Sorteos\*\* desactivado/);
  assert.equal(refreshed, 1, 'los comandos del servidor se vuelven a registrar');
  assert.equal(isEnabled(ctx.settings, sorteos), false);
  assert.match(await useSorteo(), /desactivada en este servidor/);
  assert.match(embedOf((await run('modulos')).replies[0]).description, /Sorteos — ⚪ desactivado/);

  // El planificador se salta los módulos desactivados.
  const timer = startScheduler(ctx.modules, ctx, 60_000);
  clearInterval(timer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ticked, ['backup']);

  assert.match(textOf((await run('modulo', { accion: 'off', nombre: 'backup' })).replies[0]), /no se puede desactivar/);
  assert.match(textOf((await run('modulo', { accion: 'off', nombre: 'nada' })).replies[0]), /No existe ningún módulo/);
  assert.match(textOf((await run('modulo', { accion: 'on', nombre: 'giveaways' }, { admin: false })).replies[0]), /administradores/);
  await run('modulo', { accion: 'on', nombre: 'giveaways' });
  assert.equal(await useSorteo(), 'sorteo');
});

test('config: una extensión puede añadir canales, roles y textos', async (t) => {
  // El comando ya construido no cambia; lo que se comprueba es que el registro se usa al asignar y al mostrar.
  registerConfig({ roles: { ventas: { key: 'role_sales', label: 'Rol de ventas' } }, texts: { lema: { key: 'motto', label: 'Lema' } } });
  t.after(() => {
    registry.roles.delete('ventas');
    registry.texts.delete('lema');
  });
  const ctx = fakeCtx();
  const run = async (sub, options) => {
    const interaction = fakeInteraction(ctx, { command: 'config', sub, options });
    await config.onCommand(interaction, ctx);
    return interaction;
  };
  await run('rol', { tipo: 'ventas', rol: { id: 'r-ventas', toString: () => '<@&r-ventas>' } });
  await run('texto', { tipo: 'lema', texto: 'Aprender haciendo' });
  assert.equal(ctx.settings.get('role_sales'), 'r-ventas');
  const description = embedOf((await run('ver')).replies[0]).description;
  assert.match(description, /\*\*Rol de ventas:\*\* <@&r-ventas>/);
  assert.match(description, /\*\*Lema:\*\* Aprender haciendo/);
});
