import '../../src/extensions/academy/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../../src/extensions/academy/catalog.js';
import { COURSES, INTERESTS, PACKS, formatPrice, getCourse, interestOfCourse, recommend } from '../../src/extensions/academy/courses.js';
import onboarding from '../../src/extensions/academy/onboarding.js';
import workshops from '../../src/extensions/academy/workshops.js';
import events from '../../src/modules/events.js';
import notifications from '../../src/modules/notifications.js';
import stats from '../../src/modules/stats.js';
import verification from '../../src/modules/verification.js';
import { embedOf, fakeChannel, fakeCtx, fakeInteraction, fakeMember, textOf } from '../helpers.js';

const MINUTE = 60_000;

function setup(...channelIds) {
  const channels = Object.fromEntries(channelIds.map((id) => [id, fakeChannel(id)]));
  const ctx = fakeCtx(Object.values(channels));
  ctx.settings.set('role_staff', 'r-staff');
  const staff = { admin: false, roles: ['r-staff'], userId: 'mod1' };
  return { ctx, channels, staff };
}

test('catálogo: datos coherentes y recomendación por interés', () => {
  for (const pack of PACKS) for (const id of pack.courses) assert.ok(getCourse(id), `${pack.name}: ${id}`);
  for (const interest of INTERESTS) {
    assert.ok(getCourse(interest.start), interest.id);
    for (const id of interest.courses) assert.equal(interestOfCourse(id).id, interest.id);
  }
  assert.equal(new Set(INTERESTS.flatMap((i) => i.courses)).size, COURSES.length, 'cada curso pertenece a un interés');
  assert.equal(formatPrice(53.26), '53,26 USD');
  assert.equal(
    recommend('web'),
    'Te recomendamos empezar por **HTML / CSS** · 2 meses · 53,26 USD.\nCon el pack **Web Starter** (HTML / CSS + JavaScript) ahorras un 15 %: 118,26 USD.',
  );
  assert.equal(recommend('nose'), 'Te recomendamos empezar por **Fundamentos de Programación** · 2 meses · 31,52 USD.');
});

test('/cursos, /hosting y /tiktok', async () => {
  const { ctx, channels, staff } = setup('novedades');
  const run = (command, options = {}, extra = {}) => {
    const interaction = fakeInteraction(ctx, { command, options, admin: false, ...extra });
    return catalog.onCommand(interaction, ctx).then(() => interaction);
  };

  const cursos = await run('cursos');
  const embed = embedOf(cursos.replies[0]);
  assert.match(embed.description, /\*\*Python\*\* · 4 meses · 107,61 USD/);
  assert.match(embed.fields[0].value, /\*\*Backend Starter\*\* · Fundamentos de Programación \+ Python \+ SQL · 163,53 USD/);
  assert.equal(cursos.replies[0].components[0].toJSON().components[0].url, 'https://innovateacademy.site/cursos');
  ctx.settings.set('web_url', 'https://innovateacademy.site/');
  assert.equal((await run('cursos')).replies[0].components[0].toJSON().components[0].url, 'https://innovateacademy.site/');

  const hosting = await run('hosting');
  assert.match(textOf(hosting.replies[0]), /SolarCloud/);
  assert.equal(hosting.replies[0].components[0].toJSON().components[0].url, 'https://solarcloud.lat/');

  const video = 'https://www.tiktok.com/@innovateacademy.site/video/1';
  await assert.rejects(run('tiktok', { enlace: video }), /Solo el staff/);
  await assert.rejects(run('tiktok', { enlace: 'https://tiktok.com.estafa.ru/x' }, staff), /tiktok\.com/);
  await assert.rejects(run('tiktok', { enlace: video }, staff), /canal de novedades/);
  ctx.settings.set('channel_news', 'novedades');
  await run('tiktok', { enlace: video, texto: 'Así se hace un bucle' }, staff);
  assert.equal(textOf(channels.novedades.sent[0].payload), `📱 Así se hace un bucle\n${video}`);
});

test('onboarding: al verificarse se pregunta el interés; da rol y recomienda curso', async () => {
  const { ctx } = setup();
  ctx.settings.set('role_verified', 'r-ok');
  const ana = fakeMember('ana');

  const accepted = fakeInteraction(ctx, { kind: 'button', member: ana, admin: false });
  await verification.onComponent(accepted, ctx, 'accept');
  assert.match(textOf(accepted.replies[0]), /Ya puedes ver el resto del servidor\. Si quieres, cuéntanos qué te gustaría aprender:/);
  assert.equal(accepted.replies[0].components[0].toJSON().components[0].custom_id, 'onboarding:interest');

  const choose = async (value) => {
    const interaction = fakeInteraction(ctx, { kind: 'select', member: ana, admin: false, values: [value] });
    await onboarding.onComponent(interaction, ctx, 'interest');
    return interaction;
  };
  const web = await choose('web');
  assert.match(textOf(web.replies[0]), /Apuntado: \*\*Crear páginas web\*\*[\s\S]*HTML \/ CSS[\s\S]*Web Starter/);
  assert.equal(ctx.createdRoles[0].name, 'Interés · Crear páginas web');
  assert.deepEqual(ana.actions.at(-1), ['role', 'role-1']);

  // Cambiar de interés sustituye el rol; repetir uno ya elegido no crea otro rol.
  await choose('juegos');
  assert.deepEqual(ana.actions.slice(-2), [['unrole', 'role-1'], ['role', 'role-2']]);
  await choose('juegos');
  assert.equal(ctx.createdRoles.length, 2);
  assert.equal(ctx.db.prepare('SELECT interest FROM member_interests WHERE user_id = ?').get('ana').interest, 'juegos');

  const manual = fakeInteraction(ctx, { command: 'intereses', member: ana, admin: false });
  await onboarding.onCommand(manual, ctx);
  assert.equal(manual.replies[0].components[0].toJSON().components[0].options.length, 4);
});

test('talleres abiertos: avisan al rol de interés, llevan enlace y un único mensaje posterior', async () => {
  const { ctx, channels, staff } = setup('eventos');
  ctx.settings.set('channel_events', 'eventos');
  ctx.settings.set('role_interest_backend', 'r-backend');
  const create = (options, extra = staff) => {
    const interaction = fakeInteraction(ctx, { command: 'taller', sub: 'crear', options, ...extra });
    return workshops.onCommand(interaction, ctx).then(() => interaction);
  };
  const base = { titulo: 'Tu primer script', fecha: '01/01/2099 18:00', descripcion: 'Prueba una clase de Python', curso: 'python' };

  await assert.rejects(create(base, { admin: false }), /Solo el staff/);
  await assert.rejects(create({ ...base, enlace: 'meet.google.com/x' }), /http/);
  const created = await create({ ...base, enlace: 'https://meet.google.com/x' });
  assert.match(textOf(created.replies[0]), /Taller #1 \(Python\) publicado en <#eventos>/);
  const post = channels.eventos.sent[0].payload;
  assert.equal(post.content, '<@&r-backend>');
  assert.equal(embedOf(post).title, '📅 Taller abierto: Tu primer script');
  assert.equal(embedOf(post).fields.at(-1).value, 'https://meet.google.com/x');

  // Un evento normal del núcleo no genera mensaje posterior.
  await events.onCommand(fakeInteraction(ctx, { command: 'evento', sub: 'crear', options: { titulo: 'Quedada', fecha: base.fecha, descripcion: 'x' }, ...staff }), ctx);

  const ana = fakeMember('ana');
  ctx.members.set('ana', ana);
  await notifications.onCommand(fakeInteraction(ctx, { command: 'avisos', sub: 'activar', member: ana, admin: false }), ctx);
  await events.onComponent(fakeInteraction(ctx, { kind: 'button', member: ana, admin: false }), ctx, 'toggle', '1');

  const { starts_at: start } = ctx.db.prepare('SELECT starts_at FROM events WHERE id = 1').get();
  await events.tick(ctx, start - 15 * MINUTE);
  assert.match(ana.user.dms.at(-1), /Tu primer script\*\* empieza[\s\S]*Enlace: https:\/\/meet\.google\.com\/x/);

  const before = channels.eventos.sent.length;
  await workshops.tick(ctx, start + 89 * MINUTE);
  assert.equal(channels.eventos.sent.length, before);
  await workshops.tick(ctx, start + 90 * MINUTE);
  await workshops.tick(ctx, start + 95 * MINUTE);
  assert.equal(channels.eventos.sent.length, before + 1, 'un solo mensaje, y solo para el taller');
  assert.match(textOf(channels.eventos.sent.at(-1).payload), /¿Te gustó \*\*Taller abierto: Tu primer script\*\*\? El curso completo: \*\*Python\*\* · 4 meses · 107,61 USD/);
});

test('estadísticas: la academia añade el embudo y los intereses', async () => {
  const { ctx, staff } = setup('eventos');
  const now = Date.now();
  ctx.db.prepare("INSERT INTO member_interests (user_id, interest, chosen_at) VALUES ('a', 'web', ?), ('b', 'web', ?), ('c', 'juegos', ?)").run(now, now, now - 20 * 86_400_000);
  ctx.db.prepare("INSERT INTO enrollments (group_id, user_id, source, enrolled_at) VALUES (1, 'a', 'code', ?), (1, 'x', 'staff', ?)").run(now, now);
  ctx.db.prepare("INSERT INTO events (title, description, starts_at, channel_id) VALUES ('Taller', 'x', ?, 'eventos'), ('Quedada', 'x', ?, 'eventos')").run(now, now);
  ctx.db.prepare("INSERT INTO workshops (event_id, course) VALUES (1, 'python')").run();
  ctx.db.prepare("INSERT INTO event_signups (event_id, user_id) VALUES (1, 'a'), (1, 'b'), (2, 'a')").run();

  const shown = fakeInteraction(ctx, { command: 'stats', ...staff });
  await stats.onCommand(shown, ctx);
  const fields = Object.fromEntries(embedOf(shown.replies[0]).fields.map((field) => [field.name, field.value]));
  assert.equal(fields.Embudo, 'Inscritos a talleres: 2\nMatrículas: 2 (1 con código)');
  assert.match(fields['Intereses elegidos'], /🌐 Crear páginas web: 2\n🎮 Crear videojuegos: 0/);
  assert.deepEqual(Object.keys(fields), ['Miembros', 'Actividad', 'Embudo', 'Intereses elegidos', 'Retención a 7 días']);
});
