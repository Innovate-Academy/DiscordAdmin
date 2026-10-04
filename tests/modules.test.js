import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import modules from '../src/modules/index.js';
import config from '../src/modules/config.js';
import events from '../src/modules/events.js';
import giveaways from '../src/modules/giveaways.js';
import classes from '../src/modules/weekly.js';
import tasks from '../src/modules/tasks.js';
import tickets from '../src/modules/tickets.js';
import levels, { awardXp } from '../src/modules/levels.js';
import messageLog, { logDelete, logEdit, logMessage, purgeOlderThan, searchMessages } from '../src/modules/messageLog.js';
import { createRouter } from '../src/router.js';
import { UserError } from '../src/util.js';
import { embedOf, fakeChannel, fakeCtx, fakeInteraction, textOf } from './helpers.js';

const MINUTE = 60_000;
const CORE_COMMANDS = [
  'advertir', 'automod', 'aviso-semanal', 'avisos', 'banear', 'borrar-mis-datos', 'carga', 'config', 'desilenciar', 'estado',
  'evento', 'expulsar', 'guardia', 'historial', 'invitar', 'mis-datos', 'nivel', 'postulaciones', 'proyecto', 'raid', 'registro',
  'reto', 'silenciar', 'sorteo', 'stats', 'tarea', 'tickets', 'top', 'verificacion',
];

test('comandos: se serializan, nombres únicos y cada módulo sabe atenderlos', () => {
  const names = [];
  for (const mod of modules) {
    assert.ok(mod.id, 'cada módulo tiene id');
    for (const command of mod.commands ?? []) {
      names.push(command.toJSON().name);
      assert.equal(typeof mod.onCommand, 'function', `${mod.id} atiende /${command.name}`);
    }
  }
  assert.equal(new Set(names).size, names.length);
  for (const name of CORE_COMMANDS) assert.ok(names.includes(name), name);
  for (const mod of modules) assert.ok(mod.name, `${mod.id} tiene nombre`);
  assert.equal(new Set(modules.map((mod) => mod.id)).size, modules.length);
});

test('router: un UserError llega como respuesta privada y otros servidores se ignoran', async () => {
  const ctx = fakeCtx();
  const route = createRouter(modules, ctx);

  const bad = fakeInteraction(ctx, { command: 'config', sub: 'web', options: { url: 'miweb.com' } });
  await route(bad);
  assert.match(textOf(bad.replies[0]), /http/);
  assert.equal(ctx.settings.get('web_url'), null);

  const good = fakeInteraction(ctx, { command: 'config', sub: 'web', options: { url: 'https://miweb.com/cursos' } });
  await route(good);
  assert.equal(ctx.settings.get('web_url'), 'https://miweb.com/cursos');

  const other = fakeInteraction(ctx, { command: 'config', sub: 'web', options: { url: 'https://otra.com' } });
  other.guildId = 'otro';
  await route(other);
  assert.equal(other.replies.length, 0);
  assert.equal(ctx.settings.get('web_url'), 'https://miweb.com/cursos');
});

test('config: solo admins, valida la categoría de tickets y muestra la configuración', async () => {
  const ctx = fakeCtx();
  const call = (sub, options, admin = true) => config.onCommand(fakeInteraction(ctx, { sub, options, admin }), ctx);

  await assert.rejects(call('ver', {}, false), UserError);
  await assert.rejects(call('canal', { tipo: 'tickets', canal: fakeChannel('c1', ChannelType.GuildText) }), UserError);
  await call('canal', { tipo: 'tickets', canal: fakeChannel('cat', ChannelType.GuildCategory) });
  await call('canal', { tipo: 'general', canal: fakeChannel('c1', ChannelType.GuildText) });
  await call('rol', { tipo: 'staff', rol: { id: 'r-staff', toString: () => '<@&r-staff>' } });
  await call('nivel-rol', { nivel: 5, rol: { id: 'r5', toString: () => '<@&r5>' } });
  await call('recordatorio', { cada: 50 });
  await assert.rejects(call('zona', { zona: 'Marte/Olimpo' }), UserError);
  assert.equal(ctx.settings.get('category_tickets'), 'cat');
  assert.equal(ctx.settings.get('role_staff'), 'r-staff');
  assert.equal(ctx.settings.getNumber('reminder_every'), 50);

  const ver = fakeInteraction(ctx, { sub: 'ver' });
  await config.onCommand(ver, ctx);
  const description = embedOf(ver.replies[0]).description;
  assert.match(description, /<#c1>/);
  assert.match(description, /nivel 5 → <@&r5>/);
});

test('niveles: XP con espera y subida de nivel', () => {
  const { db } = fakeCtx();
  const first = awardXp(db, 'u1', 1000, () => 0);
  assert.deepEqual(first, { xp: 15, level: 0, leveledUp: false });
  assert.equal(awardXp(db, 'u1', 1000 + 30_000, () => 0), null);
  db.prepare('UPDATE levels SET xp = 90 WHERE user_id = ?').run('u1');
  const second = awardXp(db, 'u1', 1000 + 60_000, () => 0);
  assert.deepEqual(second, { xp: 105, level: 1, leveledUp: true });
});

test('niveles: /nivel y /top', async () => {
  const ctx = fakeCtx();
  awardXp(ctx.db, 'u1', 1000, () => 0.99);
  awardXp(ctx.db, 'u2', 1000, () => 0);
  const user = { id: 'u2', displayName: 'Ana', displayAvatarURL: () => 'https://cdn.example/a.png' };
  const nivel = fakeInteraction(ctx, { command: 'nivel', options: { usuario: user } });
  await levels.onCommand(nivel, ctx);
  const fields = embedOf(nivel.replies[0]).fields;
  assert.equal(fields[1].value, '#2');
  assert.equal(fields[2].value, '15 / 100 XP');

  const top = fakeInteraction(ctx, { command: 'top' });
  await levels.onCommand(top, ctx);
  assert.match(embedOf(top.replies[0]).description, /^\*\*1\.\*\* <@u1>/);
});

test('registro: guarda, edita, borra, busca y purga', async () => {
  const ctx = fakeCtx();
  const { db } = ctx;
  const base = { channelId: 'c1', authorId: 'u1', authorName: 'ana', attachments: '' };
  logMessage(db, { ...base, id: '1', content: 'hola mundo', createdAt: 1000 });
  logMessage(db, { ...base, id: '2', content: '100% seguro', createdAt: 2000, authorId: 'u2' });
  logMessage(db, { ...base, id: '1', content: 'duplicado', createdAt: 1000 });

  assert.equal(logEdit(db, '1', 'hola mundo', 3000), false, 'sin cambios no se registra edición');
  assert.equal(logEdit(db, '1', 'adiós', 3000), true);
  assert.equal(logEdit(db, 'no-existe', 'x', 3000), false);
  logDelete(db, '2', 4000);

  assert.deepEqual(searchMessages(db).map((m) => m.id), ['2', '1']);
  assert.deepEqual(searchMessages(db, { userId: 'u2' }).map((m) => m.id), ['2']);
  assert.deepEqual(searchMessages(db, { text: '100%' }).map((m) => m.id), ['2']);
  assert.deepEqual(searchMessages(db, { text: '%' }).map((m) => m.id), ['2'], 'el % se busca literal');
  assert.equal(searchMessages(db, { channelId: 'otro' }).length, 0);
  const [edited] = searchMessages(db, { userId: 'u1' });
  assert.equal(edited.content, 'adiós');
  assert.equal(edited.edited_at, 3000);
  assert.equal(db.prepare('SELECT old_content FROM message_edits WHERE message_id = ?').get('1').old_content, 'hola mundo');
  assert.equal(searchMessages(db, { userId: 'u2' })[0].deleted_at, 4000);

  const buscar = fakeInteraction(ctx, { command: 'registro', sub: 'buscar' });
  await messageLog.onCommand(buscar, ctx);
  assert.match(embedOf(buscar.replies[0]).description, /<@u2> \*\(borrado\)\*: 100% seguro/);
  await assert.rejects(messageLog.onCommand(fakeInteraction(ctx, { command: 'registro', sub: 'buscar', admin: false }), ctx), UserError);

  assert.equal(purgeOlderThan(db, 1500), 1);
  assert.deepEqual(searchMessages(db).map((m) => m.id), ['2']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_edits').get().n, 0);
});

test('eventos: crear, apuntarse, aviso previo y cancelar', async () => {
  const channel = fakeChannel('eventos');
  const ctx = fakeCtx([channel]);
  const create = (options, extra = {}) => events.onCommand(fakeInteraction(ctx, { command: 'evento', sub: 'crear', options, ...extra }), ctx);
  const valid = { titulo: 'Directo', fecha: '01/01/2099 18:00', descripcion: 'Preguntas y respuestas' };

  await assert.rejects(create(valid, { admin: false }), UserError, 'solo staff');
  await assert.rejects(create(valid), /canal de eventos/);
  ctx.settings.set('channel_events', 'eventos');
  await assert.rejects(create({ ...valid, fecha: 'mañana' }), /Fecha no válida/);
  await assert.rejects(create({ ...valid, fecha: '01/01/2020 18:00' }), /futura/);

  await create(valid);
  const event = ctx.db.prepare('SELECT * FROM events').get();
  assert.equal(event.discord_event_id, 'native-1');
  assert.equal(event.message_id, channel.sent[0].id);
  assert.equal(embedOf(channel.sent[0].payload).fields[2].value, '0');

  const toggle = () => fakeInteraction(ctx, { kind: 'button', customId: `events:toggle:${event.id}`, userId: 'u7' });
  const join = toggle();
  await events.onComponent(join, ctx, 'toggle', String(event.id));
  assert.equal(embedOf(join.replies[0]).fields[2].value, '1');
  const leave = toggle();
  await events.onComponent(leave, ctx, 'toggle', String(event.id));
  assert.equal(embedOf(leave.replies[0]).fields[2].value, '0');
  await events.onComponent(toggle(), ctx, 'toggle', String(event.id));

  await events.tick(ctx, event.starts_at - 16 * MINUTE);
  assert.equal(channel.sent.length, 1, 'aún no toca avisar');
  await events.tick(ctx, event.starts_at - 15 * MINUTE);
  assert.match(textOf(channel.sent[1].payload), /Directo/);
  assert.equal(textOf(channel.sent[2].payload), '<@u7>');
  await events.tick(ctx, event.starts_at - 14 * MINUTE);
  assert.equal(channel.sent.length, 3, 'solo avisa una vez');

  const list = fakeInteraction(ctx, { command: 'evento', sub: 'lista' });
  await events.onCommand(list, ctx);
  assert.match(embedOf(list.replies[0]).description, /Directo.*1 inscritos/);

  await events.onCommand(fakeInteraction(ctx, { command: 'evento', sub: 'cancelar', options: { id: event.id } }), ctx);
  assert.match(embedOf(channel.sent[0].payload).title, /CANCELADO/);
  await assert.rejects(events.onComponent(toggle(), ctx, 'toggle', String(event.id)), UserError);
});

test('eventos: si el bot estuvo apagado no avisa tarde', async () => {
  const channel = fakeChannel('eventos');
  const ctx = fakeCtx([channel]);
  ctx.db.prepare('INSERT INTO events (title, description, starts_at, channel_id) VALUES (?, ?, ?, ?)').run('Viejo', 'x', 1_000_000, 'eventos');
  await events.tick(ctx, 1_000_000 + 60 * MINUTE);
  assert.equal(channel.sent.length, 0);
  assert.equal(ctx.db.prepare('SELECT reminded FROM events').get().reminded, 1);
});

test('sorteos: crear, participar, terminar y repetir', async () => {
  const channel = fakeChannel('general');
  const ctx = fakeCtx([channel]);
  const create = (options, extra = {}) => giveaways.onCommand(fakeInteraction(ctx, { command: 'sorteo', sub: 'crear', options, channel, ...extra }), ctx);

  await assert.rejects(create({ premio: 'Curso', duracion: '1h' }, { admin: false }), UserError);
  await assert.rejects(create({ premio: 'Curso', duracion: 'un rato' }), /Duración no válida/);
  await create({ premio: 'Curso', duracion: '1h' });
  const giveaway = ctx.db.prepare('SELECT * FROM giveaways').get();
  assert.equal(giveaway.winners, 1);
  assert.equal(giveaway.message_id, channel.sent[0].id);

  const join = (userId) => giveaways.onComponent(fakeInteraction(ctx, { kind: 'button', userId }), ctx, 'join', String(giveaway.id));
  await join('u1');
  await join('u2');
  await join('u2');
  assert.deepEqual(ctx.db.prepare('SELECT user_id FROM giveaway_entries').all().map((r) => r.user_id), ['u1']);

  await giveaways.tick(ctx, giveaway.ends_at - 1);
  assert.equal(channel.sent.length, 1);
  await giveaways.tick(ctx, giveaway.ends_at);
  assert.match(textOf(channel.sent[1].payload), /<@u1>.*Curso/);
  assert.equal(embedOf(channel.sent[0].payload).fields.at(-1).value, '<@u1>');
  assert.equal(channel.sent[0].payload.components[0].toJSON().components[0].disabled, true);
  await giveaways.tick(ctx, giveaway.ends_at + MINUTE);
  assert.equal(channel.sent.length, 2, 'no se repite');
  await assert.rejects(join('u3'), UserError);

  await giveaways.onCommand(fakeInteraction(ctx, { command: 'sorteo', sub: 'repetir', options: { id: giveaway.id }, channel }), ctx);
  assert.match(textOf(channel.sent[2].payload), /<@u1>/);
});

test('sorteos: sin participantes', async () => {
  const channel = fakeChannel('general');
  const ctx = fakeCtx([channel]);
  ctx.db.prepare('INSERT INTO giveaways (prize, winners, ends_at, channel_id) VALUES (?, ?, ?, ?)').run('Nada', 2, 1000, 'general');
  await giveaways.tick(ctx, 2000);
  assert.match(textOf(channel.sent[0].payload), /sin participantes/);
});

test('clases: programar, avisar una vez por semana y borrar', async () => {
  const channel = fakeChannel('clases');
  const ctx = fakeCtx([channel]);
  const call = (sub, options, extra = {}) => classes.onCommand(fakeInteraction(ctx, { command: 'clase', sub, options, ...extra }), ctx);

  await assert.rejects(call('programar', { nombre: 'JS', dia: 1, hora: '25:00', canal: channel }), /Hora no válida/);
  await call('programar', { nombre: 'JS', dia: 1, hora: '18:00', canal: channel, rol: { id: 'r-js' } });

  // Lunes 05/10/2026 18:00 en Madrid = 16:00 UTC.
  const start = Date.UTC(2026, 9, 5, 16, 0);
  await classes.tick(ctx, start - 11 * MINUTE);
  assert.equal(channel.sent.length, 0);
  await classes.tick(ctx, start - 10 * MINUTE);
  await classes.tick(ctx, start - 9 * MINUTE);
  assert.equal(channel.sent.length, 1);
  assert.match(textOf(channel.sent[0].payload), /^<@&r-js> .*JS/);
  assert.deepEqual(channel.sent[0].payload.allowedMentions.roles, ['r-js']);
  await classes.tick(ctx, start + 7 * 86_400_000 - 10 * MINUTE);
  assert.equal(channel.sent.length, 2);

  const list = fakeInteraction(ctx, { command: 'clase', sub: 'lista' });
  await classes.onCommand(list, ctx);
  assert.match(embedOf(list.replies[0]).description, /JS.*lunes 18:00/);
  await call('borrar', { id: 1 });
  await assert.rejects(call('borrar', { id: 1 }), UserError);
});

test('tareas: crear, vencer, completar con botón y borrar', async () => {
  const channel = fakeChannel('tareas');
  const ctx = fakeCtx([channel]);
  ctx.settings.set('channel_tasks', 'tareas');
  ctx.settings.set('role_staff', 'r-staff');
  const call = (sub, options, extra = {}) => tasks.onCommand(fakeInteraction(ctx, { command: 'tarea', sub, options, ...extra }), ctx);

  await assert.rejects(call('crear', { titulo: 'X' }, { admin: false }), UserError, 'solo staff');
  await assert.rejects(call('crear', { titulo: 'X' }), /rol o una persona/);
  await assert.rejects(call('crear', { titulo: 'X', persona: { id: 'u5' }, fecha_limite: 'pronto' }), /Fecha no válida/);
  await call('crear', { titulo: 'Revisar curso', persona: { id: 'u5' }, fecha_limite: '01/01/2099 10:00' }, { admin: false, roles: ['r-staff'] });
  await call('crear', { titulo: 'Moderar', rol: { id: 'r-mod' } });

  const [first, second] = ctx.db.prepare('SELECT * FROM tasks ORDER BY id').all();
  assert.equal(textOf(channel.sent[0].payload), '<@u5>');
  assert.deepEqual(channel.sent[1].payload.allowedMentions, { roles: ['r-mod'], users: [] });

  await tasks.tick(ctx, first.due_at - 1);
  assert.equal(channel.sent.length, 2);
  await tasks.tick(ctx, first.due_at);
  await tasks.tick(ctx, first.due_at + MINUTE);
  assert.equal(channel.sent.length, 3, 'avisa una sola vez del vencimiento');
  assert.match(textOf(channel.sent[2].payload), /<@u5>.*Revisar curso.*vencido/);

  const button = (userId, roles = []) => fakeInteraction(ctx, { kind: 'button', userId, roles, admin: false });
  await assert.rejects(tasks.onComponent(button('u9'), ctx, 'done', String(first.id)), /Solo el staff/);
  const done = button('u5');
  await tasks.onComponent(done, ctx, 'done', String(first.id));
  assert.equal(embedOf(done.replies[0]).fields[2].value, 'Hecha');
  assert.equal(done.replies[0].components.length, 0);
  await assert.rejects(tasks.onComponent(button('u5'), ctx, 'done', String(first.id)), /ya estaba hecha/);

  const list = fakeInteraction(ctx, { command: 'tarea', sub: 'lista' });
  await tasks.onCommand(list, ctx);
  assert.match(embedOf(list.replies[0]).description, /^\*\*#2 · Moderar\*\* — <@&r-mod>$/);

  await call('hecha', { id: second.id });
  assert.equal(embedOf(channel.sent[1].payload).fields[2].value, 'Hecha');
  await call('borrar', { id: second.id });
  assert.equal(channel.sent[1].deleted, true);
});

test('tickets: panel, formulario, canal privado, reclamar y cerrar con transcripción', async () => {
  const panel = fakeChannel('soporte');
  const logs = fakeChannel('logs');
  const category = fakeChannel('cat', ChannelType.GuildCategory);
  const ctx = fakeCtx([panel, logs, category]);
  ctx.settings.set('role_staff', 'r-staff');
  ctx.settings.set('channel_logs', 'logs');

  await tickets.onCommand(fakeInteraction(ctx, { command: 'tickets', sub: 'panel', channel: panel }), ctx);
  assert.equal(panel.sent[0].payload.components[0].toJSON().components[0].custom_id, 'tickets:open:bug');

  const open = fakeInteraction(ctx, { kind: 'button', userId: 'u1', admin: false });
  await tickets.onComponent(open, ctx, 'open');
  assert.equal(open.modal.toJSON().custom_id, 'tickets:submit:bug');

  const submit = () =>
    fakeInteraction(ctx, { kind: 'modal', userId: 'u1', admin: false, fields: { titulo: 'No carga', descripcion: 'Pantalla en blanco', pasos: '' } });
  await assert.rejects(tickets.onComponent(submit(), ctx, 'submit'), /no están configurados/);
  ctx.settings.set('category_tickets', 'cat');
  const sent = submit();
  await tickets.onComponent(sent, ctx, 'submit');

  const [channel] = ctx.created;
  assert.equal(channel.options.name, 'bug-1');
  assert.equal(channel.options.parent, 'cat');
  assert.deepEqual(channel.options.permissionOverwrites.map((o) => o.id), ['everyone', 'u1', 'bot', 'r-staff']);
  assert.match(textOf(sent.replies[0]), /<#created-1>/);
  assert.equal(embedOf(channel.sent[0].payload).title, '🐛 Bug #1: No carga');

  await assert.rejects(tickets.onComponent(fakeInteraction(ctx, { kind: 'button', userId: 'u1', admin: false }), ctx, 'open'), /Ya tienes un ticket abierto/);

  const inTicket = (userId, extra = {}) => fakeInteraction(ctx, { kind: 'button', userId, admin: false, channel, ...extra });
  await assert.rejects(tickets.onComponent(inTicket('u1'), ctx, 'claim', '1'), UserError, 'el autor no puede reclamar');
  const claim = inTicket('mod', { roles: ['r-staff'] });
  await tickets.onComponent(claim, ctx, 'claim', '1');
  assert.equal(embedOf(claim.replies[0]).fields.at(-1).value, '<@mod>');
  await assert.rejects(tickets.onComponent(inTicket('mod2', { roles: ['r-staff'] }), ctx, 'claim', '1'), /ya lo lleva/);

  logMessage(ctx.db, { id: '10', channelId: channel.id, authorId: 'u1', authorName: 'ana', content: 'sigue fallando', attachments: '', createdAt: 5000 });
  await assert.rejects(tickets.onComponent(inTicket('u9'), ctx, 'close', '1'), /Solo quien abrió/);
  await tickets.onComponent(inTicket('u1'), ctx, 'close', '1');
  assert.equal(ctx.db.prepare('SELECT status FROM tickets WHERE id = 1').get().status, 'closed');
  const file = logs.sent[0].payload.files[0];
  assert.equal(file.name, 'bug-1.txt');
  assert.match(file.attachment.toString('utf8'), /Ticket #1: No carga[\s\S]*ana: sigue fallando/);
});
