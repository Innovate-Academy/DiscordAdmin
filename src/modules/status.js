import { statSync } from 'node:fs';
import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { discordTime } from '../lib/dates.js';
import { requireStaff } from '../util.js';

const MB = 1024 * 1024;

const command = new SlashCommandBuilder().setName('estado').setDescription('Salud del bot: desde cuándo está encendido, memoria, base de datos y copias (staff)');

const megabytes = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

function databaseSize(path) {
  try {
    return megabytes(statSync(path).size);
  } catch {
    return 'sin datos';
  }
}

async function onCommand(interaction, ctx) {
  const { db, settings, client } = ctx;
  requireStaff(interaction, settings);
  const startedAt = Date.now() - process.uptime() * 1000;
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM messages').get();
  const ping = client.ws?.ping;
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Estado del bot')
    .addFields(
      { name: 'Encendido', value: discordTime(startedAt, 'R'), inline: true },
      { name: 'Conexión con Discord', value: ping >= 0 ? `${Math.round(ping)} ms` : 'sin datos', inline: true },
      { name: 'Memoria', value: megabytes(process.memoryUsage().rss), inline: true },
      { name: 'Base de datos', value: `${ctx.dbPath ? databaseSize(ctx.dbPath) : 'en memoria'} · ${total} mensajes en el registro`, inline: true },
      { name: 'Última copia diaria', value: settings.get('last_backup') ?? 'todavía ninguna', inline: true },
      { name: 'Node', value: process.version, inline: true },
    );
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

export default { id: 'status', name: 'Estado del bot', required: true, commands: [command], onCommand };
