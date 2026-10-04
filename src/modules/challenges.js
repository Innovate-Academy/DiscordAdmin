import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { discordTime } from '../lib/dates.js';
import { truncate } from '../lib/text.js';
import { grantXp } from './levels.js';
import { UserError, eph, fetchChannel, requireStaff } from '../util.js';

const DAY = 86_400_000;

const command = new SlashCommandBuilder()
  .setName('reto')
  .setDescription('Retos de programación')
  .addSubcommand((sub) =>
    sub
      .setName('crear')
      .setDescription('Publica un reto (staff)')
      .addStringOption((opt) => opt.setName('titulo').setDescription('Título').setRequired(true).setMaxLength(80))
      .addStringOption((opt) => opt.setName('descripcion').setDescription('Enunciado').setRequired(true).setMaxLength(1500))
      .addIntegerOption((opt) => opt.setName('dias').setDescription('Días que estará abierto (por defecto 7)').setMinValue(1).setMaxValue(30))
      .addIntegerOption((opt) => opt.setName('xp').setDescription('XP por participar (por defecto 100)').setMinValue(0).setMaxValue(1000))
      .addStringOption((opt) => opt.setName('tema').setDescription('Tema del reto, por ejemplo un lenguaje').setMaxLength(40)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('cerrar')
      .setDescription('Cierra un reto antes de tiempo (staff)')
      .addIntegerOption((opt) => opt.setName('id').setDescription('Número del reto').setRequired(true).setMinValue(1)),
  );

const getChallenge = (db, id) => db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
const countEntries = (db, id) => db.prepare('SELECT COUNT(*) AS total FROM challenge_entries WHERE challenge_id = ?').get(id).total;

function challengeMessage(challenge, entries) {
  const embed = new EmbedBuilder()
    .setColor(challenge.closed ? 0x99aab5 : 0xe67e22)
    .setTitle(`🧩 Reto: ${challenge.title}`)
    .setDescription(challenge.description)
    .addFields(
      { name: challenge.closed ? 'Cerrado' : 'Cierra', value: `${discordTime(challenge.ends_at, 'F')} (${discordTime(challenge.ends_at, 'R')})` },
      { name: 'Premio', value: `${challenge.xp} XP por participar`, inline: true },
      { name: 'Participantes', value: String(entries), inline: true },
    )
    .setFooter({ text: `Reto #${challenge.id}${challenge.topic ? ` · ${challenge.topic}` : ''} · Las soluciones se ven al cerrar` });
  const button = new ButtonBuilder()
    .setCustomId(`challenges:enter:${challenge.id}`)
    .setLabel('Enviar solución')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(Boolean(challenge.closed));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

// Cierra el reto: reparte la XP, actualiza las rachas y publica las soluciones en un hilo.
async function closeChallenge(ctx, challenge) {
  const { db, client } = ctx;
  // El reto anterior, para saber si alguien mantiene la racha.
  const previous = db.prepare('SELECT id FROM challenges WHERE closed = 1 AND id < ? ORDER BY id DESC LIMIT 1').get(challenge.id)?.id ?? null;
  db.prepare('UPDATE challenges SET closed = 1 WHERE id = ?').run(challenge.id);

  const entries = db.prepare('SELECT * FROM challenge_entries WHERE challenge_id = ? ORDER BY at').all(challenge.id);
  for (const entry of entries) {
    if (challenge.xp) grantXp(db, entry.user_id, challenge.xp);
    const streak = db.prepare('SELECT streak, last_challenge_id FROM challenge_streaks WHERE user_id = ?').get(entry.user_id);
    const next = streak && previous !== null && streak.last_challenge_id === previous ? streak.streak + 1 : 1;
    db.prepare(
      'INSERT INTO challenge_streaks (user_id, streak, last_challenge_id) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET streak = excluded.streak, last_challenge_id = excluded.last_challenge_id',
    ).run(entry.user_id, next, challenge.id);
  }

  const channel = await fetchChannel(client, challenge.channel_id);
  if (!channel?.isTextBased()) return;
  const message = challenge.message_id ? await channel.messages.fetch(challenge.message_id).catch(() => null) : null;
  await message?.edit(challengeMessage({ ...challenge, closed: 1 }, entries.length)).catch(() => {});
  if (!entries.length) return channel.send(`🧩 El reto **${challenge.title}** ha terminado sin participantes.`);

  await channel.send(`🏁 Reto **${challenge.title}** cerrado: ${entries.length} participantes, ${challenge.xp} XP para cada uno. Las soluciones están en el hilo.`);
  const thread = await message?.startThread({ name: truncate(`Soluciones: ${challenge.title}`, 90) }).catch(() => null);
  for (const entry of entries) {
    await thread?.send({ content: `**<@${entry.user_id}>**\n${truncate(entry.content, 1800)}`, allowedMentions: { parse: [] } }).catch(() => {});
  }
}

async function onCommand(interaction, ctx) {
  const { db, client, settings } = ctx;
  const { options } = interaction;
  requireStaff(interaction, settings);

  if (options.getSubcommand() === 'cerrar') {
    const challenge = getChallenge(db, options.getInteger('id', true));
    if (!challenge || challenge.closed) throw new UserError('No existe ningún reto abierto con ese número.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await closeChallenge(ctx, challenge);
    return interaction.editReply(`Reto #${challenge.id} cerrado.`);
  }

  const channel = (await fetchChannel(client, settings.get('channel_challenges'))) ?? interaction.channel;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { lastInsertRowid } = db
    .prepare('INSERT INTO challenges (title, description, topic, xp, channel_id, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      options.getString('titulo', true),
      options.getString('descripcion', true),
      options.getString('tema'),
      options.getInteger('xp') ?? 100,
      channel.id,
      Date.now() + (options.getInteger('dias') ?? 7) * DAY,
      interaction.user.id,
      Date.now(),
    );
  const challenge = getChallenge(db, Number(lastInsertRowid));
  try {
    const message = await channel.send(challengeMessage(challenge, 0));
    db.prepare('UPDATE challenges SET message_id = ? WHERE id = ?').run(message.id, challenge.id);
  } catch {
    db.prepare('DELETE FROM challenges WHERE id = ?').run(challenge.id);
    throw new UserError(`No puedo escribir en ${channel}. Revisa los permisos del bot.`);
  }
  return interaction.editReply(`Reto #${challenge.id} publicado en ${channel}.`);
}

async function onComponent(interaction, ctx, action, arg) {
  const { db } = ctx;
  const challenge = getChallenge(db, Number(arg));
  if (!challenge || challenge.closed) throw new UserError('Este reto ya está cerrado.');

  if (action === 'enter') {
    const input = new TextInputBuilder()
      .setCustomId('solucion')
      .setLabel('Tu solución: código o enlace')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1800);
    const modal = new ModalBuilder().setCustomId(`challenges:send:${challenge.id}`).setTitle(truncate(`Reto: ${challenge.title}`, 45));
    return interaction.showModal(modal.addComponents(new ActionRowBuilder().addComponents(input)));
  }
  if (action !== 'send') return;

  // Se puede corregir la solución hasta el cierre: cuenta la última.
  const first = !db.prepare('SELECT 1 FROM challenge_entries WHERE challenge_id = ? AND user_id = ?').get(challenge.id, interaction.user.id);
  db.prepare(
    'INSERT INTO challenge_entries (challenge_id, user_id, content, at) VALUES (?, ?, ?, ?) ON CONFLICT(challenge_id, user_id) DO UPDATE SET content = excluded.content, at = excluded.at',
  ).run(challenge.id, interaction.user.id, interaction.fields.getTextInputValue('solucion').trim(), Date.now());
  await interaction.reply(eph(first ? '¡Solución recibida! Puedes cambiarla hasta que cierre el reto.' : 'Solución actualizada.'));
  if (first) {
    const channel = await fetchChannel(ctx.client, challenge.channel_id);
    const message = challenge.message_id ? await channel?.messages.fetch(challenge.message_id).catch(() => null) : null;
    await message?.edit(challengeMessage(challenge, countEntries(db, challenge.id))).catch(() => {});
  }
}

async function tick(ctx, now) {
  const due = ctx.db.prepare('SELECT * FROM challenges WHERE closed = 0 AND ends_at <= ?').all(now);
  for (const challenge of due) {
    await closeChallenge(ctx, challenge).catch((err) => console.error(`[retos] No se pudo cerrar el reto #${challenge.id}:`, err.message));
  }
}

export default { id: 'challenges', name: 'Retos', commands: [command], onCommand, onComponent, tick };
