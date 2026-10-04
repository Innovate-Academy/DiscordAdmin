import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getGroup, groupLabel, isEnrolled, teacherGroup } from './groups.js';
import { courseName, generateCode, getCourse, normalizeCode } from './courses.js';
import { discordTime } from '../../lib/dates.js';
import { progressOf } from './progress.js';
import { UserError, eph, fetchChannel } from '../../util.js';

const MIN_ATTENDANCE = 0.7;

const commands = [
  new SlashCommandBuilder()
    .setName('graduar')
    .setDescription('Gradúa a un alumno del grupo y emite su certificado (profesor)')
    .addUserOption((opt) => opt.setName('alumno').setDescription('Alumno').setRequired(true))
    .addBooleanOption((opt) => opt.setName('forzar').setDescription('Graduar aunque no cumpla los requisitos')),
  new SlashCommandBuilder()
    .setName('certificado')
    .setDescription('Certificados de Innovate Academy')
    .addSubcommand((sub) =>
      sub
        .setName('verificar')
        .setDescription('Comprueba si un certificado es auténtico')
        .addStringOption((opt) => opt.setName('codigo').setDescription('Código del certificado, por ejemplo CERT-ABCD-2345').setRequired(true).setMaxLength(30)),
    )
    .addSubcommand((sub) => sub.setName('mios').setDescription('Tus certificados')),
];

// Lo que le falta a un alumno para graduarse. Lista vacía = cumple.
export function missingRequirements(progress) {
  const missing = [];
  const pendingFinals = progress.exercises.filter((exercise) => exercise.is_final && exercise.status !== 'approved');
  if (pendingFinals.length) missing.push(`proyecto final sin aprobar (${pendingFinals.map((x) => x.title).join(', ')})`);
  if (progress.sessions.length && progress.attended.length / progress.sessions.length < MIN_ATTENDANCE) {
    missing.push(`asistencia de ${progress.attended.length} de ${progress.sessions.length} clases (mínimo ${MIN_ATTENDANCE * 100} %)`);
  }
  return missing;
}

async function graduate(interaction, ctx) {
  const { db, settings, client } = ctx;
  const group = teacherGroup(interaction, ctx);
  const user = interaction.options.getUser('alumno', true);
  const member = interaction.options.getMember('alumno');
  if (!isEnrolled(db, group.id, user.id)) throw new UserError('Esa persona no está matriculada en este grupo.');

  const existing = db.prepare('SELECT code FROM certificates WHERE group_id = ? AND user_id = ?').get(group.id, user.id);
  if (existing) throw new UserError(`<@${user.id}> ya está graduado de este grupo. Su certificado es \`${existing.code}\`.`);
  const missing = missingRequirements(progressOf(db, group.id, user.id));
  if (missing.length && !interaction.options.getBoolean('forzar')) {
    throw new UserError(`<@${user.id}> aún no cumple los requisitos: ${missing.join('; ')}. Si aun así quieres graduarlo, repite el comando con \`forzar\`.`);
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const insert = db.prepare('INSERT OR IGNORE INTO certificates (code, user_id, group_id, issued_by, issued_at) VALUES (?, ?, ?, ?, ?)');
  let code;
  do code = generateCode(undefined, 'CERT');
  while (!insert.run(code, user.id, group.id, interaction.user.id, Date.now()).changes);

  const graduateRole = settings.get('role_graduate');
  if (graduateRole && member) {
    await member.roles.add(graduateRole).catch((err) => console.error('[graduación] No se pudo dar el rol de graduado:', err.message));
  }

  const next = getCourse(group.course)?.next;
  const embed = new EmbedBuilder()
    .setColor(0xeb459e)
    .setTitle('🎓 ¡Enhorabuena!')
    .setDescription(`<@${user.id}> ha completado **${courseName(group.course)}**.`)
    .addFields({ name: 'Certificado', value: `\`${code}\` · cualquiera puede comprobarlo con \`/certificado verificar\`` });
  embed.addFields({ name: 'Tu proyecto', value: 'Enséñalo con `/proyecto` para que aparezca en el escaparate.' });
  if (next) embed.addFields({ name: 'Siguiente paso recomendado', value: courseName(next) });
  const announcements = await fetchChannel(client, group.announcements_id);
  await announcements?.send({ content: `<@${user.id}>`, embeds: [embed], allowedMentions: { users: [user.id] } }).catch(() => {});
  await interaction.editReply(`<@${user.id}> graduado de **${groupLabel(group)}**. Certificado: \`${code}\`.`);
}

function describe(db, certificate) {
  const group = getGroup(db, certificate.group_id);
  return `**${courseName(group.course)}** (${group.name}) · ${discordTime(certificate.issued_at, 'D')} · \`${certificate.code}\``;
}

async function onCommand(interaction, ctx) {
  const { db } = ctx;
  if (interaction.commandName === 'graduar') return graduate(interaction, ctx);

  if (interaction.options.getSubcommand() === 'mios') {
    const rows = db.prepare('SELECT * FROM certificates WHERE user_id = ? ORDER BY issued_at').all(interaction.user.id);
    return interaction.reply(eph(rows.length ? rows.map((row) => `🎓 ${describe(db, row)}`).join('\n') : 'Todavía no tienes certificados.'));
  }
  const code = normalizeCode(interaction.options.getString('codigo', true), 'CERT');
  const certificate = code ? db.prepare('SELECT * FROM certificates WHERE code = ?').get(code) : null;
  if (!certificate) return interaction.reply(eph('❌ No existe ningún certificado con ese código.'));
  return interaction.reply({
    content: `✅ Certificado auténtico de <@${certificate.user_id}>: ${describe(db, certificate)}`,
    allowedMentions: { parse: [] },
    flags: MessageFlags.Ephemeral,
  });
}

export default { id: 'graduation', name: 'Graduación y certificados', commands, onCommand };
