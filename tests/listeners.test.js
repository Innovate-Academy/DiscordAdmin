import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import welcome from '../src/modules/welcome.js';
import levels from '../src/modules/levels.js';
import webReminder from '../src/modules/webReminder.js';
import messageLog from '../src/modules/messageLog.js';
import { embedOf, fakeChannel, fakeCtx, textOf } from './helpers.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(channels) {
  const ctx = fakeCtx(channels);
  ctx.client = Object.assign(new EventEmitter(), ctx.client);
  for (const mod of [welcome, messageLog, levels, webReminder]) mod.register(ctx.client, ctx);
  return ctx;
}

let nextId = 1;
function fakeMessage(channel, { userId = 'u1', content = 'hola', bot = false, guildId = 'g1', rolesAdded = [] } = {}) {
  return {
    id: String(nextId++),
    guildId,
    channelId: channel.id,
    channel,
    content,
    system: false,
    partial: false,
    createdTimestamp: Date.now(),
    attachments: new Map(),
    author: { id: userId, bot, username: `user-${userId}`, toString: () => `<@${userId}>` },
    member: { roles: { cache: new Map(), add: async (roleId) => rolesAdded.push(roleId) } },
  };
}

test('mensajes: se registran, dan XP y disparan el recordatorio web cada N', async () => {
  const general = fakeChannel('general');
  const otro = fakeChannel('otro');
  const ctx = setup([general, otro]);
  ctx.settings.set('channel_general', 'general');
  ctx.settings.set('reminder_every', 3);
  ctx.settings.set('reminder_min_minutes', 0);

  const say = async (channel, options) => {
    ctx.client.emit(Events.MessageCreate, fakeMessage(channel, options));
    await flush();
  };

  for (let i = 0; i < 3; i++) await say(general);
  assert.equal(general.sent.length, 0, 'sin URL configurada no se anuncia ni se cuenta');

  ctx.settings.set('web_url', 'https://miweb.com/cursos');
  await say(general);
  await say(otro);
  await say(general, { bot: true });
  await say(general, { guildId: 'otro-servidor' });
  await say(general);
  assert.equal(general.sent.length, 0);
  await say(general);
  assert.equal(general.sent.length, 1);
  assert.equal(general.sent[0].payload.components[0].toJSON().components[0].url, 'https://miweb.com/cursos');
  assert.equal(ctx.db.prepare('SELECT count FROM counters').get().count, 0);

  // 3 sin URL + 3 en general + 1 en otro + 1 de bot; el de otro servidor no se registra.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 8);
  const xp = ctx.db.prepare('SELECT xp FROM levels WHERE user_id = ?').get('u1').xp;
  assert.ok(xp >= 15 && xp <= 25, 'solo el primer mensaje del minuto da XP');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM levels').get().n, 1, 'los bots no ganan XP');
});

test('niveles: al subir de nivel anuncia y da el rol de recompensa', async () => {
  const general = fakeChannel('general');
  const niveles = fakeChannel('niveles');
  const ctx = setup([general, niveles]);
  ctx.settings.set('channel_levels', 'niveles');
  ctx.db.prepare('INSERT INTO levels (user_id, xp, level, last_xp_at) VALUES (?, ?, ?, ?)').run('u1', 99, 0, 0);
  ctx.db.prepare('INSERT INTO level_rewards (level, role_id) VALUES (?, ?)').run(1, 'r-nivel1');
  ctx.db.prepare('INSERT INTO level_rewards (level, role_id) VALUES (?, ?)').run(5, 'r-nivel5');

  const rolesAdded = [];
  ctx.client.emit(Events.MessageCreate, fakeMessage(general, { rolesAdded }));
  await flush();
  assert.deepEqual(rolesAdded, ['r-nivel1']);
  assert.match(textOf(niveles.sent[0].payload), /<@u1> ha subido al \*\*nivel 1\*\*/);
  assert.equal(general.sent.length, 0);
});

test('registro: ediciones y borrados desde los eventos de Discord', async () => {
  const general = fakeChannel('general');
  const ctx = setup([general]);
  const message = fakeMessage(general, { content: 'primera versión' });
  ctx.client.emit(Events.MessageCreate, message);
  ctx.client.emit(Events.MessageUpdate, message, { ...message, content: 'segunda versión' });
  await flush();
  const row = ctx.db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id);
  assert.equal(row.content, 'segunda versión');
  assert.equal(row.author_name, 'user-u1');
  assert.equal(ctx.db.prepare('SELECT old_content FROM message_edits').get().old_content, 'primera versión');

  // Un mensaje anterior al bot que se edita queda registrado con su texto actual.
  const old = fakeMessage(general, { content: 'antiguo editado' });
  ctx.client.emit(Events.MessageUpdate, { id: old.id, partial: true }, old);
  await flush();
  assert.equal(ctx.db.prepare('SELECT content FROM messages WHERE id = ?').get(old.id).content, 'antiguo editado');

  ctx.client.emit(Events.MessageDelete, { id: message.id, guildId: 'g1', partial: true });
  ctx.client.emit(Events.MessageBulkDelete, new Map([[old.id, { id: old.id, guildId: 'g1' }]]));
  await flush();
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NOT NULL').get().n, 2);
});

test('bienvenida: mensaje con plantilla y rol automático', async () => {
  const bienvenida = fakeChannel('bienvenida');
  const ctx = setup([bienvenida]);
  const rolesAdded = [];
  const member = (bot = false) => ({
    guild: { id: 'g1', name: 'Mi Servidor', memberCount: 42 },
    user: { bot, displayAvatarURL: () => 'https://cdn.example/a.png' },
    displayName: 'Ana',
    roles: { add: async (roleId) => rolesAdded.push(roleId) },
    toString: () => '<@u1>',
  });

  ctx.client.emit(Events.GuildMemberAdd, member());
  await flush();
  assert.equal(bienvenida.sent.length, 0, 'sin canal configurado no hace nada');

  ctx.settings.set('channel_welcome', 'bienvenida');
  ctx.settings.set('role_auto', 'r-miembro');
  ctx.settings.set('welcome_text', 'Hola {usuario}, esto es {servidor} y somos {miembros}.');
  ctx.client.emit(Events.GuildMemberAdd, member());
  ctx.client.emit(Events.GuildMemberAdd, member(true));
  await flush();
  assert.deepEqual(rolesAdded, ['r-miembro']);
  assert.equal(bienvenida.sent.length, 1);
  assert.equal(textOf(bienvenida.sent[0].payload), '<@u1>');
  assert.equal(embedOf(bienvenida.sent[0].payload).description, 'Hola <@u1>, esto es Mi Servidor y somos 42.');
});
