import { ChannelType, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { WEEKDAYS, discordTime, parseTime, weeklyDue } from '../lib/dates.js';
import { isHttpUrl } from '../lib/text.js';
import { UserError, eph, fetchChannel, requireStaff } from '../util.js';

// De lunes a domingo; el valor es el día de la semana de JavaScript (0 = domingo).
const DAY_CHOICES = [1, 2, 3, 4, 5, 6, 0].map((value) => ({ name: WEEKDAYS[value], value }));

const command = new SlashCommandBuilder()
  .setName('aviso-semanal')
  .setDescription('Avisos que se repiten cada semana: clases, reuniones, directos...')
  .addSubcommand((sub) =>
    sub
      .setName('programar')
      .setDescription('Programa un aviso que se repite cada semana (staff)')
      .addStringOption((opt) => opt.setName('nombre').setDescription('Qué se anuncia').setRequired(true).setMaxLength(100))
      .addIntegerOption((opt) => opt.setName('dia').setDescription('Día de la semana').setRequired(true).addChoices(...DAY_CHOICES))
      .addStringOption((opt) => opt.setName('hora').setDescription('Hora de inicio, HH:MM (por ejemplo 18:30)').setRequired(true))
      .addChannelOption((opt) =>
        opt.setName('canal').setDescription('Canal donde avisar').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addRoleOption((opt) => opt.setName('rol').setDescription('Rol al que mencionar'))
      .addIntegerOption((opt) =>
        opt.setName('aviso_minutos').setDescription('Minutos de antelación del aviso (por defecto 10)').setMinValue(0).setMaxValue(120),
      )
      .addStringOption((opt) => opt.setName('enlace').setDescription('Enlace para entrar (videollamada, directo...)')),
  )
  .addSubcommand((sub) => sub.setName('lista').setDescription('Avisos programados'))
  .addSubcommand((sub) =>
    sub
      .setName('borrar')
      .setDescription('Borra un aviso programado (staff)')
      .addIntegerOption((opt) => opt.setName('id').setDescription('Número del aviso').setRequired(true).setMinValue(1)),
  );

async function onCommand(interaction, ctx) {
  const { db, settings } = ctx;
  const options = interaction.options;

  switch (options.getSubcommand()) {
    case 'programar': {
      requireStaff(interaction, settings);
      const time = parseTime(options.getString('hora', true));
      if (!time) throw new UserError('Hora no válida. Usa el formato `HH:MM`, por ejemplo `18:30`.');
      const link = options.getString('enlace')?.trim() || null;
      if (link && !isHttpUrl(link)) throw new UserError('El enlace tiene que empezar por http:// o https://');
      const weekday = options.getInteger('dia', true);
      const channel = options.getChannel('canal', true);
      const { lastInsertRowid } = db
        .prepare('INSERT INTO weekly_reminders (name, weekday, time, lead_minutes, channel_id, role_id, link) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(options.getString('nombre', true), weekday, time, options.getInteger('aviso_minutos') ?? 10, channel.id, options.getRole('rol')?.id ?? null, link);
      return interaction.reply(
        eph(`Aviso #${lastInsertRowid} programado: cada ${WEEKDAYS[weekday]} a las ${time} (${settings.get('timezone')}) en ${channel}.`),
      );
    }
    case 'lista': {
      const rows = db.prepare('SELECT * FROM weekly_reminders ORDER BY (weekday + 6) % 7, time').all();
      if (!rows.length) return interaction.reply(eph('No hay avisos programados.'));
      const lines = rows.map(
        (r) => `**#${r.id} · ${r.name}** — ${WEEKDAYS[r.weekday]} ${r.time} en <#${r.channel_id}>${r.role_id ? ` para <@&${r.role_id}>` : ''}`,
      );
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🗓️ Avisos semanales').setDescription(lines.join('\n'));
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    case 'borrar': {
      requireStaff(interaction, settings);
      const id = options.getInteger('id', true);
      const { changes } = db.prepare('DELETE FROM weekly_reminders WHERE id = ?').run(id);
      if (!changes) throw new UserError('No existe ningún aviso con ese número.');
      return interaction.reply(eph(`Aviso #${id} borrado.`));
    }
  }
}

async function tick(ctx, now) {
  const { db, client, settings } = ctx;
  const timeZone = settings.get('timezone');
  for (const reminder of db.prepare('SELECT * FROM weekly_reminders').all()) {
    const start = weeklyDue(reminder, now, timeZone);
    if (!start) continue;
    db.prepare('UPDATE weekly_reminders SET last_sent = ? WHERE id = ?').run(now, reminder.id);
    const channel = await fetchChannel(client, reminder.channel_id);
    if (!channel?.isTextBased()) continue;
    await channel
      .send({
        content: `${reminder.role_id ? `<@&${reminder.role_id}> ` : ''}🗓️ **${reminder.name}** empieza ${discordTime(start, 'R')}.${reminder.link ? `\nEnlace: ${reminder.link}` : ''}`,
        allowedMentions: { roles: reminder.role_id ? [reminder.role_id] : [] },
      })
      .catch((err) => console.error(`[avisos semanales] No se pudo enviar el aviso #${reminder.id}:`, err.message));
  }
}

export default { id: 'weekly', name: 'Avisos semanales', commands: [command], onCommand, tick };
