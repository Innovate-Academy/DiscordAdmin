import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { discordTime, parseDuration } from '../lib/dates.js';
import { pickWinners } from '../lib/giveaway.js';
import { UserError, eph, fetchChannel, requireStaff } from '../util.js';

const command = new SlashCommandBuilder()
  .setName('sorteo')
  .setDescription('Sorteos')
  .addSubcommand((sub) =>
    sub
      .setName('crear')
      .setDescription('Crea un sorteo en este canal (staff)')
      .addStringOption((opt) => opt.setName('premio').setDescription('Qué se sortea').setRequired(true).setMaxLength(200))
      .addStringOption((opt) => opt.setName('duracion').setDescription('Por ejemplo 30m, 2h, 1d o 1h30m').setRequired(true))
      .addIntegerOption((opt) => opt.setName('ganadores').setDescription('Número de ganadores (por defecto 1)').setMinValue(1).setMaxValue(20)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('repetir')
      .setDescription('Vuelve a elegir ganadores de un sorteo terminado (staff)')
      .addIntegerOption((opt) => opt.setName('id').setDescription('Número del sorteo').setRequired(true).setMinValue(1)),
  );

const getGiveaway = (db, id) => db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id);
const getEntries = (db, id) => db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?').all(id).map((row) => row.user_id);
const mentions = (userIds) => userIds.map((id) => `<@${id}>`).join(', ');

function giveawayMessage(giveaway, entryCount, winners = null) {
  const embed = new EmbedBuilder()
    .setColor(giveaway.ended ? 0x99aab5 : 0xeb459e)
    .setTitle(`🎁 Sorteo: ${giveaway.prize}`)
    .addFields(
      { name: giveaway.ended ? 'Terminó' : 'Termina', value: `${discordTime(giveaway.ends_at, 'F')} (${discordTime(giveaway.ends_at, 'R')})` },
      { name: 'Ganadores', value: String(giveaway.winners), inline: true },
      { name: 'Participantes', value: String(entryCount), inline: true },
    )
    .setFooter({ text: `Sorteo #${giveaway.id}` });
  if (winners) embed.addFields({ name: 'Resultado', value: winners.length ? mentions(winners) : 'Nadie participó' });
  const button = new ButtonBuilder()
    .setCustomId(`giveaways:join:${giveaway.id}`)
    .setLabel('Participar / Salir')
    .setEmoji('🎉')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(Boolean(giveaway.ended));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

async function announceWinners(channel, giveaway, winners) {
  if (!winners.length) return channel.send(`El sorteo de **${giveaway.prize}** ha terminado sin participantes.`);
  return channel.send({
    content: `🎉 ¡Enhorabuena ${mentions(winners)}! Has ganado **${giveaway.prize}**.`,
    allowedMentions: { users: winners },
  });
}

async function finish(ctx, giveaway) {
  const { db, client } = ctx;
  // Se marca como terminado antes de enviar nada para no repetirlo si falla el envío.
  db.prepare('UPDATE giveaways SET ended = 1 WHERE id = ?').run(giveaway.id);
  const entries = getEntries(db, giveaway.id);
  const winners = pickWinners(entries, giveaway.winners);
  const channel = await fetchChannel(client, giveaway.channel_id);
  if (!channel?.isTextBased()) return;
  const message = giveaway.message_id ? await channel.messages.fetch(giveaway.message_id).catch(() => null) : null;
  await message?.edit(giveawayMessage({ ...giveaway, ended: 1 }, entries.length, winners)).catch(() => {});
  await announceWinners(channel, giveaway, winners);
}

async function onCommand(interaction, ctx) {
  const { db } = ctx;
  requireStaff(interaction, ctx.settings);

  if (interaction.options.getSubcommand() === 'crear') {
    const duration = parseDuration(interaction.options.getString('duracion', true));
    if (!duration) throw new UserError('Duración no válida. Ejemplos: `30m`, `2h`, `1d`, `1h30m`.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { lastInsertRowid } = db
      .prepare('INSERT INTO giveaways (prize, winners, ends_at, channel_id) VALUES (?, ?, ?, ?)')
      .run(interaction.options.getString('premio', true), interaction.options.getInteger('ganadores') ?? 1, Date.now() + duration, interaction.channelId);
    const giveaway = getGiveaway(db, Number(lastInsertRowid));
    try {
      const message = await interaction.channel.send(giveawayMessage(giveaway, 0));
      db.prepare('UPDATE giveaways SET message_id = ? WHERE id = ?').run(message.id, giveaway.id);
    } catch {
      db.prepare('DELETE FROM giveaways WHERE id = ?').run(giveaway.id);
      throw new UserError('No puedo escribir en este canal. Revisa los permisos del bot.');
    }
    return interaction.editReply(`Sorteo #${giveaway.id} creado.`);
  }

  const giveaway = getGiveaway(db, interaction.options.getInteger('id', true));
  if (!giveaway) throw new UserError('No existe ningún sorteo con ese número.');
  if (!giveaway.ended) throw new UserError('Ese sorteo todavía no ha terminado.');
  const winners = pickWinners(getEntries(db, giveaway.id), giveaway.winners);
  await interaction.reply({ content: `Nuevo resultado del sorteo #${giveaway.id}:`, flags: MessageFlags.Ephemeral });
  return announceWinners(interaction.channel, giveaway, winners);
}

async function onComponent(interaction, ctx, action, arg) {
  if (action !== 'join') return;
  const { db } = ctx;
  const giveaway = getGiveaway(db, Number(arg));
  if (!giveaway || giveaway.ended) throw new UserError('Este sorteo ya ha terminado.');

  const userId = interaction.user.id;
  const joined = db.prepare('SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?').get(giveaway.id, userId);
  if (joined) db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?').run(giveaway.id, userId);
  else db.prepare('INSERT INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)').run(giveaway.id, userId);

  await interaction.update(giveawayMessage(giveaway, getEntries(db, giveaway.id).length));
  await interaction.followUp(eph(joined ? 'Has salido del sorteo.' : '¡Estás dentro del sorteo! Suerte.'));
}

async function tick(ctx, now) {
  const due = ctx.db.prepare('SELECT * FROM giveaways WHERE ended = 0 AND ends_at <= ?').all(now);
  for (const giveaway of due) {
    await finish(ctx, giveaway).catch((err) => console.error(`[sorteos] No se pudo cerrar el sorteo #${giveaway.id}:`, err.message));
  }
}

export default { id: 'giveaways', name: 'Sorteos', commands: [command], onCommand, onComponent, tick };
