import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { canTeach, getGroup, groupLabel, groupOfChannel, isEnrolled, studentGroup, teacherGroup, teacherMention } from './groups.js';
import { discordTime, parseDateTime } from '../../lib/dates.js';
import { truncate } from '../../lib/text.js';
import { progressOf } from './progress.js';
import { UserError, eph, fetchChannel } from '../../util.js';

const STATUS_ICON = { approved: '✅', pending: '⏳', redo: '🔁' };

const commands = [
  new SlashCommandBuilder()
    .setName('ejercicio')
    .setDescription('Ejercicios y proyecto final de un grupo')
    .addSubcommand((sub) =>
      sub
        .setName('crear')
        .setDescription('Publica un ejercicio en los avisos del grupo (profesor)')
        .addStringOption((opt) => opt.setName('titulo').setDescription('Título').setRequired(true).setMaxLength(80))
        .addStringOption((opt) => opt.setName('descripcion').setDescription('Enunciado').setMaxLength(1500))
        .addStringOption((opt) => opt.setName('fecha_limite').setDescription('DD/MM/AAAA HH:MM'))
        .addBooleanOption((opt) => opt.setName('proyecto_final').setDescription('Es el proyecto final del curso')),
    )
    .addSubcommand((sub) => sub.setName('lista').setDescription('Ejercicios del grupo')),
  new SlashCommandBuilder()
    .setName('mi-progreso')
    .setDescription('Tus ejercicios y tu asistencia')
    .addUserOption((opt) => opt.setName('alumno').setDescription('Ver el progreso de un alumno (profesor)')),
];

const getExercise = (db, id) => db.prepare('SELECT * FROM exercises WHERE id = ?').get(id);
const getSubmission = (db, id) => db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
const exerciseTitle = (exercise) => (exercise.is_final ? `Proyecto final: ${exercise.title}` : exercise.title);

function exerciseMessage(exercise) {
  const embed = new EmbedBuilder()
    .setColor(exercise.is_final ? 0xeb459e : 0x5865f2)
    .setTitle(`${exercise.is_final ? '🎓' : '📝'} ${exerciseTitle(exercise)}`)
    .addFields({ name: 'Fecha límite', value: exercise.due_at ? `${discordTime(exercise.due_at, 'F')} (${discordTime(exercise.due_at, 'R')})` : 'Sin fecha' });
  if (exercise.description) embed.setDescription(exercise.description);
  const button = new ButtonBuilder().setCustomId(`coursework:submit:${exercise.id}`).setLabel('Entregar').setStyle(ButtonStyle.Primary);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

function textModal(customId, title, inputs) {
  const rows = inputs.map(([id, label, required, max]) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(required).setMaxLength(max),
    ),
  );
  return new ModalBuilder().setCustomId(customId).setTitle(truncate(title, 45)).addComponents(...rows);
}

async function createExercise(interaction, ctx) {
  const { db, client, settings } = ctx;
  const { options } = interaction;
  const group = teacherGroup(interaction, ctx);
  if (group.status !== 'open') throw new UserError('Este grupo está cerrado.');
  const dueText = options.getString('fecha_limite');
  const dueAt = dueText ? parseDateTime(dueText, settings.get('timezone')) : null;
  if (dueText && !dueAt) throw new UserError('Fecha no válida. Usa el formato `DD/MM/AAAA HH:MM`, por ejemplo `25/10/2026 18:30`.');
  const announcements = await fetchChannel(client, group.announcements_id);
  if (!announcements) throw new UserError('No encuentro el canal de avisos del grupo.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { lastInsertRowid } = db
    .prepare('INSERT INTO exercises (group_id, title, description, due_at, is_final, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(group.id, options.getString('titulo', true), options.getString('descripcion'), dueAt, options.getBoolean('proyecto_final') ? 1 : 0, interaction.user.id, Date.now());
  const exercise = getExercise(db, Number(lastInsertRowid));
  try {
    const message = await announcements.send({ content: `<@&${group.role_id}>`, allowedMentions: { roles: [group.role_id] }, ...exerciseMessage(exercise) });
    db.prepare('UPDATE exercises SET message_id = ? WHERE id = ?').run(message.id, exercise.id);
  } catch {
    db.prepare('DELETE FROM exercises WHERE id = ?').run(exercise.id);
    throw new UserError(`No puedo escribir en ${announcements}. Revisa los permisos del bot.`);
  }
  await interaction.editReply(`Ejercicio publicado en ${announcements}.`);
}

async function listExercises(interaction, ctx) {
  const group = groupOfChannel(ctx.db, interaction.channel) ?? studentGroup(interaction, ctx.db);
  const rows = ctx.db.prepare('SELECT * FROM exercises WHERE group_id = ? ORDER BY id').all(group.id);
  if (!rows.length) return interaction.reply(eph('Este grupo todavía no tiene ejercicios.'));
  const lines = rows.map((x) => `${x.is_final ? '🎓' : '📝'} **${exerciseTitle(x)}**${x.due_at ? ` — hasta ${discordTime(x.due_at, 'f')}` : ''}`);
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`Ejercicios de ${groupLabel(group)}`).setDescription(lines.join('\n').slice(0, 4000));
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function showProgress(interaction, ctx) {
  const { db } = ctx;
  const other = interaction.options.getUser('alumno');
  const viewingOther = other && other.id !== interaction.user.id;
  const group = viewingOther ? teacherGroup(interaction, ctx) : studentGroup(interaction, db);
  const userId = viewingOther ? other.id : interaction.user.id;
  if (!isEnrolled(db, group.id, userId)) throw new UserError('Esa persona no está matriculada en este grupo.');

  const progress = progressOf(db, group.id, userId);
  const lines = progress.exercises.map((x) => `${STATUS_ICON[x.status] ?? '▫️'} ${exerciseTitle(x)}${x.due_at && !x.status ? ` — hasta ${discordTime(x.due_at, 'd')}` : ''}`);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(groupLabel(group))
    .setDescription(`<@${userId}>\n\n${lines.join('\n') || 'Todavía no hay ejercicios.'}`.slice(0, 4000))
    .addFields({ name: 'Asistencia', value: `${progress.attended.length} de ${progress.sessions.length} clases` })
    .setFooter({ text: '✅ aprobado · ⏳ en revisión · 🔁 rehacer · ▫️ sin entregar' });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function onCommand(interaction, ctx) {
  if (interaction.commandName === 'mi-progreso') return showProgress(interaction, ctx);
  return interaction.options.getSubcommand() === 'crear' ? createExercise(interaction, ctx) : listExercises(interaction, ctx);
}

// Botón "Entregar" del anuncio del ejercicio.
async function startSubmission(interaction, ctx, exerciseId) {
  const { db } = ctx;
  const exercise = getExercise(db, exerciseId);
  if (!exercise) throw new UserError('Este ejercicio ya no existe.');
  if (!isEnrolled(db, exercise.group_id, interaction.user.id)) throw new UserError('Solo los alumnos del grupo pueden entregar.');
  const previous = db.prepare('SELECT status FROM submissions WHERE exercise_id = ? AND user_id = ?').get(exerciseId, interaction.user.id);
  if (previous?.status === 'approved') throw new UserError('Ya tienes este ejercicio aprobado.');
  return interaction.showModal(
    textModal(`coursework:send:${exerciseId}`, `Entregar: ${exercise.title}`, [
      ['entrega', 'Enlace a tu trabajo o tu respuesta', true, 1000],
      ['comentario', 'Comentario para el profesor', false, 500],
    ]),
  );
}

// Crea (o reutiliza) el hilo privado del alumno con su profesor y publica ahí la entrega.
async function sendSubmission(interaction, ctx, exerciseId) {
  const { db, client, settings } = ctx;
  const exercise = getExercise(db, exerciseId);
  if (!exercise) throw new UserError('Este ejercicio ya no existe.');
  const group = getGroup(db, exercise.group_id);
  const userId = interaction.user.id;
  const channel = await fetchChannel(client, group.submissions_id);
  if (!channel) throw new UserError('No encuentro el canal de entregas del grupo. Avisa al staff.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const content = interaction.fields.getTextInputValue('entrega').trim();
  const comment = interaction.fields.getTextInputValue('comentario').trim();
  const previous = db.prepare('SELECT * FROM submissions WHERE exercise_id = ? AND user_id = ?').get(exerciseId, userId);
  let thread = previous?.thread_id ? await fetchChannel(client, previous.thread_id) : null;
  if (!thread) {
    thread = await channel.threads.create({
      name: truncate(`${exercise.title} · ${interaction.member?.displayName ?? userId}`, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
    });
    await thread.members.add(userId);
    if (group.teacher_id) await thread.members.add(group.teacher_id).catch(() => {});
  }

  db.prepare(
    `INSERT INTO submissions (exercise_id, user_id, content, status, thread_id, submitted_at) VALUES (?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(exercise_id, user_id) DO UPDATE SET content = excluded.content, status = 'pending', thread_id = excluded.thread_id,
       submitted_at = excluded.submitted_at, feedback = NULL, reviewed_by = NULL, reviewed_at = NULL`,
  ).run(exerciseId, userId, content, thread.id, Date.now());
  const submission = db.prepare('SELECT * FROM submissions WHERE exercise_id = ? AND user_id = ?').get(exerciseId, userId);

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`📤 ${previous ? 'Nueva entrega' : 'Entrega'}: ${exerciseTitle(exercise)}`)
    .setDescription(content)
    .addFields({ name: 'Alumno', value: `<@${userId}>`, inline: true });
  if (comment) embed.addFields({ name: 'Comentario', value: comment });
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`coursework:approve:${submission.id}`).setLabel('Aprobado').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`coursework:redo:${submission.id}`).setLabel('Rehacer').setStyle(ButtonStyle.Danger),
  );
  const mention = teacherMention(group, settings);
  await thread.send({ content: mention.text, allowedMentions: mention.allowedMentions, embeds: [embed], components: [buttons] });
  await interaction.editReply(`Entrega enviada: ${thread}. Ahí puedes adjuntar archivos y hablar con tu profesor.`);
}

// Entrega pendiente que el profesor (o el staff) puede corregir.
function reviewable(interaction, ctx, submissionId) {
  const submission = getSubmission(ctx.db, submissionId);
  if (!submission) throw new UserError('Esta entrega ya no existe.');
  const exercise = getExercise(ctx.db, submission.exercise_id);
  if (!canTeach(interaction, ctx.settings, getGroup(ctx.db, exercise.group_id))) throw new UserError('Solo el profesor del grupo o el staff puede corregir.');
  if (submission.status !== 'pending') throw new UserError('Esta entrega ya está corregida.');
  return { submission, exercise };
}

async function approve(interaction, ctx, submissionId) {
  const { submission, exercise } = reviewable(interaction, ctx, submissionId);
  ctx.db.prepare("UPDATE submissions SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(interaction.user.id, Date.now(), submissionId);
  const embed = EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x57f287).addFields({ name: 'Resultado', value: `✅ Aprobado por ${interaction.user}` });
  await interaction.update({ embeds: [embed], components: [] });
  await interaction.followUp({
    content: `<@${submission.user_id}> tu entrega de **${exerciseTitle(exercise)}** está aprobada. ¡Buen trabajo!`,
    allowedMentions: { users: [submission.user_id] },
  });
}

async function askFeedback(interaction, ctx, submissionId) {
  reviewable(interaction, ctx, submissionId);
  return interaction.showModal(textModal(`coursework:feedback:${submissionId}`, 'Qué hay que mejorar', [['comentario', 'Explícale al alumno qué debe cambiar', true, 1000]]));
}

async function sendFeedback(interaction, ctx, submissionId) {
  const { submission, exercise } = reviewable(interaction, ctx, submissionId);
  const feedback = interaction.fields.getTextInputValue('comentario').trim();
  ctx.db
    .prepare("UPDATE submissions SET status = 'redo', feedback = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?")
    .run(feedback, interaction.user.id, Date.now(), submissionId);
  await interaction.message?.edit({ components: [] }).catch(() => {});
  await interaction.reply({
    content: `<@${submission.user_id}> 🔁 hay que rehacer **${exerciseTitle(exercise)}**.\n> ${feedback.replaceAll('\n', '\n> ')}\nCuando lo tengas, vuelve a pulsar **Entregar** en el anuncio del ejercicio.`,
    allowedMentions: { users: [submission.user_id] },
  });
}

async function onComponent(interaction, ctx, action, arg) {
  const handlers = { submit: startSubmission, send: sendSubmission, approve, redo: askFeedback, feedback: sendFeedback };
  return handlers[action]?.(interaction, ctx, Number(arg));
}

export default { id: 'coursework', name: 'Ejercicios y entregas', commands, onCommand, onComponent };
