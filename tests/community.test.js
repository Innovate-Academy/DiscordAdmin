import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import challenges from '../src/modules/challenges.js';
import events from '../src/modules/events.js';
import levels, { grantXp } from '../src/modules/levels.js';
import notifications from '../src/modules/notifications.js';
import referrals from '../src/modules/referrals.js';
import showcase from '../src/modules/showcase.js';
import stats, { computeStats, recordMemberEvent } from '../src/modules/stats.js';
import { embedOf, fakeChannel, fakeCtx, fakeInteraction, fakeMember, textOf } from './helpers.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(...channelIds) {
  const channels = Object.fromEntries(channelIds.map((id) => [id, fakeChannel(id)]));
  const ctx = fakeCtx(Object.values(channels));
  ctx.settings.set('role_staff', 'r-staff');
  const staff = { admin: false, roles: ['r-staff'], userId: 'mod1' };
  return { ctx, channels, staff };
}

test('eventos: enlace, mención a un rol y aviso por privado a quien lo ha pedido', async () => {
  const { ctx, channels, staff } = setup('eventos');
  ctx.settings.set('channel_events', 'eventos');
  const create = (options) => events.onCommand(fakeInteraction(ctx, { command: 'evento', sub: 'crear', options, ...staff }), ctx);
  const base = { titulo: 'Directo', fecha: '01/01/2099 18:00', descripcion: 'Preguntas y respuestas' };

  await assert.rejects(create({ ...base, enlace: 'meet.example/x' }), /http/);
  await create({ ...base, enlace: 'https://meet.example/x', rol: { id: 'r-fans' } });
  const post = channels.eventos.sent[0].payload;
  assert.equal(post.content, '<@&r-fans>');
  assert.deepEqual(post.allowedMentions, { roles: ['r-fans'] });
  assert.equal(embedOf(post).fields.at(-1).value, 'https://meet.example/x');
  await create(base);
  assert.equal(channels.eventos.sent[1].payload.content, undefined, 'sin rol no se menciona a nadie');

  const ana = fakeMember('ana');
  const luis = fakeMember('luis');
  ctx.members.set('ana', ana);
  ctx.members.set('luis', luis);
  await notifications.onCommand(fakeInteraction(ctx, { command: 'avisos', sub: 'activar', member: ana, admin: false }), ctx);
  for (const member of [ana, luis]) await events.onComponent(fakeInteraction(ctx, { kind: 'button', member, admin: false }), ctx, 'toggle', '1');

  const { starts_at: start } = ctx.db.prepare('SELECT starts_at FROM events WHERE id = 1').get();
  await events.tick(ctx, start - 15 * MINUTE);
  assert.match(ana.user.dms.at(-1), /Directo\*\* empieza[\s\S]*Enlace: https:\/\/meet\.example\/x/);
  assert.deepEqual(luis.user.dms, [], 'sin /avisos no hay privado');

  await notifications.onCommand(fakeInteraction(ctx, { command: 'avisos', sub: 'desactivar', member: ana, admin: false }), ctx);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM dm_optin').get().n, 0);
});

test('escaparate: el proyecto se publica solo tras la aprobación del staff', async () => {
  const { ctx, channels, staff } = setup('mod', 'proyectos');
  const ana = fakeMember('ana');
  const fields = { titulo: 'Agenda', descripcion: 'Una agenda en Python', enlace: 'https://github.com/ana/agenda', imagen: '' };
  const send = (extra = {}) => showcase.onComponent(fakeInteraction(ctx, { kind: 'modal', member: ana, admin: false, fields: { ...fields, ...extra } }), ctx, 'send');

  const opened = fakeInteraction(ctx, { command: 'proyecto', member: ana, admin: false });
  await showcase.onCommand(opened, ctx);
  assert.equal(opened.modal.toJSON().custom_id, 'showcase:send');

  await assert.rejects(send({ enlace: 'github.com/ana' }), /http/);
  await assert.rejects(send({ imagen: 'captura.png' }), /captura/);
  await assert.rejects(send(), /aún no está configurado/);
  ctx.settings.set('channel_mod', 'mod');
  ctx.settings.set('channel_projects', 'proyectos');
  await send({ imagen: 'https://i.example/agenda.png' });
  const pending = channels.mod.sent[0];
  assert.equal(embedOf(pending.payload).title, '🚀 Agenda');
  assert.equal(embedOf(pending.payload).image.url, 'https://i.example/agenda.png');
  assert.equal(channels.proyectos.sent.length, 0);
  await assert.rejects(showcase.onCommand(fakeInteraction(ctx, { command: 'proyecto', member: ana, admin: false }), ctx), /esperando revisión/);

  const review = (action, id, extra = staff) => {
    const interaction = fakeInteraction(ctx, { kind: 'button', message: { embeds: pending.payload.embeds }, ...extra });
    return showcase.onComponent(interaction, ctx, action, String(id)).then(() => interaction);
  };
  await assert.rejects(review('approve', 1, { member: ana, admin: false }), /Solo el staff/);
  const approved = await review('approve', 1);
  assert.equal(embedOf(approved.replies[0]).fields.at(-1).value, 'Publicado por <@mod1>');
  assert.equal(embedOf(channels.proyectos.sent[0].payload).fields[0].value, '<@ana>');
  assert.equal(channels.proyectos.sent[0].payload.components[0].toJSON().components[0].url, 'https://github.com/ana/agenda');
  assert.equal(ctx.db.prepare('SELECT xp FROM levels WHERE user_id = ?').get('ana').xp, 50);
  await assert.rejects(review('reject', 1), /ya está revisado/);

  await send();
  await review('reject', 2);
  assert.equal(channels.proyectos.sent.length, 1);
  assert.equal(ctx.db.prepare('SELECT status FROM projects WHERE id = 2').get().status, 'rejected');
});

test('XP de premio: el siguiente mensaje anuncia la subida y /top calcula el nivel real', async () => {
  const { ctx } = setup();
  grantXp(ctx.db, 'ana', 250);
  grantXp(ctx.db, 'ana', 50);
  assert.deepEqual({ ...ctx.db.prepare('SELECT xp, level FROM levels WHERE user_id = ?').get('ana') }, { xp: 300, level: 0 });
  const top = fakeInteraction(ctx, { command: 'top' });
  await levels.onCommand(top, ctx);
  assert.match(embedOf(top.replies[0]).description, /<@ana> · nivel 2 · 300 XP/);
});

test('estadísticas: altas, bajas, actividad y retención', async () => {
  const { ctx, channels, staff } = setup('mod');
  ctx.settings.set('channel_mod', 'mod');
  ctx.client = Object.assign(new EventEmitter(), ctx.client);
  stats.register(ctx.client, ctx);
  const member = (id, bot = false) => ({ id, guild: { id: 'g1' }, user: { bot } });
  ctx.client.emit(Events.GuildMemberAdd, member('a'));
  ctx.client.emit(Events.GuildMemberAdd, member('b'));
  ctx.client.emit(Events.GuildMemberAdd, member('robot', true));
  ctx.client.emit(Events.GuildMemberRemove, { id: 'b', guild: { id: 'g1' } });
  ctx.client.emit(Events.GuildMemberAdd, { ...member('c'), guild: { id: 'otro' } });
  await flush();

  const now = Date.now();
  // Cohorte de hace 10 días: tres entraron, uno se fue después.
  for (const id of ['x', 'y', 'z']) recordMemberEvent(ctx.db, id, 'join', now - 10 * DAY);
  recordMemberEvent(ctx.db, 'z', 'leave', now - 9 * DAY);
  recordMemberEvent(ctx.db, 'a', 'verify', now);
  const insert = ctx.db.prepare("INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, 'c', ?, 'hola', ?)");
  insert.run('1', 'a', now);
  insert.run('2', 'a', now);
  insert.run('3', 'x', now);
  insert.run('4', 'x', now - 20 * DAY);

  assert.deepEqual(computeStats(ctx.db, now - 7 * DAY, now + 1000), {
    joins: 2,
    leaves: 1,
    verified: 1,
    messages: 3,
    activeMembers: 2,
    retention: { cohort: 3, stayed: 2 },
  });

  await assert.rejects(stats.onCommand(fakeInteraction(ctx, { command: 'stats', admin: false }), ctx), /Solo el staff/);
  const shown = fakeInteraction(ctx, { command: 'stats', ...staff });
  await stats.onCommand(shown, ctx);
  const fields = embedOf(shown.replies[0]).fields;
  assert.equal(fields[0].value, 'Altas: 2\nBajas: 1\nNeto: +1\nVerificados: 1');
  assert.equal(fields[1].value, 'Mensajes: 3\nPersonas activas: 2');
  assert.equal(fields.at(-1).value, '2 de 3 (67 %) siguen en el servidor');

  const monday = Date.UTC(2026, 9, 5, 7, 30);
  await stats.tick(ctx, monday - DAY);
  assert.equal(channels.mod.sent.length, 0);
  await stats.tick(ctx, monday);
  await stats.tick(ctx, monday + MINUTE);
  assert.equal(channels.mod.sent.length, 1, 'un resumen por semana');
});

test('referidos: cuenta a quien entra con tu enlace y sigue a los 7 días', async () => {
  const { ctx, channels } = setup('general');
  ctx.client = Object.assign(new EventEmitter(), ctx.client);
  ctx.settings.set('role_verified', 'r-ok');
  referrals.register(ctx.client, ctx);
  const ana = fakeMember('ana');
  ctx.members.set('ana', ana);
  const invitar = () => {
    const interaction = fakeInteraction(ctx, { command: 'invitar', member: ana, admin: false, channel: channels.general });
    return referrals.onCommand(interaction, ctx).then(() => interaction);
  };

  const first = await invitar();
  assert.match(textOf(first.replies[0]), /https:\/\/discord\.gg\/inv-general[\s\S]*\*\*0\*\* \(en espera: 0\)/);
  await invitar();
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM referral_invites').get().n, 1, 'un enlace por persona');

  ctx.invites.set('inv-general', { code: 'inv-general', uses: 0 });
  ctx.invites.set('otra', { code: 'otra', uses: 5 });
  ctx.client.emit(Events.ClientReady);
  await flush();

  const join = async (id, options = {}, bump = 'inv-general') => {
    ctx.invites.get(bump).uses++;
    const member = fakeMember(id, options);
    member.guild = Object.assign(Object.create(ctx.guild), { id: 'g1' });
    ctx.members.set(id, member);
    ctx.client.emit(Events.GuildMemberAdd, member);
    await flush();
    return member;
  };
  const luis = await join('luis');
  await join('reciente', { accountDaysAgo: 2 });
  await join('ajena', {}, 'otra');
  assert.deepEqual(ctx.db.prepare('SELECT invited_id FROM referrals').all().map((r) => r.invited_id), ['luis']);

  const now = Date.now();
  await referrals.tick(ctx, now + 6 * DAY);
  assert.equal(ctx.db.prepare('SELECT checked FROM referrals').get().checked, 0);
  // A los 7 días: luis no está verificado, así que no cuenta.
  await referrals.tick(ctx, now + 7 * DAY + MINUTE);
  assert.equal(ctx.db.prepare('SELECT qualified_at FROM referrals').get().qualified_at, null);

  // Tres invitados verificados que se quedan: 200 XP cada uno y rol Embajador al tercero.
  luis.roles.cache.set('r-ok', true);
  ctx.db.prepare('UPDATE referrals SET checked = 0').run();
  for (const id of ['p1', 'p2']) {
    const invited = await join(id);
    invited.roles.cache.set('r-ok', true);
  }
  await referrals.tick(ctx, Date.now() + 8 * DAY);
  assert.equal(ctx.db.prepare('SELECT xp FROM levels WHERE user_id = ?').get('ana').xp, 600);
  assert.equal(ctx.createdRoles.at(-1).name, 'Embajador');
  assert.deepEqual(ana.actions.at(-1), ['role', ctx.createdRoles.at(-1).id]);
  assert.match(textOf((await invitar()).replies[0]), /\*\*3\*\* \(en espera: 0\)/);

  // Sin el permiso "Gestionar servidor" los referidos quedan desactivados, con un mensaje claro.
  ctx.guild.members.me.permissions.has = () => false;
  await assert.rejects(invitar(), /Gestionar servidor/);
});

test('retos: soluciones ocultas hasta el cierre, XP por participar y rachas', async () => {
  const { ctx, channels, staff } = setup('retos');
  ctx.settings.set('channel_challenges', 'retos');
  const create = (options, extra = staff) => {
    const interaction = fakeInteraction(ctx, { command: 'reto', sub: 'crear', options, ...extra });
    return challenges.onCommand(interaction, ctx).then(() => interaction);
  };
  const solve = (id, userId, solucion) =>
    challenges.onComponent(fakeInteraction(ctx, { kind: 'modal', userId, admin: false, fields: { solucion } }), ctx, 'send', String(id));
  const streakOf = (userId) => ctx.db.prepare('SELECT streak FROM challenge_streaks WHERE user_id = ?').get(userId)?.streak;

  await assert.rejects(create({ titulo: 'FizzBuzz', descripcion: 'x' }, { admin: false }), /Solo el staff/);
  await create({ titulo: 'FizzBuzz', descripcion: 'Del 1 al 100', tema: 'Python' });
  const post = channels.retos.sent[0];
  assert.equal(embedOf(post.payload).title, '🧩 Reto: FizzBuzz');
  assert.match(embedOf(post.payload).footer.text, /Reto #1 · Python/);

  const enter = fakeInteraction(ctx, { kind: 'button', userId: 'ana', admin: false });
  await challenges.onComponent(enter, ctx, 'enter', '1');
  assert.equal(enter.modal.toJSON().custom_id, 'challenges:send:1');
  await solve(1, 'ana', 'print("v1")');
  await solve(1, 'ana', 'print("v2")');
  await solve(1, 'luis', 'https://replit.com/luis');
  assert.equal(embedOf(post.payload).fields[2].value, '2');
  assert.equal(channels.retos.sent.length, 1, 'nada se publica antes del cierre');

  const { ends_at: end } = ctx.db.prepare('SELECT ends_at FROM challenges WHERE id = 1').get();
  await challenges.tick(ctx, end - 1);
  assert.equal(channels.retos.sent.length, 1);
  await challenges.tick(ctx, end);
  await challenges.tick(ctx, end + MINUTE);
  assert.match(textOf(channels.retos.sent[1].payload), /FizzBuzz\*\* cerrado: 2 participantes, 100 XP/);
  const [thread] = channels.retos.createdThreads;
  assert.deepEqual(thread.sent.map((m) => textOf(m.payload)), ['**<@ana>**\nprint("v2")', '**<@luis>**\nhttps://replit.com/luis']);
  assert.equal(post.payload.components[0].toJSON().components[0].disabled, true);
  assert.equal(ctx.db.prepare('SELECT xp FROM levels WHERE user_id = ?').get('ana').xp, 100);
  await assert.rejects(solve(1, 'tarde', 'x'), /ya está cerrado/);

  // Racha: ana participa en el siguiente y la mantiene; luis se lo salta y vuelve a empezar.
  await create({ titulo: 'Palíndromos', descripcion: 'x', xp: 0 });
  await solve(2, 'ana', 'x');
  await challenges.onCommand(fakeInteraction(ctx, { command: 'reto', sub: 'cerrar', options: { id: 2 }, ...staff }), ctx);
  await create({ titulo: 'Primos', descripcion: 'x' });
  await solve(3, 'ana', 'x');
  await solve(3, 'luis', 'x');
  await challenges.onCommand(fakeInteraction(ctx, { command: 'reto', sub: 'cerrar', options: { id: 3 }, ...staff }), ctx);
  assert.equal(streakOf('ana'), 3);
  assert.equal(streakOf('luis'), 1);
  assert.equal(ctx.db.prepare('SELECT xp FROM levels WHERE user_id = ?').get('ana').xp, 200, 'el reto de 0 XP no suma');

  const nivel = fakeInteraction(ctx, { command: 'nivel', options: { usuario: { id: 'ana', displayName: 'Ana', displayAvatarURL: () => 'https://cdn.example/a.png' } } });
  await levels.onCommand(nivel, ctx);
  assert.equal(embedOf(nivel.replies[0]).fields.at(-1).value, '🔥 3');

  // Un reto sin participantes se cierra con un aviso simple.
  await create({ titulo: 'Vacío', descripcion: 'x' });
  await challenges.onCommand(fakeInteraction(ctx, { command: 'reto', sub: 'cerrar', options: { id: 4 }, ...staff }), ctx);
  assert.match(textOf(channels.retos.sent.at(-1).payload), /terminado sin participantes/);
});
