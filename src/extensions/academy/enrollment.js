import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { AttemptLimiter, COURSES, courseName, generateCode, normalizeCode } from './courses.js';
import { groupLabel as label } from './groups.js';
import { discordTime } from '../../lib/dates.js';
import { UserError, eph, fetchChannel, requireAdmin, requireStaff } from '../../util.js';

const STUDENT = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.SendMessagesInThreads,
];
const READ_ONLY = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
// El bot abre hilos para las dudas y las entregas.
const BOT = [
  ...STUDENT,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.ManageThreads,
];

const groupOption = (opt) => opt.setName('grupo').setDescription('Rol del grupo').setRequired(true);
const studentOption = (opt) => opt.setName('alumno').setDescription('Alumno').setRequired(true);

const commands = [
  new SlashCommandBuilder()
    .setName('grupo')
    .setDescription('Grupos de alumnos por curso')
    .addSubcommand((sub) =>
      sub
        .setName('crear')
        .setDescription('Crea el rol y los canales privados de un grupo (admin)')
        .addStringOption((opt) =>
          opt.setName('curso').setDescription('Curso').setRequired(true).addChoices(...COURSES.map(({ id, name }) => ({ name, value: id }))),
        )
        .addStringOption((opt) => opt.setName('nombre').setDescription('Nombre del grupo, por ejemplo "Octubre 2026"').setRequired(true).setMaxLength(40))
        .addUserOption((opt) => opt.setName('profesor').setDescription('Profesor del grupo')),
    )
    .addSubcommand((sub) => sub.setName('lista').setDescription('Grupos y número de alumnos (staff)'))
    .addSubcommand((sub) => sub.setName('alumnos').setDescription('Alumnos de un grupo (staff)').addRoleOption(groupOption))
    .addSubcommand((sub) => sub.setName('cerrar').setDescription('Cierra un grupo: los canales quedan de solo lectura (admin)').addRoleOption(groupOption)),
  new SlashCommandBuilder().setName('matricular').setDescription('Matricula a un alumno en un grupo (staff)').addUserOption(studentOption).addRoleOption(groupOption),
  new SlashCommandBuilder().setName('desmatricular').setDescription('Saca a un alumno de un grupo (staff)').addUserOption(studentOption).addRoleOption(groupOption),
  new SlashCommandBuilder()
    .setName('codigo')
    .setDescription('Códigos de matrícula de un solo uso (staff)')
    .addSubcommand((sub) =>
      sub
        .setName('crear')
        .setDescription('Genera códigos para un grupo')
        .addRoleOption(groupOption)
        .addIntegerOption((opt) => opt.setName('cantidad').setDescription('Cuántos (por defecto 1)').setMinValue(1).setMaxValue(25)),
    )
    .addSubcommand((sub) => sub.setName('lista').setDescription('Códigos sin usar de un grupo').addRoleOption(groupOption)),
  new SlashCommandBuilder()
    .setName('canjear')
    .setDescription('Canjea tu código de matrícula para acceder a tu curso')
    .addStringOption((opt) => opt.setName('codigo').setDescription('El código que recibiste al comprar, por ejemplo IA-ABCD-2345').setRequired(true).setMaxLength(30)),
];

function groupFromOption(interaction, db) {
  const role = interaction.options.getRole('grupo', true);
  const group = db.prepare('SELECT * FROM course_groups WHERE role_id = ?').get(role.id);
  if (!group) throw new UserError('Ese rol no pertenece a ningún grupo. Mira los grupos con `/grupo lista`.');
  return group;
}

function requireOpen(group) {
  if (group.status !== 'open') throw new UserError(`El grupo **${label(group)}** está cerrado.`);
}

// Da el rol, anota la matrícula y saluda en el canal de avisos del grupo.
async function enroll(ctx, member, group, source, enrolledBy = null) {
  await member.roles.add(group.role_id);
  ctx.db
    .prepare('INSERT OR IGNORE INTO enrollments (group_id, user_id, source, enrolled_by, enrolled_at) VALUES (?, ?, ?, ?, ?)')
    .run(group.id, member.id, source, enrolledBy, Date.now());
  const announcements = await fetchChannel(ctx.client, group.announcements_id);
  await announcements?.send({ content: `👋 ${member} se ha unido al grupo.`, allowedMentions: { users: [member.id] } }).catch(() => {});
}

async function createGroup(interaction, ctx) {
  requireAdmin(interaction);
  const { db, settings, client } = ctx;
  const { guild, options } = interaction;
  const course = options.getString('curso', true);
  const name = options.getString('nombre', true).trim();
  const teacher = options.getUser('profesor');
  const title = `${courseName(course)} · ${name}`;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const configuredStaff = settings.get('role_staff');
  const staffRole = configuredStaff && guild.roles.cache.has(configuredStaff) ? configuredStaff : null;
  let role;
  let category;
  try {
    role = await guild.roles.create({ name: title, reason: 'Nuevo grupo de alumnos' });
    // Privado: solo lo ven los alumnos del grupo, su profesor, el staff y el bot.
    const overwrites = (students) => [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: role.id, allow: students },
      { id: client.user.id, allow: BOT },
      ...(staffRole ? [{ id: staffRole, allow: STUDENT }] : []),
      ...(teacher ? [{ id: teacher.id, allow: [...STUDENT, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.MentionEveryone] }] : []),
    ];
    category = await guild.channels.create({ name: `📚 ${title}`, type: ChannelType.GuildCategory, permissionOverwrites: overwrites(STUDENT) });
    const text = (channelName, students) =>
      guild.channels.create({ name: channelName, type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites(students) });
    const announcements = await text('avisos', READ_ONLY);
    const doubts = await text('dudas', STUDENT);
    const submissions = await text('entregas', STUDENT);

    db.prepare(
      `INSERT INTO course_groups (course, name, role_id, category_id, announcements_id, doubts_id, submissions_id, teacher_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(course, name, role.id, category.id, announcements.id, doubts.id, submissions.id, teacher?.id ?? null, Date.now());
  } catch (err) {
    // No se dejan a medias el rol o la categoría.
    for (const child of category?.children?.cache.values() ?? []) await child.delete().catch(() => {});
    await category?.delete().catch(() => {});
    await role?.delete().catch(() => {});
    console.error('[matrícula] No se pudo crear el grupo:', err.message);
    throw new UserError('No he podido crear el grupo. Comprueba que el bot tiene "Gestionar roles" y "Gestionar canales".');
  }
  await interaction.editReply(`Grupo **${title}** creado: rol ${role} y canales en ${category}. Matricula con \`/matricular\` o genera códigos con \`/codigo crear\`.`);
}

async function listGroups(interaction, ctx) {
  const rows = ctx.db
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM enrollments e WHERE e.group_id = g.id) AS students
       FROM course_groups g ORDER BY g.status DESC, g.created_at DESC LIMIT 30`,
    )
    .all();
  if (!rows.length) return interaction.reply(eph('Todavía no hay grupos. Crea uno con `/grupo crear`.'));
  const lines = rows.map(
    (g) =>
      `${g.status === 'open' ? '🟢' : '🔒'} **${label(g)}** — <@&${g.role_id}> · ${g.students} alumnos${g.teacher_id ? ` · profesor <@${g.teacher_id}>` : ''}`,
  );
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Grupos').setDescription(lines.join('\n').slice(0, 4000));
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function listStudents(interaction, ctx) {
  const group = groupFromOption(interaction, ctx.db);
  const rows = ctx.db.prepare('SELECT * FROM enrollments WHERE group_id = ? ORDER BY enrolled_at').all(group.id);
  const lines = rows.map((e) => `<@${e.user_id}> — ${discordTime(e.enrolled_at, 'd')} · ${e.source === 'code' ? 'con código' : `por <@${e.enrolled_by}>`}`);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Alumnos de ${label(group)}`)
    .setDescription((lines.join('\n') || 'Sin alumnos todavía.').slice(0, 4000));
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function closeGroup(interaction, ctx) {
  requireAdmin(interaction);
  const group = groupFromOption(interaction, ctx.db);
  requireOpen(group);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  ctx.db.prepare("UPDATE course_groups SET status = 'closed', closed_at = ? WHERE id = ?").run(Date.now(), group.id);
  const category = await fetchChannel(ctx.client, group.category_id);
  if (category) {
    await category.setName(`🔒 ${label(group)}`).catch(() => {});
    for (const channel of [category, ...(category.children?.cache.values() ?? [])]) {
      await channel.permissionOverwrites.edit(group.role_id, { SendMessages: false, SendMessagesInThreads: false }).catch(() => {});
    }
  }
  await interaction.editReply(`Grupo **${label(group)}** cerrado. Los alumnos conservan el rol y pueden leer los canales, pero ya no escribir.`);
}

async function enrollByStaff(interaction, ctx) {
  const group = groupFromOption(interaction, ctx.db);
  requireOpen(group);
  const member = interaction.options.getMember('alumno');
  if (!member) throw new UserError('Esa persona no está en el servidor.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await enroll(ctx, member, group, 'staff', interaction.user.id);
  await interaction.editReply(`${member} queda matriculado en **${label(group)}**.`);
}

async function unenroll(interaction, ctx) {
  const group = groupFromOption(interaction, ctx.db);
  const user = interaction.options.getUser('alumno', true);
  const member = interaction.options.getMember('alumno');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await member?.roles.remove(group.role_id);
  const { changes } = ctx.db.prepare('DELETE FROM enrollments WHERE group_id = ? AND user_id = ?').run(group.id, user.id);
  await interaction.editReply(changes ? `<@${user.id}> ya no está en **${label(group)}**.` : `<@${user.id}> no estaba matriculado en **${label(group)}**.`);
}

async function createCodes(interaction, ctx) {
  const group = groupFromOption(interaction, ctx.db);
  requireOpen(group);
  const amount = interaction.options.getInteger('cantidad') ?? 1;
  const insert = ctx.db.prepare('INSERT OR IGNORE INTO enroll_codes (code, group_id, created_by, created_at) VALUES (?, ?, ?, ?)');
  const codes = [];
  while (codes.length < amount) {
    const code = generateCode();
    if (insert.run(code, group.id, interaction.user.id, Date.now()).changes) codes.push(code);
  }
  return interaction.reply(
    eph(`Códigos de un solo uso para **${label(group)}**. Envía uno a cada alumno; se canjean con \`/canjear\`.\n\`\`\`\n${codes.join('\n')}\n\`\`\``),
  );
}

async function listCodes(interaction, ctx) {
  const group = groupFromOption(interaction, ctx.db);
  const rows = ctx.db.prepare('SELECT code, used_by FROM enroll_codes WHERE group_id = ? ORDER BY created_at').all(group.id);
  const unused = rows.filter((row) => !row.used_by).map((row) => row.code);
  const text = unused.length ? `\`\`\`\n${unused.join('\n')}\n\`\`\`` : 'No quedan códigos sin usar.';
  return interaction.reply(eph(`**${label(group)}**: ${rows.length - unused.length} canjeados, ${unused.length} sin usar.\n${text}`.slice(0, 1900)));
}

const attempts = new AttemptLimiter();

async function redeem(interaction, ctx) {
  const { db } = ctx;
  const userId = interaction.user.id;
  const now = Date.now();
  if (attempts.blocked(userId, now)) throw new UserError('Demasiados intentos fallidos. Espera unos minutos o escribe al staff.');
  const reject = (message) => {
    attempts.fail(userId, now);
    throw new UserError(message);
  };

  const code = normalizeCode(interaction.options.getString('codigo', true));
  if (!code) reject('Ese código no tiene la forma correcta. Ejemplo: `IA-ABCD-2345`.');
  const row = db.prepare('SELECT * FROM enroll_codes WHERE code = ?').get(code);
  if (!row) reject('Ese código no existe. Revisa que lo has copiado bien.');
  if (row.used_by) reject('Ese código ya se ha usado.');
  const group = db.prepare('SELECT * FROM course_groups WHERE id = ?').get(row.group_id);
  requireOpen(group);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Se marca como usado antes de dar el rol para que dos personas no canjeen el mismo código a la vez.
  const claimed = db.prepare('UPDATE enroll_codes SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL').run(userId, now, code).changes;
  if (!claimed) throw new UserError('Ese código ya se ha usado.');
  try {
    await enroll(ctx, interaction.member, group, 'code');
  } catch (err) {
    db.prepare('UPDATE enroll_codes SET used_by = NULL, used_at = NULL WHERE code = ?').run(code);
    console.error('[matrícula] No se pudo dar el rol del grupo:', err.message);
    throw new UserError('No he podido darte acceso. Tu código sigue siendo válido: avisa al staff.');
  }
  await interaction.editReply(`¡Matrícula completada! Ya tienes acceso a **${label(group)}**${group.announcements_id ? `: empieza por <#${group.announcements_id}>` : ''}.`);
}

async function onCommand(interaction, ctx) {
  const name = interaction.commandName;
  if (name === 'canjear') return redeem(interaction, ctx);

  const sub = name === 'grupo' || name === 'codigo' ? interaction.options.getSubcommand() : null;
  if (name === 'grupo' && sub === 'crear') return createGroup(interaction, ctx);
  if (name === 'grupo' && sub === 'cerrar') return closeGroup(interaction, ctx);

  requireStaff(interaction, ctx.settings);
  if (name === 'grupo') return sub === 'lista' ? listGroups(interaction, ctx) : listStudents(interaction, ctx);
  if (name === 'codigo') return sub === 'crear' ? createCodes(interaction, ctx) : listCodes(interaction, ctx);
  return name === 'matricular' ? enrollByStaff(interaction, ctx) : unenroll(interaction, ctx);
}

export default { id: 'enrollment', name: 'Grupos y matrícula', commands, onCommand };
