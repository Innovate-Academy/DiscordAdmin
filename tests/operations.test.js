import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChannelType } from 'discord.js';
import { openDb } from '../src/db.js';
import { ROOT } from '../src/env.js';
import { registerMigrations, registry } from '../src/registry.js';
import { createErrorSink } from '../src/errorChannel.js';
import backup, { pruneBackups } from '../src/modules/backup.js';
import messageLog, { logMessage } from '../src/modules/messageLog.js';
import privacy, { eraseUserMessages } from '../src/modules/privacy.js';
import status from '../src/modules/status.js';
import tickets from '../src/modules/tickets.js';
import { addSanction } from '../src/sanctions.js';
import { reportError, setErrorSink } from '../src/util.js';
import { embedOf, fakeChannel, fakeCtx, fakeInteraction, textOf } from './helpers.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('migraciones: las de una extensión se aplican una vez, con copia previa si ya había datos', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'bot.db');
  openDb(path).close(); // base ya existente, de antes de instalar la extensión
  registerMigrations('prueba', ['CREATE TABLE prueba (id INTEGER PRIMARY KEY, nota TEXT)', "ALTER TABLE prueba ADD COLUMN extra TEXT NOT NULL DEFAULT 'x'"]);
  t.after(() => registry.migrations.delete('prueba'));

  const db = openDb(path);
  db.prepare("INSERT INTO prueba (nota) VALUES ('hola')").run();
  const { version } = db.prepare("SELECT version FROM schema_versions WHERE namespace = 'prueba'").get();
  db.close();
  assert.equal(version, 2);
  assert.ok(existsSync(join(dir, 'backups', 'antes-de-actualizar-prueba-v0.db')));

  // Abrirla otra vez no repite los pasos ni pierde datos.
  const again = openDb(path);
  const row = { ...again.prepare('SELECT nota, extra FROM prueba').get() };
  again.close();
  assert.deepEqual(row, { nota: 'hola', extra: 'x' });
});

test('migraciones: un paso que falla no se aplica a medias', (t) => {
  const path = join(tempDir(t), 'bot.db');
  // El segundo CREATE choca con una tabla del núcleo: todo el paso debe deshacerse.
  registerMigrations('rota', ['CREATE TABLE rota_a (id INTEGER); CREATE TABLE levels (id INTEGER);']);
  assert.throws(() => openDb(path), /already exists/);
  registry.migrations.delete('rota');

  const db = openDb(path);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_versions').get().n;
  db.close();
  assert.equal(tables.includes('rota_a'), false);
  assert.equal(versions, 0);
});

test('base de datos: dos copias del bot no pueden abrir la misma a la vez', (t) => {
  const path = join(tempDir(t), 'bot.db');
  const first = openDb(path);
  assert.throws(() => openDb(path), /locked/);
  first.prepare('SELECT COUNT(*) AS n FROM settings').get();
  first.close();
  // Al cerrarse la primera (o al morir su proceso), el bloqueo se libera.
  openDb(path).close();
});

test('/estado: solo staff, con datos de salud del bot', async () => {
  const ctx = fakeCtx();
  ctx.settings.set('last_backup', '2026-10-05');
  await assert.rejects(status.onCommand(fakeInteraction(ctx, { command: 'estado', admin: false }), ctx), /Solo el staff/);
  const interaction = fakeInteraction(ctx, { command: 'estado' });
  await status.onCommand(interaction, ctx);
  const fields = Object.fromEntries(embedOf(interaction.replies[0]).fields.map((field) => [field.name, field.value]));
  assert.match(fields.Encendido, /^<t:\d+:R>$/);
  assert.match(fields.Memoria, /^\d+\.\d MB$/);
  assert.equal(fields['Base de datos'], 'en memoria · 0 mensajes en el registro');
  assert.equal(fields['Última copia diaria'], '2026-10-05');
});

test('copias: una al día, y se conservan las 7 más recientes', (t) => {
  const dir = tempDir(t);
  const ctx = fakeCtx();
  ctx.dataDir = dir;
  ctx.db.prepare('INSERT INTO levels (user_id, xp, level) VALUES (?, ?, ?)').run('u1', 50, 0);

  const noon = Date.UTC(2026, 9, 5, 10, 0);
  backup.tick(ctx, noon);
  const file = join(dir, 'backups', 'bot-2026-10-05.db');
  assert.ok(existsSync(file));
  const copy = new DatabaseSync(file);
  assert.equal(copy.prepare('SELECT xp FROM levels').get().xp, 50);
  copy.close();

  rmSync(file);
  backup.tick(ctx, noon + 3_600_000);
  assert.equal(existsSync(file), false, 'el mismo día no se repite');
  backup.tick(ctx, noon + 86_400_000);
  assert.ok(existsSync(join(dir, 'backups', 'bot-2026-10-06.db')));

  for (let day = 10; day < 20; day++) writeFileSync(join(dir, 'backups', `bot-2026-11-${day}.db`), '');
  writeFileSync(join(dir, 'backups', 'antes-de-actualizar-v0.db'), '');
  pruneBackups(join(dir, 'backups'));
  const left = readdirSync(join(dir, 'backups')).sort();
  assert.deepEqual(left, ['antes-de-actualizar-v0.db', ...[13, 14, 15, 16, 17, 18, 19].map((day) => `bot-2026-11-${day}.db`)]);

  // Sin carpeta de datos (pruebas de otros módulos) no hace nada.
  backup.tick(fakeCtx(), noon);
});

test('privacidad: /mis-datos y /borrar-mis-datos', async () => {
  const ctx = fakeCtx();
  const { db } = ctx;
  const message = (id, authorId) => logMessage(db, { id, channelId: 'c1', authorId, authorName: authorId, content: `texto ${id}`, attachments: '', createdAt: 1_700_000_000_000 });
  message('1', 'u1');
  message('2', 'u1');
  message('3', 'u2');
  db.prepare('INSERT INTO message_edits (message_id, old_content, edited_at) VALUES (?, ?, ?)').run('1', 'antes', 5);
  db.prepare('INSERT INTO levels (user_id, xp, level) VALUES (?, ?, ?)').run('u1', 120, 1);
  addSanction(db, { userId: 'u1', moderatorId: 'mod', type: 'warn', reason: 'x' });

  const mine = fakeInteraction(ctx, { command: 'mis-datos', userId: 'u1', admin: false });
  await privacy.onCommand(mine, ctx);
  const description = embedOf(mine.replies[0]).description;
  assert.match(description, /Mensajes en el registro:\*\* 2/);
  assert.match(description, /Nivel:\*\* 1 \(120 XP\)/);
  assert.match(description, /Sanciones:\*\* 1/);
  assert.match(description, /a los 30 días/);

  const ask = fakeInteraction(ctx, { command: 'borrar-mis-datos', userId: 'u1', admin: false });
  await privacy.onCommand(ask, ctx);
  assert.equal(ask.replies[0].components[0].toJSON().components[0].custom_id, 'privacy:erase');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 3, 'nada se borra hasta confirmar');

  const confirm = fakeInteraction(ctx, { kind: 'button', userId: 'u1', admin: false });
  await privacy.onComponent(confirm, ctx, 'erase');
  assert.match(textOf(confirm.replies[0]), /borrado 2 mensajes/);
  assert.deepEqual(db.prepare('SELECT id FROM messages').all().map((row) => row.id), ['3']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_edits').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sanctions').get().n, 1, 'las sanciones se conservan');
  assert.equal(db.prepare('SELECT xp FROM levels').get().xp, 120, 'el nivel se conserva');
  assert.equal(eraseUserMessages(db, 'nadie'), 0);
});

test('registro: cada búsqueda queda anotada y se puede auditar', async () => {
  const ctx = fakeCtx();
  const run = (sub, options = {}, extra = {}) => {
    const interaction = fakeInteraction(ctx, { command: 'registro', sub, options, userId: 'admin1', ...extra });
    return messageLog.onCommand(interaction, ctx).then(() => interaction);
  };
  assert.match(textOf((await run('auditoria')).replies[0]), /Nadie ha consultado/);
  await run('buscar', { usuario: { id: 'u5' }, texto: 'secreto' });
  await run('buscar');
  const audit = embedOf((await run('auditoria')).replies[0]).description.split('\n');
  assert.equal(audit.length, 2);
  assert.match(audit[0], /<@admin1> buscó mensajes sin filtros$/);
  assert.match(audit[1], /<@admin1> buscó mensajes de <@u5> con "secreto"$/);
  await assert.rejects(run('auditoria', {}, { admin: false }));
});

test('errores: van al canal de logs, como mucho uno por minuto y sin rutas del ordenador', async (t) => {
  const logs = fakeChannel('logs');
  const ctx = fakeCtx([logs]);
  let time = 0;
  const sink = createErrorSink(ctx, { now: () => time });

  await sink('niveles', new Error('sin canal'));
  assert.equal(logs.sent.length, 0, 'sin canal de logs configurado no hace nada');

  ctx.settings.set('channel_logs', 'logs');
  time = 120_000;
  const err = new Error('algo falló');
  err.stack = `Error: algo falló\n    at ${join(ROOT, 'src', 'modules', 'levels.js')}:10:5`;
  await sink('niveles', err);
  await sink('niveles', err);
  await sink('niveles', err);
  assert.equal(logs.sent.length, 1);
  assert.match(textOf(logs.sent[0].payload), /Error en \*\*niveles\*\*\n/);
  assert.equal(textOf(logs.sent[0].payload).includes(ROOT), false);

  time += 60_000;
  await sink('eventos', 'texto suelto');
  assert.match(textOf(logs.sent[1].payload), /Error en \*\*eventos\*\* \(y 2 más desde el último aviso\)/);

  // reportError escribe en consola y además avisa al destino configurado.
  const seen = [];
  setErrorSink((label) => seen.push(label));
  t.after(() => setErrorSink(null));
  t.mock.method(console, 'error', () => {});
  reportError('prueba', new Error('x'));
  assert.deepEqual(seen, ['prueba']);
});

test('tickets: un reporte sobre un usuario es confidencial y solo lo atienden los supervisores', async () => {
  const panel = fakeChannel('soporte');
  const logs = fakeChannel('logs');
  const category = fakeChannel('cat', ChannelType.GuildCategory);
  const ctx = fakeCtx([panel, logs, category]);
  ctx.settings.set('role_staff', 'r-staff');
  ctx.settings.set('role_supervisor', 'r-super');
  ctx.settings.set('channel_logs', 'logs');
  ctx.settings.set('category_tickets', 'cat');
  ctx.guild.roles.cache.set('r-super', {});

  await tickets.onCommand(fakeInteraction(ctx, { command: 'tickets', sub: 'panel', channel: panel }), ctx);
  assert.deepEqual(panel.sent[0].payload.components[0].toJSON().components.map((c) => c.custom_id), ['tickets:open:bug', 'tickets:open:soporte', 'tickets:open:report']);

  const open = fakeInteraction(ctx, { kind: 'button', userId: 'u1', admin: false });
  await tickets.onComponent(open, ctx, 'open', 'report');
  assert.equal(open.modal.toJSON().custom_id, 'tickets:submit:report');
  assert.equal(open.modal.toJSON().title, 'Reportar a un usuario');

  const fields = { titulo: 'Pepe#1234', descripcion: 'Me insulta por privado', pasos: '' };
  await tickets.onComponent(fakeInteraction(ctx, { kind: 'modal', userId: 'u1', admin: false, fields }), ctx, 'submit', 'report');
  const [channel] = ctx.created;
  assert.equal(channel.options.name, 'reporte-1');
  assert.equal(channel.options.topic, 'Reporte confidencial #1', 'el nombre del reportado no va en el tema del canal');
  assert.deepEqual(channel.options.permissionOverwrites.map((o) => o.id), ['everyone', 'u1', 'bot', 'r-super'], 'el staff normal no lo ve');
  assert.equal(embedOf(channel.sent[0].payload).title, '🚩 Reporte #1 sobre Pepe#1234');
  assert.equal(ctx.db.prepare('SELECT kind FROM tickets').get().kind, 'report');

  // Tener un reporte abierto no impide abrir un bug, pero sí otro reporte.
  const bug = fakeInteraction(ctx, { kind: 'button', userId: 'u1', admin: false });
  await tickets.onComponent(bug, ctx, 'open', 'bug');
  assert.equal(bug.modal.toJSON().custom_id, 'tickets:submit:bug');
  await assert.rejects(tickets.onComponent(fakeInteraction(ctx, { kind: 'button', userId: 'u1', admin: false }), ctx, 'open', 'report'), /Ya tienes un ticket abierto/);

  const press = (action, userId, roles) => tickets.onComponent(fakeInteraction(ctx, { kind: 'button', userId, admin: false, roles, channel }), ctx, action, '1');
  await assert.rejects(press('claim', 'mod', ['r-staff']), /No tienes permiso/);
  await assert.rejects(press('close', 'mod', ['r-staff']), /Solo quien abrió/);
  await press('claim', 'jefa', ['r-super']);
  await press('close', 'jefa', ['r-super']);
  assert.equal(ctx.db.prepare('SELECT status FROM tickets').get().status, 'closed');
  assert.equal(logs.sent.length, 0, 'sin transcripción en el canal de logs');
});
