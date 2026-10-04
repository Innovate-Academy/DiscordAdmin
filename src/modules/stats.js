import { EmbedBuilder, Events, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { wallClock } from '../lib/dates.js';
import { registry } from '../registry.js';
import { sendModLog } from '../sanctions.js';
import { requireStaff, safe } from '../util.js';

const DAY = 86_400_000;
const MONDAY = 1;
const REPORT_HOUR = 9;

const command = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('Altas, bajas, actividad y retención del servidor (staff)')
  .addIntegerOption((opt) => opt.setName('dias').setDescription('Periodo en días (por defecto 7)').setMinValue(1).setMaxValue(30));

// Anota una entrada ('join'), una salida ('leave') o una verificación ('verify').
export function recordMemberEvent(db, userId, type, at = Date.now()) {
  db.prepare('INSERT INTO member_events (user_id, type, at) VALUES (?, ?, ?)').run(userId, type, at);
}

export function computeStats(db, since, now) {
  const total = (sql, ...params) => db.prepare(sql).get(...params).total;
  const events = (type) => total('SELECT COUNT(*) AS total FROM member_events WHERE type = ? AND at >= ? AND at <= ?', type, since, now);

  // Retención: de quienes entraron hace entre 7 y 14 días, cuántos no se han ido después.
  const cohort = db.prepare("SELECT user_id, MAX(at) AS joined FROM member_events WHERE type = 'join' AND at >= ? AND at < ? GROUP BY user_id").all(now - 14 * DAY, now - 7 * DAY);
  const stayed = cohort.filter(
    ({ user_id, joined }) => !db.prepare("SELECT 1 FROM member_events WHERE user_id = ? AND type = 'leave' AND at > ?").get(user_id, joined),
  ).length;

  return {
    joins: events('join'),
    leaves: events('leave'),
    verified: events('verify'),
    messages: total('SELECT COUNT(*) AS total FROM messages WHERE created_at >= ?', since),
    activeMembers: total('SELECT COUNT(DISTINCT author_id) AS total FROM messages WHERE created_at >= ?', since),
    retention: { cohort: cohort.length, stayed },
  };
}

function statsEmbed(db, days, now) {
  const since = now - days * DAY;
  const stats = computeStats(db, since, now);
  const net = stats.joins - stats.leaves;
  const { cohort, stayed } = stats.retention;
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📊 Últimos ${days} días`)
    .addFields(
      { name: 'Miembros', value: `Altas: ${stats.joins}\nBajas: ${stats.leaves}\nNeto: ${net >= 0 ? '+' : ''}${net}\nVerificados: ${stats.verified}`, inline: true },
      { name: 'Actividad', value: `Mensajes: ${stats.messages}\nPersonas activas: ${stats.activeMembers}`, inline: true },
      // Las extensiones añaden aquí sus propias cifras.
      ...registry.statsFields.map((build) => build(db, since, now)),
      { name: 'Retención a 7 días', value: cohort ? `${stayed} de ${cohort} (${Math.round((stayed / cohort) * 100)} %) siguen en el servidor` : 'Sin datos todavía' },
    );
}

function register(client, ctx) {
  const record = (type) =>
    safe('estadísticas', (member) => {
      if (member.guild.id === ctx.guildId && !member.user?.bot) recordMemberEvent(ctx.db, member.id, type);
    });
  client.on(Events.GuildMemberAdd, record('join'));
  client.on(Events.GuildMemberRemove, record('leave'));
}

async function onCommand(interaction, ctx) {
  requireStaff(interaction, ctx.settings);
  const days = interaction.options.getInteger('dias') ?? 7;
  return interaction.reply({ embeds: [statsEmbed(ctx.db, days, Date.now())], flags: MessageFlags.Ephemeral });
}

// Resumen semanal, cada lunes por la mañana, en el canal de moderación.
async function tick(ctx, now) {
  const { db, settings } = ctx;
  const clock = wallClock(now, settings.get('timezone'));
  if (clock.weekday !== MONDAY || clock.hour < REPORT_HOUR) return;
  const today = `${clock.year}-${clock.month}-${clock.day}`;
  if (settings.get('last_stats') === today) return;
  settings.set('last_stats', today);
  await sendModLog(ctx, { embeds: [statsEmbed(db, 7, now)] });
}

export default { id: 'stats', name: 'Estadísticas del servidor', commands: [command], register, onCommand, tick };
