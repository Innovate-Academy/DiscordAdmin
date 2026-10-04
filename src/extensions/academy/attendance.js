import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { dmIfOptedIn } from '../../dm.js';
import { groupLabel, studentGroup, teacherGroup } from './groups.js';
import { UserError, eph, fetchChannel } from '../../util.js';

const commands = [
  new SlashCommandBuilder()
    .setName('sesion')
    .setDescription('Asistencia de una clase en vivo (profesor)')
    .addSubcommand((sub) =>
      sub
        .setName('abrir')
        .setDescription('Empieza a pasar lista: los alumnos registran la palabra que digas en clase')
        .addStringOption((opt) => opt.setName('palabra').setDescription('Palabra clave que dirás en clase').setRequired(true).setMaxLength(30)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('cerrar')
        .setDescription('Cierra la lista y publica el resumen de la clase')
        .addStringOption((opt) => opt.setName('grabacion').setDescription('Enlace a la grabación').setMaxLength(300))
        .addStringOption((opt) => opt.setName('recursos').setDescription('Enlaces o notas de la clase').setMaxLength(1000)),
    ),
  new SlashCommandBuilder()
    .setName('asistencia')
    .setDescription('Registra tu asistencia a la clase de hoy')
    .addStringOption((opt) => opt.setName('palabra').setDescription('La palabra clave que ha dicho el profesor').setRequired(true).setMaxLength(30)),
];

const normalize = (word) => word.trim().toLowerCase();
const openSession = (db, groupId) => db.prepare('SELECT * FROM class_sessions WHERE group_id = ? AND closed_at IS NULL').get(groupId);

async function open(interaction, ctx) {
  const group = teacherGroup(interaction, ctx);
  if (group.status !== 'open') throw new UserError('Este grupo está cerrado.');
  if (openSession(ctx.db, group.id)) throw new UserError('Ya hay una clase abierta en este grupo. Ciérrala antes con `/sesion cerrar`.');
  const keyword = normalize(interaction.options.getString('palabra', true));
  ctx.db.prepare('INSERT INTO class_sessions (group_id, keyword, opened_by, opened_at) VALUES (?, ?, ?, ?)').run(group.id, keyword, interaction.user.id, Date.now());
  return interaction.reply(eph(`Lista abierta. Di en clase la palabra **${keyword}**: los alumnos la registran con \`/asistencia\`. Al terminar, usa \`/sesion cerrar\`.`));
}

async function close(interaction, ctx) {
  const { db, client } = ctx;
  const group = teacherGroup(interaction, ctx);
  const session = openSession(db, group.id);
  if (!session) throw new UserError('No hay ninguna clase abierta en este grupo.');
  const recording = interaction.options.getString('grabacion')?.trim() || null;
  const resources = interaction.options.getString('recursos')?.trim() || null;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  db.prepare('UPDATE class_sessions SET closed_at = ?, recording = ?, resources = ? WHERE id = ?').run(Date.now(), recording, resources, session.id);
  const enrolled = db.prepare('SELECT user_id FROM enrollments WHERE group_id = ?').all(group.id).map((row) => row.user_id);
  const present = new Set(db.prepare('SELECT user_id FROM attendance WHERE session_id = ?').all(session.id).map((row) => row.user_id));
  const absent = enrolled.filter((id) => !present.has(id));

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📋 Resumen de la clase')
    .addFields({ name: 'Asistencia', value: `${enrolled.length - absent.length} de ${enrolled.length} alumnos` });
  if (recording) embed.addFields({ name: 'Grabación', value: recording });
  if (resources) embed.addFields({ name: 'Recursos', value: resources });
  const announcements = await fetchChannel(client, group.announcements_id);
  await announcements?.send({ embeds: [embed] }).catch((err) => console.error('[asistencia] No se pudo publicar el resumen:', err.message));

  // Quien faltó y tiene los avisos activados recibe el resumen por privado.
  const summary = [
    `Te perdiste la clase de **${groupLabel(group)}**. Para ponerte al día:`,
    recording && `Grabación: ${recording}`,
    resources && `Recursos: ${resources}`,
    !recording && !resources && 'Mira el canal de avisos de tu grupo o pregunta en dudas.',
  ]
    .filter(Boolean)
    .join('\n');
  for (const userId of absent) await dmIfOptedIn(ctx, userId, summary);

  const missing = absent.length ? `Faltaron: ${absent.map((id) => `<@${id}>`).join(', ')}` : 'No faltó nadie.';
  await interaction.editReply(`Clase cerrada: asistieron ${enrolled.length - absent.length} de ${enrolled.length}. ${missing}`.slice(0, 1900));
}

async function attend(interaction, ctx) {
  const { db } = ctx;
  const group = studentGroup(interaction, db);
  const session = openSession(db, group.id);
  if (!session) throw new UserError('Ahora mismo no hay ninguna clase abierta en tu grupo.');
  if (normalize(interaction.options.getString('palabra', true)) !== session.keyword) throw new UserError('Esa no es la palabra de hoy. Revisa cómo la ha dicho el profesor.');
  db.prepare('INSERT OR IGNORE INTO attendance (session_id, user_id, at) VALUES (?, ?, ?)').run(session.id, interaction.user.id, Date.now());
  return interaction.reply(eph('✅ Asistencia registrada.'));
}

async function onCommand(interaction, ctx) {
  if (interaction.commandName === 'asistencia') return attend(interaction, ctx);
  return interaction.options.getSubcommand() === 'abrir' ? open(interaction, ctx) : close(interaction, ctx);
}

export default { id: 'attendance', name: 'Asistencia', commands, onCommand };
