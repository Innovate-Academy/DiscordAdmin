import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, PermissionFlagsBits } from 'discord.js';
import { DEFAULT_ALLOWED_DOMAINS, DuplicateTracker, JoinWindow, evaluateMessage, extractHosts, isLookalike, normalizeDomain } from '../src/lib/automod.js';
import { formatDuration } from '../src/lib/dates.js';
import { getHistory } from '../src/sanctions.js';
import { checkSetup } from '../src/setupCheck.js';
import automod from '../src/modules/automod.js';
import config from '../src/modules/config.js';
import moderation from '../src/modules/moderation.js';
import verification from '../src/modules/verification.js';
import { UserError } from '../src/util.js';
import { embedOf, fakeChannel, fakeCtx, fakeInteraction, fakeMember, textOf, userOption } from './helpers.js';

const DAY = 86_400_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const types = (ctx, userId) => getHistory(ctx.db, userId).map((row) => row.type);

// ---------- lógica pura ----------

test('automod: solo cuenta como enlace lo que lo es de verdad', () => {
  assert.deepEqual(extractHosts('mira main.py, app.get("/cursos") y console.log(x)'), []);
  assert.deepEqual(extractHosts('https://www.GitHub.com/a/b y http://sub.ejemplo.com:8080/x?y=1'), ['github.com', 'sub.ejemplo.com']);
  assert.deepEqual(extractHosts('entra en www.ejemplo.com.'), ['ejemplo.com']);
  assert.deepEqual(extractHosts('únete discord.gg/abc123'), ['discord.gg']);
  assert.deepEqual(extractHosts('https://discord.com@estafa.ru/nitro'), ['estafa.ru'], 'el dominio real va tras la @');
});

test('automod: dominios que imitan a los oficiales', () => {
  for (const host of ['dlscord-nitro.com', 'disc0rd.gift', 'discordgift.site', 'free-nitro-drop.xyz', 'steancommunity.ru']) {
    assert.equal(isLookalike(host), true, host);
  }
  for (const host of ['discord.com', 'cdn.discordapp.com', 'discord.gg', 'steamcommunity.com', 'github.com', 'nitrotype.com']) {
    assert.equal(isLookalike(host), false, host);
  }
});

test('automod: reglas de un mensaje', () => {
  const check = (content, extra = {}) => evaluateMessage(content, { isNewMember: false, allowedDomains: DEFAULT_ALLOWED_DOMAINS, ...extra })?.rule ?? null;

  assert.equal(check('hola, ¿alguien me ayuda con este bucle?'), null);
  assert.equal(check('mirad https://github.com/yo/proyecto'), null);
  assert.equal(check('mi web https://mi-portfolio.dev'), null, 'un miembro antiguo puede compartir enlaces');
  assert.equal(check('mi web https://mi-portfolio.dev', { isNewMember: true }), 'link');
  assert.equal(check('docs https://developer.mozilla.org/es/docs', { isNewMember: true }), null);
  assert.equal(check('ojalá nitro gratis jaja'), null, 'sin enlace no es estafa');
  assert.equal(check('NITRO GRATIS aquí https://premios.xyz/claim'), 'scam');
  assert.equal(check('regalo robux en https://robux-ya.com'), 'scam');
  assert.equal(check('https://dlscord-nitro.com/gift'), 'scam');
  assert.equal(check('@everyone mirad https://oferta.ru'), 'scam');
  assert.equal(check('@everyone clase en https://meet.google.com/abc'), null);
  assert.equal(check('hola a todos', { mentionCount: 6 }), 'mentions');
  assert.equal(check('hola a todos', { mentionCount: 5 }), null);
});

test('automod: mismo mensaje en varios canales', () => {
  const tracker = new DuplicateTracker();
  const say = (channelId, now, content = 'compra seguidores baratos ahora') => tracker.add('u1', { content, channelId, messageId: `${channelId}-${now}`, now });
  assert.equal(say('a', 0), null);
  assert.equal(say('a', 1000), null, 'repetir en el mismo canal no cuenta');
  assert.equal(say('b', 2000), null);
  assert.deepEqual(say('c', 3000).map((m) => m.channelId), ['a', 'a', 'b', 'c']);
  assert.equal(say('a', 4000), null, 'tras detectar se reinicia');

  assert.equal(say('a', 100_000), null);
  assert.equal(say('b', 110_000), null);
  assert.equal(say('c', 140_000), null, 'fuera de la ventana de 30 s');
  assert.equal(tracker.add('u2', { content: 'hola', channelId: 'a', messageId: '1', now: 0 }), null, 'mensajes cortos se ignoran');
});

test('anti-raid: ventana de entradas, dominios y duraciones', () => {
  const joins = new JoinWindow();
  const options = { limit: 3, windowMs: 60_000 };
  assert.deepEqual([0, 1000, 2000].map((t) => joins.add(t, options)), [false, false, false]);
  assert.equal(joins.add(3000, options), true);
  assert.equal(new JoinWindow().add(0, options), false);
  assert.equal(joins.add(200_000, options), false, 'las entradas antiguas caducan');

  assert.equal(normalizeDomain(' https://www.Ejemplo.com/ruta?x=1 '), 'ejemplo.com');
  assert.equal(normalizeDomain('no es un dominio'), null);

  assert.equal(formatDuration(DAY), '1 d');
  assert.equal(formatDuration(90 * 60_000), '1 h 30 min');
  assert.equal(formatDuration(10 * 60_000), '10 min');
});

// ---------- sanciones ----------

function modSetup() {
  const mod = fakeChannel('mod');
  const ctx = fakeCtx([mod]);
  ctx.settings.set('channel_mod', 'mod');
  ctx.settings.set('role_staff', 'r-staff');
  const run = (command, options, extra = {}) => {
    const interaction = fakeInteraction(ctx, { command, options, admin: false, roles: ['r-staff'], userId: 'mod1', ...extra });
    return moderation.onCommand(interaction, ctx).then(() => interaction);
  };
  return { ctx, mod, run };
}

test('sanciones: solo staff, y nunca contra el staff, uno mismo o el bot', async () => {
  const { ctx, run } = modSetup();
  const target = fakeMember('u5');
  const motivo = 'Insultos';

  await assert.rejects(run('advertir', { usuario: userOption(target), motivo }, { roles: [] }), /Solo el staff/);
  await assert.rejects(run('advertir', { usuario: userOption(fakeMember('mod2', { roles: ['r-staff'] })), motivo }), /miembro del staff/);
  await assert.rejects(run('advertir', { usuario: userOption(fakeMember('jefa', { admin: true })), motivo }), /miembro del staff/);
  await assert.rejects(run('advertir', { usuario: userOption(fakeMember('mod1')), motivo }), /ti mismo/);
  await assert.rejects(run('banear', { usuario: userOption(fakeMember('bot')), motivo }), /mí mismo/);
  await assert.rejects(run('advertir', { usuario: { id: 'u8' }, motivo }), /ya no está en el servidor/);
  assert.deepEqual(types(ctx, 'u5'), []);
});

test('sanciones: tres advertencias en 30 días silencian 24 h', async () => {
  const { ctx, mod, run } = modSetup();
  const target = fakeMember('u5');
  const options = { usuario: userOption(target), motivo: 'Spam' };

  const first = await run('advertir', options);
  assert.match(textOf(first.replies[0]), /1 en los últimos 30 días/);
  assert.match(target.user.dms[0], /advertencia en \*\*Mi Servidor\*\*[\s\S]*Spam/);
  assert.equal(embedOf(mod.sent[0].payload).title, 'Advertencia');
  await run('advertir', options);
  assert.deepEqual(target.actions, []);

  const third = await run('advertir', options);
  assert.deepEqual(target.actions, [['timeout', DAY]]);
  assert.match(textOf(third.replies[0]), /silenciado 24 horas/);
  assert.deepEqual(types(ctx, 'u5'), ['timeout', 'warn', 'warn', 'warn']);
  assert.equal(getHistory(ctx.db, 'u5')[0].moderator_id, 'bot');

  // Las advertencias de hace más de 30 días ya no cuentan.
  ctx.db.prepare("UPDATE sanctions SET created_at = ? WHERE type = 'warn'").run(Date.now() - 31 * DAY);
  const later = await run('advertir', options);
  assert.match(textOf(later.replies[0]), /1 en los últimos 30 días\)\.$/);
});

test('sanciones: silenciar, desilenciar, expulsar, banear e historial', async () => {
  const { ctx, mod, run } = modSetup();
  const target = fakeMember('u5');
  const usuario = userOption(target);

  await assert.rejects(run('silenciar', { usuario, duracion: 'un rato', motivo: 'x' }), /Duración no válida/);
  await assert.rejects(run('silenciar', { usuario, duracion: '29d', motivo: 'x' }), /28 días/);
  await assert.rejects(run('silenciar', { usuario: userOption(fakeMember('u6', { moderatable: false })), duracion: '1h', motivo: 'x' }), /por encima del mío/);

  const muted = await run('silenciar', { usuario, duracion: '2h', motivo: 'Flood' });
  assert.match(textOf(muted.replies[0]), /silenciado 2 h/);
  assert.equal(embedOf(mod.sent[0].payload).fields[2].value, '2 h');
  await run('desilenciar', { usuario });
  await run('expulsar', { usuario, motivo: 'Reincidente' });
  assert.deepEqual(target.actions, [['timeout', 7_200_000], ['timeout', null], ['kick']]);
  assert.match(target.user.dms.at(-1), /expulsado/);

  // Banear a alguien que ya no está en el servidor: solo hay usuario.
  const gone = { id: 'u9', dms: [], send: async () => {} };
  await run('banear', { usuario: gone, motivo: 'Estafa', borrar_dias: 1 });
  assert.deepEqual(ctx.banned, [{ id: 'u9', reason: 'Estafa', deleteMessageSeconds: 86_400 }]);

  const history = await run('historial', { usuario });
  const description = embedOf(history.replies[0]).description;
  assert.match(description, /\*\*Expulsión\*\* por <@mod1>: Reincidente/);
  assert.match(description, /\*\*Silencio\*\* \(2 h\) por <@mod1>: Flood/);
  const empty = await run('historial', { usuario: { id: 'nadie' } });
  assert.match(embedOf(empty.replies[0]).description, /Sin sanciones/);
});

// ---------- filtro automático ----------

function automodSetup() {
  const mod = fakeChannel('mod');
  const channels = ['general', 'dudas', 'offtopic'].map((id) => fakeChannel(id));
  const ctx = fakeCtx([mod, ...channels]);
  ctx.client = Object.assign(new EventEmitter(), ctx.client);
  ctx.settings.set('channel_mod', 'mod');
  ctx.settings.set('role_staff', 'r-staff');
  automod.register(ctx.client, ctx);

  let nextId = 1;
  const say = async (member, content, channel = channels[0], mentions = 0) => {
    const message = {
      id: `msg${nextId++}`,
      guildId: 'g1',
      guild: ctx.guild,
      channelId: channel.id,
      channel,
      content,
      system: false,
      author: member.user,
      member,
      mentions: { users: new Map(Array.from({ length: mentions }, (_, i) => [`m${i}`, true])) },
      deleted: false,
      async delete() {
        message.deleted = true;
      },
    };
    ctx.client.emit(Events.MessageCreate, message);
    await flush();
    return message;
  };
  return { ctx, mod, channels, say };
}

test('filtro: una estafa se borra, silencia, queda en el historial y avisa al staff', async () => {
  const { ctx, mod, say } = automodSetup();
  const scammer = fakeMember('u5');
  ctx.members.set('u5', scammer);

  const message = await say(scammer, 'NITRO GRATIS para todos https://premios.xyz/claim');
  assert.equal(message.deleted, true);
  assert.deepEqual(scammer.actions, [['timeout', DAY]]);
  assert.deepEqual(types(ctx, 'u5'), ['timeout']);
  assert.equal(embedOf(mod.sent[0].payload).title, 'Silencio');
  const alert = mod.sent[1];
  assert.equal(embedOf(alert.payload).title, '🚨 Posible estafa');
  assert.match(embedOf(alert.payload).description, /NITRO GRATIS/);
  assert.deepEqual(alert.payload.components[0].toJSON().components.map((c) => c.custom_id), ['automod:ban:u5', 'automod:release:u5']);

  // Botones de la alerta: solo staff.
  const press = (action, extra = {}) => {
    const interaction = fakeInteraction(ctx, { kind: 'button', userId: 'mod1', admin: false, roles: ['r-staff'], message: { embeds: alert.payload.embeds }, ...extra });
    return automod.onComponent(interaction, ctx, action, 'u5').then(() => interaction);
  };
  await assert.rejects(press('ban', { roles: [] }), UserError);
  const released = await press('release');
  assert.deepEqual(scammer.actions.at(-1), ['timeout', null]);
  assert.equal(embedOf(released.replies[0]).fields.at(-1).value, 'Liberado por <@mod1>');
  assert.deepEqual(released.replies[0].components, []);
  await press('ban');
  assert.equal(ctx.banned[0].id, 'u5');
  assert.deepEqual(types(ctx, 'u5'), ['ban', 'untimeout', 'timeout']);
});

test('filtro: enlaces de miembros nuevos, exenciones y desactivación', async () => {
  const { ctx, mod, channels, say } = automodSetup();
  const nuevo = fakeMember('u1', { joinedDaysAgo: 1 });
  const veterano = fakeMember('u2', { joinedDaysAgo: 60 });
  const profe = fakeMember('u3', { joinedDaysAgo: 1, roles: ['r-staff'] });

  assert.equal((await say(nuevo, 'mi código: print("hola") en main.py')).deleted, false);
  assert.equal((await say(nuevo, 'https://github.com/yo/tarea')).deleted, false);
  assert.equal((await say(veterano, 'mi portfolio https://mi-portfolio.dev')).deleted, false);
  assert.equal((await say(profe, 'NITRO GRATIS https://premios.xyz')).deleted, false, 'el staff está exento');

  const blocked = await say(nuevo, 'mi portfolio https://mi-portfolio.dev');
  assert.equal(blocked.deleted, true);
  assert.match(textOf(channels[0].sent[0].payload), /<@u1>.*primeros 7 días/);
  assert.deepEqual(nuevo.actions, [], 'un enlace no permitido no se sanciona');
  assert.equal(mod.sent.length, 0);

  // Un dominio añadido por un admin deja de bloquearse.
  await automod.onCommand(fakeInteraction(ctx, { command: 'automod', sub: 'permitir', options: { dominio: 'https://www.mi-portfolio.dev/' } }), ctx);
  assert.equal((await say(nuevo, 'otra vez https://mi-portfolio.dev')).deleted, false);
  await assert.rejects(automod.onCommand(fakeInteraction(ctx, { command: 'automod', sub: 'quitar', options: { dominio: 'github.com' } }), ctx), /de serie/);
  await assert.rejects(automod.onCommand(fakeInteraction(ctx, { command: 'automod', sub: 'permitir', options: { dominio: 'hola' } }), ctx), /no parece un dominio/);

  assert.equal((await say(nuevo, 'hola a todos', channels[0], 6)).deleted, true);
  assert.equal(embedOf(mod.sent.at(-1).payload).title, '🚨 Menciones masivas');

  await automod.onCommand(fakeInteraction(ctx, { command: 'automod', sub: 'desactivar' }), ctx);
  assert.equal((await say(nuevo, 'NITRO GRATIS https://premios.xyz')).deleted, false);
});

test('filtro: el mismo mensaje en tres canales se borra de todos', async () => {
  const { mod, channels, say } = automodSetup();
  const spammer = fakeMember('u7');
  const text = 'vendo cuentas baratas, escríbeme por privado';
  const first = await say(spammer, text, channels[0]);
  const second = await say(spammer, text, channels[1]);
  assert.equal(first.deleted || second.deleted, false);
  const third = await say(spammer, text, channels[2]);
  assert.equal(third.deleted, true);
  assert.deepEqual(channels[0].deletedIds, [first.id]);
  assert.deepEqual(channels[1].deletedIds, [second.id]);
  assert.deepEqual(spammer.actions, [['timeout', DAY]]);
  assert.equal(embedOf(mod.sent.at(-1).payload).title, '🚨 Mismo mensaje en varios canales');
});

// ---------- verificación y anti-raid ----------

function verifySetup() {
  const mod = fakeChannel('mod');
  const normas = fakeChannel('normas');
  const ctx = fakeCtx([mod, normas]);
  ctx.client = Object.assign(new EventEmitter(), ctx.client);
  ctx.settings.set('channel_mod', 'mod');
  ctx.settings.set('role_staff', 'r-staff');
  verification.register(ctx.client, ctx);
  const accept = (member) => {
    const interaction = fakeInteraction(ctx, { kind: 'button', member, admin: false });
    return verification.onComponent(interaction, ctx, 'accept').then(() => interaction);
  };
  return { ctx, mod, normas, accept };
}

test('verificación: botón de normas, cuentas nuevas en revisión y decisión del staff', async () => {
  const { ctx, mod, normas, accept } = verifySetup();
  const panel = () => verification.onCommand(fakeInteraction(ctx, { command: 'verificacion', sub: 'panel', channel: normas }), ctx);
  await assert.rejects(panel(), /rol de verificado/);
  await assert.rejects(accept(fakeMember('u1')), /aún no está configurada/);
  ctx.settings.set('role_verified', 'r-ok');
  await panel();
  assert.equal(normas.sent[0].payload.components[0].toJSON().components[0].custom_id, 'verification:accept');

  const normal = fakeMember('u1');
  assert.match(textOf((await accept(normal)).replies[0]), /Ya puedes ver/);
  assert.deepEqual(normal.actions, [['role', 'r-ok']]);
  assert.match(textOf((await accept(normal)).replies[0]), /Ya estás verificado/);

  const reciente = fakeMember('u2', { accountDaysAgo: 2 });
  ctx.members.set('u2', reciente);
  assert.match(textOf((await accept(reciente)).replies[0]), /el staff revisará/);
  await accept(reciente);
  assert.deepEqual(reciente.actions, []);
  assert.equal(mod.sent.length, 1, 'un solo aviso aunque pulse varias veces');
  const alert = mod.sent[0];
  assert.equal(embedOf(alert.payload).title, '🔎 Cuenta nueva en revisión');

  const decide = (action, userId, extra = {}) => {
    const interaction = fakeInteraction(ctx, { kind: 'button', userId: 'mod1', admin: false, roles: ['r-staff'], message: { embeds: alert.payload.embeds }, ...extra });
    return verification.onComponent(interaction, ctx, action, userId).then(() => interaction);
  };
  await assert.rejects(decide('approve', 'u2', { roles: [] }), UserError);
  const approved = await decide('approve', 'u2');
  assert.deepEqual(reciente.actions, [['role', 'r-ok']]);
  assert.equal(embedOf(approved.replies[0]).fields.at(-1).value, 'Aprobado por <@mod1>');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM verification_pending').get().n, 0);

  const sospechosa = fakeMember('u3', { accountDaysAgo: 0 });
  ctx.members.set('u3', sospechosa);
  await accept(sospechosa);
  await decide('kick', 'u3');
  assert.deepEqual(sospechosa.actions, [['kick']]);
  assert.deepEqual(types(ctx, 'u3'), ['kick']);

  const gone = await decide('approve', 'se-fue');
  assert.equal(embedOf(gone.replies[0]).fields.at(-1).value, 'Ya no está en el servidor');

  // Dar el rol a quienes ya estaban: salta a los que ya lo tienen.
  ctx.members.set('u1', normal);
  ctx.members.set('antiguo', fakeMember('antiguo'));
  const existing = fakeInteraction(ctx, { command: 'verificacion', sub: 'existentes' });
  await verification.onCommand(existing, ctx);
  assert.match(textOf(existing.replies[0]), /dado a 2 miembros\.$/);
  assert.deepEqual(ctx.members.get('antiguo').actions, [['role', 'r-ok']]);
  assert.deepEqual(normal.actions, [['role', 'r-ok']], 'no se repite a quien ya lo tenía');
});

test('anti-raid: una oleada de entradas pausa la verificación hasta que el staff la reanuda', async () => {
  const { ctx, mod, accept } = verifySetup();
  ctx.settings.set('role_verified', 'r-ok');
  ctx.settings.set('raid_joins', 3);
  const join = async () => {
    ctx.client.emit(Events.GuildMemberAdd, { guild: { id: 'g1' } });
    await flush();
  };

  for (let i = 0; i < 3; i++) await join();
  assert.equal(ctx.settings.get('raid_mode'), '0');
  await join();
  await join();
  assert.equal(ctx.settings.get('raid_mode'), '1');
  assert.equal(mod.sent.length, 1, 'avisa una sola vez');
  assert.equal(textOf(mod.sent[0].payload), '<@&r-staff>');
  await assert.rejects(accept(fakeMember('u1')), /en pausa por seguridad/);

  const off = fakeInteraction(ctx, { kind: 'button', userId: 'mod1', admin: false, roles: ['r-staff'], message: { embeds: mod.sent[0].payload.embeds } });
  await verification.onComponent(off, ctx, 'raidoff');
  assert.equal(ctx.settings.get('raid_mode'), '0');
  assert.match(textOf((await accept(fakeMember('u1'))).replies[0]), /Ya puedes ver/);

  const raid = (sub, extra = {}) => {
    const interaction = fakeInteraction(ctx, { command: 'raid', sub, admin: false, roles: ['r-staff'], ...extra });
    return verification.onCommand(interaction, ctx).then(() => interaction);
  };
  await assert.rejects(raid('activar', { roles: [] }), UserError);
  await raid('activar');
  assert.match(textOf((await raid('estado')).replies[0]), /activado/);
  await raid('desactivar');
  assert.equal(ctx.settings.get('raid_mode'), '0');
});

// ---------- revisión de la configuración ----------

test('revisión: permisos, jerarquía de roles y configuración pendiente', async () => {
  const ctx = fakeCtx();
  const botRoles = { highest: { comparePositionTo: (role) => 5 - role.position } };
  const withPerms = (has) => ({ ...ctx.guild, members: { me: { permissions: { has }, roles: botRoles } } });

  const asAdmin = checkSetup(withPerms(() => true), ctx);
  assert.match(asAdmin[0], /tiene el permiso Administrador/);
  assert.equal(asAdmin.length, 4, 'además faltan staff, canal de moderación y rol de verificado');

  const missing = checkSetup(withPerms((flag) => flag !== PermissionFlagsBits.Administrator && flag !== PermissionFlagsBits.BanMembers), ctx);
  assert.match(missing[0], /faltan permisos: Banear miembros\./);

  ctx.settings.set('role_staff', 'r-staff');
  ctx.settings.set('channel_mod', 'mod');
  ctx.settings.set('role_verified', 'r-ok');
  ctx.settings.set('role_auto', 'r-borrado');
  ctx.db.prepare('INSERT INTO level_rewards (level, role_id) VALUES (?, ?)').run(5, 'r-alto');
  ctx.guild.roles.cache.set('r-ok', { name: 'Miembro', position: 2 });
  ctx.guild.roles.cache.set('r-alto', { name: 'Veterano', position: 9 });
  const guild = withPerms((flag) => flag !== PermissionFlagsBits.Administrator);
  assert.deepEqual(
    checkSetup(guild, ctx).map((problem) => problem.slice(0, 45)),
    ['El rol automático configurado ya no existe.', 'El rol del bot está por debajo del rol del ni'],
  );

  const revisar = fakeInteraction(ctx, { command: 'config', sub: 'revisar' });
  revisar.guild = guild;
  await config.onCommand(revisar, ctx);
  assert.match(textOf(revisar.replies[0]), /^⚠️ El rol automático/);

  ctx.settings.unset('role_auto');
  ctx.db.prepare('DELETE FROM level_rewards').run();
  const ok = fakeInteraction(ctx, { command: 'config', sub: 'revisar' });
  ok.guild = guild;
  await config.onCommand(ok, ctx);
  assert.match(textOf(ok.replies[0]), /Todo en orden/);

  const seguridad = fakeInteraction(ctx, { command: 'config', sub: 'seguridad', options: { dias_enlaces: 3, raid_entradas: 20 } });
  await config.onCommand(seguridad, ctx);
  assert.equal(ctx.settings.getNumber('automod_link_days'), 3);
  assert.equal(ctx.settings.getNumber('raid_joins'), 20);
  assert.equal(ctx.settings.getNumber('verify_min_account_days'), 7, 'lo no indicado no cambia');
  assert.match(textOf(seguridad.replies[0]), /primeros 3 días.*más de 20 entradas/);
});
