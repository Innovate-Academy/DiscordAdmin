import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import { canTeach, getGroup, groupOfChannel, studentGroup, teacherMention } from './groups.js';
import { getCourse, looksLikeUnformattedCode } from './courses.js';
import { truncate } from '../../lib/text.js';
import { UserError, eph, fetchChannel, isMemberMessage, safe } from '../../util.js';

const HOUR = 3_600_000;
const REMIND_AFTER_MS = 12 * HOUR;
const TIP_COOLDOWN_MS = 24 * HOUR;

const commands = [
  new SlashCommandBuilder().setName('duda').setDescription('Pregunta una duda de código a tu grupo'),
  new SlashCommandBuilder().setName('ayudantes').setDescription('Quién ha resuelto más dudas de sus compañeros'),
];

const getDoubt = (db, id) => db.prepare('SELECT * FROM doubts WHERE id = ?').get(id);
const codeBlock = (text, lang = '') => `\`\`\`${lang}\n${truncate(text.replaceAll('```', "'''"), 1800)}\n\`\`\``;

function askModal(groupId) {
  const input = (id, label, style, required, max) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max),
    );
  return new ModalBuilder()
    .setCustomId(`doubts:ask:${groupId}`)
    .setTitle('Nueva duda')
    .addComponents(
      input('titulo', 'Título corto', TextInputStyle.Short, true, 80),
      input('intento', '¿Qué intentas hacer?', TextInputStyle.Paragraph, true, 500),
      input('codigo', 'Tu código', TextInputStyle.Paragraph, false, 1500),
      input('error', 'Error o resultado que obtienes', TextInputStyle.Paragraph, false, 500),
    );
}

function doubtMessage(doubt) {
  const resolved = doubt.status === 'resolved';
  const embed = new EmbedBuilder()
    .setColor(resolved ? 0x57f287 : 0xfee75c)
    .setTitle(`${resolved ? '✅' : '❓'} ${doubt.title}`)
    .setDescription(doubt.attempt)
    .addFields({ name: 'Alumno', value: `<@${doubt.user_id}>`, inline: true });
  if (resolved) embed.addFields({ name: 'Ayudó', value: doubt.helper_id ? `<@${doubt.helper_id}>` : 'Resuelta por su cuenta', inline: true });
  const button = new ButtonBuilder().setCustomId(`doubts:resolve:${doubt.id}`).setLabel('Marcar como resuelta').setStyle(ButtonStyle.Success);
  return { embeds: [embed], components: resolved ? [] : [new ActionRowBuilder().addComponents(button)] };
}

async function ask(interaction, ctx, groupId) {
  const { db, client } = ctx;
  const group = getGroup(db, groupId);
  const channel = await fetchChannel(client, group?.doubts_id);
  if (!channel) throw new UserError('No encuentro el canal de dudas del grupo. Avisa al staff.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const field = (name) => interaction.fields.getTextInputValue(name).trim();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO doubts (group_id, user_id, title, attempt, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(group.id, interaction.user.id, field('titulo'), field('intento'), channel.id, Date.now());
  const doubt = getDoubt(db, Number(lastInsertRowid));

  const message = await channel.send(doubtMessage(doubt));
  const thread = await message.startThread({ name: truncate(`Duda: ${doubt.title}`, 90), autoArchiveDuration: 1440 });
  if (field('codigo')) await thread.send(codeBlock(field('codigo'), getCourse(group.course)?.lang));
  if (field('error')) await thread.send(`**Error o resultado:**\n${codeBlock(field('error'))}`);
  db.prepare('UPDATE doubts SET message_id = ?, thread_id = ? WHERE id = ?').run(message.id, thread.id, doubt.id);
  await interaction.editReply(`Duda publicada: ${thread}. Cuando te la resuelvan, pulsa **Marcar como resuelta**.`);
}

// Primer paso para cerrar una duda: preguntar quién ayudó.
async function resolve(interaction, ctx, id) {
  const doubt = getDoubt(ctx.db, id);
  if (!doubt || doubt.status !== 'open') throw new UserError('Esta duda ya estaba resuelta.');
  if (doubt.user_id !== interaction.user.id && !canTeach(interaction, ctx.settings, getGroup(ctx.db, doubt.group_id))) {
    throw new UserError('Solo quien preguntó o el profesor puede cerrar la duda.');
  }
  const select = new UserSelectMenuBuilder().setCustomId(`doubts:helper:${id}`).setPlaceholder('¿Quién ayudó?');
  const solo = new ButtonBuilder().setCustomId(`doubts:solo:${id}`).setLabel('Se resolvió sin ayuda').setStyle(ButtonStyle.Secondary);
  await interaction.reply({
    content: 'Elige a la persona que ayudó: se lleva un punto de ayudante.',
    components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(solo)],
    flags: MessageFlags.Ephemeral,
  });
}

async function finish(interaction, ctx, id, helperId) {
  const { db, client } = ctx;
  const doubt = getDoubt(db, id);
  if (!doubt || doubt.status !== 'open') throw new UserError('Esta duda ya estaba resuelta.');
  if (helperId === doubt.user_id) throw new UserError('Quien pregunta no puede llevarse el punto. Elige a otra persona o "Se resolvió sin ayuda".');
  if (helperId && interaction.users?.get(helperId)?.bot) throw new UserError('Un bot no puede llevarse el punto.');

  db.prepare("UPDATE doubts SET status = 'resolved', helper_id = ?, resolved_at = ? WHERE id = ?").run(helperId, Date.now(), id);
  if (helperId) {
    db.prepare('INSERT INTO help_points (user_id, points) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET points = points + 1').run(helperId);
  }
  await interaction.update({ content: helperId ? `Duda resuelta. <@${helperId}> se lleva un punto de ayudante.` : 'Duda resuelta.', components: [] });

  const channel = await fetchChannel(client, doubt.channel_id);
  const message = doubt.message_id ? await channel?.messages.fetch(doubt.message_id).catch(() => null) : null;
  await message?.edit(doubtMessage({ ...doubt, status: 'resolved', helper_id: helperId })).catch(() => {});
  const thread = await fetchChannel(client, doubt.thread_id);
  await thread?.setArchived(true).catch(() => {});
}

async function onCommand(interaction, ctx) {
  if (interaction.commandName === 'duda') {
    const group = studentGroup(interaction, ctx.db);
    return interaction.showModal(askModal(group.id));
  }
  const rows = ctx.db.prepare('SELECT user_id, points FROM help_points ORDER BY points DESC LIMIT 10').all();
  if (!rows.length) return interaction.reply(eph('Todavía nadie tiene puntos de ayudante. Se ganan resolviendo dudas de compañeros.'));
  const lines = rows.map((row, i) => `**${i + 1}.** <@${row.user_id}> · ${row.points} ${row.points === 1 ? 'duda resuelta' : 'dudas resueltas'}`);
  const embed = new EmbedBuilder().setColor(0x57f287).setTitle('🤝 Mejores ayudantes').setDescription(lines.join('\n'));
  return interaction.reply({ embeds: [embed] });
}

async function onComponent(interaction, ctx, action, arg) {
  if (action === 'ask') return ask(interaction, ctx, Number(arg));
  if (action === 'resolve') return resolve(interaction, ctx, Number(arg));
  if (action === 'helper') return finish(interaction, ctx, Number(arg), interaction.values[0]);
  if (action === 'solo') return finish(interaction, ctx, Number(arg), null);
}

function register(client, ctx) {
  const tipped = new Map();
  // En los canales de un grupo, sugiere el bloque de código a quien pega código suelto.
  client.on(
    Events.MessageCreate,
    safe('dudas', async (message) => {
      if (!isMemberMessage(message, ctx) || !looksLikeUnformattedCode(message.content)) return;
      const group = groupOfChannel(ctx.db, message.channel);
      if (!group) return;
      const now = Date.now();
      if (now - (tipped.get(message.author.id) ?? 0) < TIP_COOLDOWN_MS) return;
      tipped.set(message.author.id, now);
      const lang = getCourse(group.course)?.lang ?? '';
      await message.reply({
        content: `💡 Para que el código se lea bien, escribe \\\`\\\`\\\`${lang} en una línea, tu código debajo y \\\`\\\`\\\` al final.`,
        allowedMentions: { repliedUser: false },
      });
    }),
  );
}

// Si una duda lleva 12 horas sin que nadie más escriba en su hilo, se avisa al profesor.
async function tick(ctx, now) {
  const { db, client, settings } = ctx;
  const stale = db.prepare("SELECT * FROM doubts WHERE status = 'open' AND reminded = 0 AND thread_id IS NOT NULL AND created_at <= ?").all(now - REMIND_AFTER_MS);
  for (const doubt of stale) {
    db.prepare('UPDATE doubts SET reminded = 1 WHERE id = ?').run(doubt.id);
    const { replies } = db
      .prepare('SELECT COUNT(*) AS replies FROM messages WHERE channel_id = ? AND author_id NOT IN (?, ?)')
      .get(doubt.thread_id, doubt.user_id, client.user.id);
    if (replies) continue;
    const thread = await fetchChannel(client, doubt.thread_id);
    const mention = teacherMention(getGroup(db, doubt.group_id), settings);
    await thread
      ?.send({ content: `⏰ ${mention.text ? `${mention.text} ` : ''}esta duda lleva 12 horas sin respuesta.`, allowedMentions: mention.allowedMentions })
      .catch((err) => console.error(`[dudas] No se pudo avisar de la duda #${doubt.id}:`, err.message));
  }
}

export default { id: 'doubts', name: 'Dudas con "Resuelto"', commands, register, onCommand, onComponent, tick };
