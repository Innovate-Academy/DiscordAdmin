import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { dmIfOptedIn } from '../dm.js';
import { GRACE_MS, discordTime, parseDateTime } from '../lib/dates.js';
import { chunkMentions, isHttpUrl } from '../lib/text.js';
import { UserError, eph, fetchChannel, requireChannel, requireStaff } from '../util.js';

const REMIND_BEFORE_MS = 15 * 60_000;
const DEFAULT_DURATION_MS = 3_600_000;

const command = new SlashCommandBuilder()
  .setName('evento')
  .setDescription('Eventos del servidor')
  .addSubcommand((sub) =>
    sub
      .setName('crear')
      .setDescription('Crea y anuncia un evento con inscripción (staff)')
      .addStringOption((opt) => opt.setName('titulo').setDescription('Título del evento').setRequired(true).setMaxLength(100))
      .addStringOption((opt) => opt.setName('fecha').setDescription('DD/MM/AAAA HH:MM, por ejemplo 25/10/2026 18:30').setRequired(true))
      .addStringOption((opt) => opt.setName('descripcion').setDescription('De qué va el evento').setRequired(true).setMaxLength(1000))
      .addStringOption((opt) => opt.setName('lugar').setDescription('Dónde será (por defecto, Discord)').setMaxLength(100))
      .addStringOption((opt) => opt.setName('enlace').setDescription('Enlace para entrar (videollamada, directo...)').setMaxLength(100))
      .addRoleOption((opt) => opt.setName('rol').setDescription('Rol al que avisar en el anuncio')),
  )
  .addSubcommand((sub) => sub.setName('lista').setDescription('Próximos eventos'))
  .addSubcommand((sub) =>
    sub
      .setName('cancelar')
      .setDescription('Cancela un evento (staff)')
      .addIntegerOption((opt) => opt.setName('id').setDescription('Número del evento').setRequired(true).setMinValue(1)),
  );

const getEvent = (db, id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id);
const countSignups = (db, id) => db.prepare('SELECT COUNT(*) AS total FROM event_signups WHERE event_id = ?').get(id).total;

function announcement(event, signups) {
  const embed = new EmbedBuilder()
    .setColor(event.cancelled ? 0xed4245 : 0x5865f2)
    .setTitle(`${event.cancelled ? '❌ CANCELADO · ' : '📅 '}${event.title}`)
    .setDescription(event.description)
    .addFields(
      { name: 'Cuándo', value: `${discordTime(event.starts_at, 'F')} (${discordTime(event.starts_at, 'R')})` },
      { name: 'Dónde', value: event.location ?? 'Discord', inline: true },
      { name: 'Inscritos', value: String(signups), inline: true },
    )
    .setFooter({ text: `Evento #${event.id}` });
  if (event.link) embed.addFields({ name: 'Enlace', value: event.link });
  const button = new ButtonBuilder()
    .setCustomId(`events:toggle:${event.id}`)
    .setLabel('Me apunto / Me borro')
    .setStyle(ButtonStyle.Success)
    .setDisabled(Boolean(event.cancelled));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

// Valida los datos, crea el evento en la pestaña Eventos de Discord, lo guarda y lo anuncia.
// Lo usan /evento crear y las extensiones que publican eventos propios. Deja la interacción en espera
// (deferReply): quien llama responde después con editReply.
export async function publishEvent(interaction, ctx, { title, description, dateText, location = null, link = null, mentionRoleId = null }) {
  const { db, settings } = ctx;
  const startsAt = parseDateTime(dateText, settings.get('timezone'));
  if (!startsAt) throw new UserError('Fecha no válida. Usa el formato `DD/MM/AAAA HH:MM`, por ejemplo `25/10/2026 18:30`.');
  if (startsAt <= Date.now()) throw new UserError('La fecha tiene que ser futura.');
  if (link && !isHttpUrl(link)) throw new UserError('El enlace tiene que empezar por http:// o https://');
  const channel = await requireChannel(ctx, 'channel_events', 'el canal de eventos');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let nativeId = null;
  let warning = '';
  try {
    const native = await interaction.guild.scheduledEvents.create({
      name: title,
      description,
      scheduledStartTime: new Date(startsAt),
      scheduledEndTime: new Date(startsAt + DEFAULT_DURATION_MS),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: link ?? location ?? 'Discord' },
    });
    nativeId = native.id;
  } catch (err) {
    console.error('[eventos] No se pudo crear el evento nativo:', err.message);
    warning = '\n⚠️ No pude crearlo en la pestaña Eventos de Discord (¿le falta al bot el permiso "Gestionar eventos"?).';
  }

  const { lastInsertRowid } = db
    .prepare('INSERT INTO events (title, description, location, link, starts_at, channel_id, discord_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(title, description, location, link, startsAt, channel.id, nativeId);
  const event = getEvent(db, Number(lastInsertRowid));
  try {
    const message = await channel.send({
      content: mentionRoleId ? `<@&${mentionRoleId}>` : undefined,
      allowedMentions: { roles: mentionRoleId ? [mentionRoleId] : [] },
      ...announcement(event, 0),
    });
    db.prepare('UPDATE events SET message_id = ? WHERE id = ?').run(message.id, event.id);
  } catch (err) {
    db.prepare('DELETE FROM events WHERE id = ?').run(event.id);
    if (nativeId) await interaction.guild.scheduledEvents.delete(nativeId).catch(() => {});
    throw new UserError(`No puedo escribir en ${channel}. Revisa los permisos del bot en ese canal.`);
  }
  return { event, channel, warning };
}

async function create(interaction, ctx) {
  requireStaff(interaction, ctx.settings);
  const { options } = interaction;
  const { event, channel, warning } = await publishEvent(interaction, ctx, {
    title: options.getString('titulo', true),
    description: options.getString('descripcion', true),
    dateText: options.getString('fecha', true),
    location: options.getString('lugar'),
    link: options.getString('enlace')?.trim() || null,
    mentionRoleId: options.getRole('rol')?.id ?? null,
  });
  await interaction.editReply(`Evento #${event.id} publicado en ${channel}.${warning}`);
}

async function list(interaction, ctx) {
  const rows = ctx.db
    .prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM event_signups s WHERE s.event_id = e.id) AS signups
       FROM events e WHERE e.cancelled = 0 AND e.starts_at > ? ORDER BY e.starts_at LIMIT 15`,
    )
    .all(Date.now());
  if (!rows.length) return interaction.reply(eph('No hay eventos próximos.'));
  const lines = rows.map((e) => `**#${e.id} · ${e.title}** — ${discordTime(e.starts_at, 'f')} · ${e.signups} inscritos`);
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📅 Próximos eventos').setDescription(lines.join('\n'));
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function cancel(interaction, ctx) {
  const { db, client } = ctx;
  requireStaff(interaction, ctx.settings);
  const event = getEvent(db, interaction.options.getInteger('id', true));
  if (!event || event.cancelled) throw new UserError('No existe ningún evento activo con ese número.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  db.prepare('UPDATE events SET cancelled = 1 WHERE id = ?').run(event.id);
  if (event.discord_event_id) await interaction.guild.scheduledEvents.delete(event.discord_event_id).catch(() => {});
  const channel = await fetchChannel(client, event.channel_id);
  const message = event.message_id ? await channel?.messages.fetch(event.message_id).catch(() => null) : null;
  await message?.edit(announcement({ ...event, cancelled: 1 }, countSignups(db, event.id))).catch(() => {});
  return interaction.editReply(`Evento #${event.id} cancelado.`);
}

async function onCommand(interaction, ctx) {
  const handlers = { crear: create, lista: list, cancelar: cancel };
  return handlers[interaction.options.getSubcommand()](interaction, ctx);
}

async function onComponent(interaction, ctx, action, arg) {
  if (action !== 'toggle') return;
  const { db } = ctx;
  const event = getEvent(db, Number(arg));
  if (!event || event.cancelled) throw new UserError('Este evento ya no está disponible.');
  if (event.starts_at <= Date.now()) throw new UserError('Este evento ya ha empezado.');

  const userId = interaction.user.id;
  const signedUp = db.prepare('SELECT 1 FROM event_signups WHERE event_id = ? AND user_id = ?').get(event.id, userId);
  if (signedUp) db.prepare('DELETE FROM event_signups WHERE event_id = ? AND user_id = ?').run(event.id, userId);
  else db.prepare('INSERT INTO event_signups (event_id, user_id) VALUES (?, ?)').run(event.id, userId);

  await interaction.update(announcement(event, countSignups(db, event.id)));
  await interaction.followUp(
    eph(signedUp ? 'Te has borrado del evento.' : `¡Apuntado! Te avisaré 15 minutos antes de **${event.title}**.`),
  );
}

async function tick(ctx, now) {
  const { db, client } = ctx;
  const due = db.prepare('SELECT * FROM events WHERE reminded = 0 AND cancelled = 0 AND starts_at - ? <= ?').all(REMIND_BEFORE_MS, now);
  for (const event of due) {
    db.prepare('UPDATE events SET reminded = 1 WHERE id = ?').run(event.id);
    // Si el bot estuvo apagado y el evento ya pasó, no se avisa tarde.
    if (now > event.starts_at + GRACE_MS) continue;
    const channel = await fetchChannel(client, event.channel_id);
    if (!channel?.isTextBased()) continue;
    try {
      const text = `📅 **${event.title}** empieza ${discordTime(event.starts_at, 'R')}.${event.link ? `\nEnlace: ${event.link}` : ''}`;
      await channel.send(text);
      const signups = db.prepare('SELECT user_id FROM event_signups WHERE event_id = ?').all(event.id);
      for (const chunk of chunkMentions(signups.map((row) => row.user_id))) await channel.send(chunk);
      // Además, por privado a quien se apuntó y tiene activados los avisos.
      for (const { user_id } of signups) await dmIfOptedIn(ctx, user_id, text);
    } catch (err) {
      console.error(`[eventos] No se pudo avisar del evento #${event.id}:`, err.message);
    }
  }
}

export default { id: 'events', name: 'Eventos con inscripción', commands: [command], onCommand, onComponent, tick };
