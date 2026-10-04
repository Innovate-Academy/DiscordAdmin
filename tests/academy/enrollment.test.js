import '../../src/extensions/academy/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { AttemptLimiter, COURSES, generateCode, normalizeCode } from '../../src/extensions/academy/courses.js';
import enrollment from '../../src/extensions/academy/enrollment.js';
import { UserError } from '../../src/util.js';
import { embedOf, fakeCtx, fakeInteraction, fakeMember, textOf, userOption } from '../helpers.js';

function setup() {
  const ctx = fakeCtx();
  ctx.settings.set('role_staff', 'r-staff');
  const run = (command, sub, options = {}, extra = {}) => {
    const interaction = fakeInteraction(ctx, { command, sub, options, ...extra });
    return enrollment.onCommand(interaction, ctx).then(() => interaction);
  };
  const asStaff = { admin: false, roles: ['r-staff'], userId: 'profe' };
  const asMember = (member) => ({ admin: false, member });
  return { ctx, run, asStaff, asMember };
}

async function withGroup() {
  const env = setup();
  await env.run('grupo', 'crear', { curso: 'python', nombre: 'Octubre 2026', profesor: { id: 'profe' } });
  const [role] = env.ctx.createdRoles;
  const [category, avisos, dudas, entregas] = env.ctx.created;
  return { ...env, role, category, avisos, dudas, entregas };
}

test('códigos: forma, normalización y límite de intentos', () => {
  let next = 0;
  assert.equal(generateCode(() => next++), 'IA-ABCD-EFGH');
  assert.match(generateCode(), /^IA-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normalizeCode(' ia-abcd-2345 '), 'IA-ABCD-2345');
  assert.equal(normalizeCode('IAABCD2345'), 'IA-ABCD-2345');
  for (const bad of ['ABCD-2345', 'IA-ABC-2345', 'IA-ABCD-23456', 'IA-ABCD-2O45', 'hola']) assert.equal(normalizeCode(bad), null, bad);

  const limiter = new AttemptLimiter({ max: 2, windowMs: 1000 });
  limiter.fail('u1', 0);
  assert.equal(limiter.blocked('u1', 10), false);
  limiter.fail('u1', 10);
  assert.equal(limiter.blocked('u1', 20), true);
  assert.equal(limiter.blocked('u2', 20), false);
  assert.equal(limiter.blocked('u1', 1500), false, 'los fallos caducan');

  assert.equal(COURSES.length, 9);
});

test('grupo crear: rol, categoría privada y tres canales (avisos de solo lectura)', async () => {
  const { ctx, run, asStaff, role, category, avisos, dudas, entregas } = await withGroup();
  await assert.rejects(run('grupo', 'crear', { curso: 'python', nombre: 'X' }, asStaff), /administradores/);

  assert.equal(role.name, 'Python · Octubre 2026');
  assert.equal(category.options.type, ChannelType.GuildCategory);
  assert.equal(category.name, '📚 Python · Octubre 2026');
  assert.deepEqual([avisos, dudas, entregas].map((c) => [c.name, c.options.parent]), [['avisos', category.id], ['dudas', category.id], ['entregas', category.id]]);

  const overwrite = (channel, id) => channel.options.permissionOverwrites.find((o) => o.id === id);
  assert.deepEqual(avisos.options.permissionOverwrites.map((o) => o.id), ['everyone', role.id, 'bot', 'r-staff', 'profe']);
  assert.deepEqual(overwrite(avisos, 'everyone').deny, [PermissionFlagsBits.ViewChannel]);
  assert.equal(overwrite(avisos, role.id).allow.includes(PermissionFlagsBits.SendMessages), false, 'los alumnos no escriben en avisos');
  assert.equal(overwrite(dudas, role.id).allow.includes(PermissionFlagsBits.SendMessages), true);
  assert.equal(overwrite(avisos, 'profe').allow.includes(PermissionFlagsBits.SendMessages), true);

  const group = ctx.db.prepare('SELECT * FROM course_groups').get();
  assert.deepEqual([group.course, group.name, group.role_id, group.category_id, group.announcements_id, group.teacher_id, group.status],
    ['python', 'Octubre 2026', role.id, category.id, avisos.id, 'profe', 'open']);
});

test('grupo crear: si falla a medias no deja rol ni canales sueltos', async () => {
  const { ctx, run } = setup();
  const create = ctx.guild.channels.create;
  let calls = 0;
  ctx.guild.channels.create = async (options) => {
    if (++calls === 3) throw new Error('Missing Permissions');
    return create(options);
  };
  await assert.rejects(run('grupo', 'crear', { curso: 'lua', nombre: 'Fallido' }), /No he podido crear el grupo/);
  assert.equal(ctx.createdRoles[0].deleted, true);
  assert.deepEqual(ctx.created.map((c) => c.deleted), [true, true]);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM course_groups').get().n, 0);
});

test('matricular y desmatricular a mano', async () => {
  const { ctx, run, asStaff, role, avisos } = await withGroup();
  const alumno = fakeMember('u5');
  const options = { alumno: userOption(alumno), grupo: role };

  await assert.rejects(run('matricular', null, options, { admin: false }), /Solo el staff/);
  await assert.rejects(run('matricular', null, { alumno: userOption(alumno), grupo: { id: 'r-staff' } }, asStaff), /no pertenece a ningún grupo/);
  await assert.rejects(run('matricular', null, { alumno: { id: 'u9' }, grupo: role }, asStaff), /no está en el servidor/);

  const done = await run('matricular', null, options, asStaff);
  assert.match(textOf(done.replies[0]), /<@u5> queda matriculado en \*\*Python · Octubre 2026\*\*/);
  assert.deepEqual(alumno.actions, [['role', role.id]]);
  assert.match(textOf(avisos.sent[0].payload), /<@u5> se ha unido al grupo/);
  await run('matricular', null, options, asStaff);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM enrollments').get().n, 1, 'matricular dos veces no duplica');

  const students = await run('grupo', 'alumnos', { grupo: role }, asStaff);
  assert.match(embedOf(students.replies[0]).description, /^<@u5> — .* por <@profe>$/);
  const list = await run('grupo', 'lista', {}, asStaff);
  assert.match(embedOf(list.replies[0]).description, /🟢 \*\*Python · Octubre 2026\*\* — <@&role-1> · 1 alumnos · profesor <@profe>/);

  const out = await run('desmatricular', null, options, asStaff);
  assert.match(textOf(out.replies[0]), /ya no está en/);
  assert.deepEqual(alumno.actions.at(-1), ['unrole', role.id]);
  assert.match(textOf((await run('desmatricular', null, options, asStaff)).replies[0]), /no estaba matriculado/);
});

test('códigos: crear, canjear una sola vez y errores', async () => {
  const { ctx, run, asStaff, asMember, role, avisos } = await withGroup();
  await assert.rejects(run('codigo', 'crear', { grupo: role }, { admin: false }), /Solo el staff/);
  const created = await run('codigo', 'crear', { grupo: role, cantidad: 3 }, asStaff);
  const codes = textOf(created.replies[0]).match(/IA-[A-Z2-9]{4}-[A-Z2-9]{4}/g);
  assert.equal(new Set(codes).size, 3);

  const ana = fakeMember('ana');
  await assert.rejects(run('canjear', null, { codigo: 'hola' }, asMember(ana)), /forma correcta/);
  await assert.rejects(run('canjear', null, { codigo: 'IA-ZZZZ-9999' }, asMember(ana)), /no existe/);

  const ok = await run('canjear', null, { codigo: codes[0].toLowerCase().replaceAll('-', ' ') }, asMember(ana));
  assert.match(textOf(ok.replies[0]), /Matrícula completada.*Python · Octubre 2026.*<#created-2>/);
  assert.deepEqual(ana.actions, [['role', role.id]]);
  assert.match(textOf(avisos.sent[0].payload), /<@ana> se ha unido/);
  const enrollmentRow = ctx.db.prepare('SELECT source, enrolled_by FROM enrollments WHERE user_id = ?').get('ana');
  assert.deepEqual({ ...enrollmentRow }, { source: 'code', enrolled_by: null });

  const luis = fakeMember('luis');
  await assert.rejects(run('canjear', null, { codigo: codes[0] }, asMember(luis)), /ya se ha usado/);
  assert.deepEqual(luis.actions, []);

  // Si no se puede dar el rol, el código no se gasta.
  const sinSuerte = fakeMember('sinsuerte');
  sinSuerte.roles.add = async () => {
    throw new Error('Missing Permissions');
  };
  await assert.rejects(run('canjear', null, { codigo: codes[1] }, asMember(sinSuerte)), /sigue siendo válido/);
  assert.equal(ctx.db.prepare('SELECT used_by FROM enroll_codes WHERE code = ?').get(codes[1]).used_by, null);

  const listed = await run('codigo', 'lista', { grupo: role }, asStaff);
  assert.match(textOf(listed.replies[0]), /1 canjeados, 2 sin usar/);
  assert.equal(textOf(listed.replies[0]).includes(codes[0]), false);

  // Tras varios fallos seguidos, se bloquea aunque el código sea bueno.
  const curioso = fakeMember('curioso');
  for (let i = 0; i < 5; i++) await assert.rejects(run('canjear', null, { codigo: 'IA-ZZZZ-9999' }, asMember(curioso)), /no existe/);
  await assert.rejects(run('canjear', null, { codigo: codes[1] }, asMember(curioso)), /Demasiados intentos/);
});

test('grupo cerrar: solo lectura y sin nuevas matrículas', async () => {
  const { ctx, run, asStaff, asMember, role, category, avisos, dudas, entregas } = await withGroup();
  const created = await run('codigo', 'crear', { grupo: role }, asStaff);
  const [code] = textOf(created.replies[0]).match(/IA-[A-Z2-9]{4}-[A-Z2-9]{4}/g);

  await assert.rejects(run('grupo', 'cerrar', { grupo: role }, asStaff), /administradores/);
  await run('grupo', 'cerrar', { grupo: role });
  assert.equal(ctx.db.prepare('SELECT status FROM course_groups').get().status, 'closed');
  assert.equal(category.name, '🔒 Python · Octubre 2026');
  for (const channel of [category, avisos, dudas, entregas]) {
    assert.deepEqual(channel.overwriteEdits, [[role.id, { SendMessages: false, SendMessagesInThreads: false }]], channel.name);
  }

  await assert.rejects(run('grupo', 'cerrar', { grupo: role }), /está cerrado/);
  await assert.rejects(run('matricular', null, { alumno: userOption(fakeMember('u5')), grupo: role }, asStaff), /está cerrado/);
  await assert.rejects(run('codigo', 'crear', { grupo: role }, asStaff), /está cerrado/);
  await assert.rejects(run('canjear', null, { codigo: code }, asMember(fakeMember('tarde'))), UserError);
  const list = await run('grupo', 'lista', {}, asStaff);
  assert.match(embedOf(list.replies[0]).description, /^🔒/);
});
