import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { onDutyId } from '../duty.js';
import { WEEKDAYS, formatDuration, wallClock } from '../lib/dates.js';
import { registry } from '../registry.js';
import { sendModLog } from '../sanctions.js';
import { eph, requireAdmin, requireStaff } from '../util.js';

const DAY = 86_400_000;
const MONDAY = 1;
const REPORT_HOUR = 9;
// De lunes a domingo; el valor es el día de la semana de JavaScript (0 = domingo).
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const dayOption = (opt) => opt.setName('dia').setDescription('Día de la semana').setRequired(true).addChoices(...WEEK.map((value) => ({ name: WEEKDAYS[value], value })));

const commands = [
  new SlashCommandBuilder()
    .setName('guardia')
    .setDescription('Quién recibe los avisos urgentes cada día')
    .addSubcommand((sub) =>
      sub
        .setName('asignar')
        .setDescription('Pone a una persona de guardia un día de la semana (admin)')
        .addIntegerOption(dayOption)
        .addUserOption((opt) => opt.setName('persona').setDescription('Miembro del staff').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('quitar').setDescription('Deja un día sin guardia (admin)').addIntegerOption(dayOption))
    .addSubcommand((sub) => sub.setName('ver').setDescription('Calendario de guardias (staff)')),
  new SlashCommandBuilder()
    .setName('carga')
    .setDescription('Trabajo del staff y plazos de respuesta de los tickets (staff)')
    .addIntegerOption((opt) => opt.setName('dias').setDescription('Periodo en días (por defecto 7)').setMinValue(1).setMaxValue(30)),
];

// De dónde sale el trabajo de cada persona. Las extensiones añaden más fuentes en registry.workloadSources.
const CORE_SOURCES = [
  {
    key: 'tickets',
    label: 'tickets',
    // Un ticket cerrado por quien lo abrió no es trabajo del staff.
    sql: 'SELECT closed_by AS user_id, COUNT(*) AS total FROM tickets WHERE closed_at >= ? AND closed_by IS NOT NULL AND closed_by != user_id GROUP BY closed_by',
    params: (since) => [since],
  },
  {
    key: 'sanctions',
    label: 'sanciones',
    sql: 'SELECT moderator_id AS user_id, COUNT(*) AS total FROM sanctions WHERE created_at >= ? AND moderator_id != ? GROUP BY moderator_id',
    params: (since, botId) => [since, botId],
  },
];
const sources = () => [...CORE_SOURCES, ...registry.workloadSources];

// Lo que ha hecho cada persona del staff desde `since`, y cómo van los plazos de los tickets.
export function computeWorkload(db, since, now, botId) {
  const people = new Map();
  for (const source of sources()) {
    for (const { user_id, total } of db.prepare(source.sql).all(...source.params(since, botId))) {
      if (!people.has(user_id)) people.set(user_id, Object.fromEntries(sources().map(({ key }) => [key, 0])));
      people.get(user_id)[source.key] += total;
    }
  }
  const tickets = db
    .prepare(
      `SELECT COUNT(*) AS opened,
              AVG(first_response_at - created_at) AS average,
              COALESCE(SUM(CASE WHEN COALESCE(first_response_at, ?) - created_at > ? THEN 1 ELSE 0 END), 0) AS late
       FROM tickets WHERE created_at >= ?`,
    )
    .get(now, DAY, since);
  return { people, tickets };
}

function workloadEmbed({ people, tickets }, days) {
  const total = (person) => Object.values(person).reduce((sum, amount) => sum + amount, 0);
  const lines = [...people.entries()]
    .sort(([, a], [, b]) => total(b) - total(a))
    .map(([id, person]) => `<@${id}> — ${sources().map(({ key, label }) => `${person[key]} ${label}`).join(' · ')}`);
  const sla = tickets.opened
    ? `${tickets.opened} abiertos · primera respuesta en ${tickets.average === null ? 'sin datos' : formatDuration(tickets.average)} de media · ${tickets.late} sin respuesta en 24 h`
    : 'Ningún ticket en el periodo.';
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🧰 Trabajo del staff · últimos ${days} días`)
    .setDescription((lines.join('\n') || 'Sin actividad registrada.').slice(0, 4000))
    .addFields({ name: 'Tickets', value: sla });
}

async function onCommand(interaction, ctx) {
  const { db, client, settings } = ctx;
  const { options } = interaction;

  if (interaction.commandName === 'carga') {
    requireStaff(interaction, settings);
    const days = options.getInteger('dias') ?? 7;
    const now = Date.now();
    return interaction.reply({ embeds: [workloadEmbed(computeWorkload(db, now - days * DAY, now, client.user.id), days)], flags: MessageFlags.Ephemeral });
  }

  const sub = options.getSubcommand();
  if (sub === 'ver') {
    requireStaff(interaction, settings);
    const duty = new Map(db.prepare('SELECT weekday, user_id FROM duty').all().map((row) => [row.weekday, row.user_id]));
    const today = onDutyId(ctx);
    const lines = WEEK.map((day) => `**${WEEKDAYS[day]}:** ${duty.has(day) ? `<@${duty.get(day)}>` : '*nadie*'}`);
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Guardias')
      .setDescription(lines.join('\n'))
      .setFooter({ text: today ? 'La persona de guardia recibe la mención en las alertas y en los tickets sin responder.' : 'Hoy no hay nadie de guardia.' });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  requireAdmin(interaction);
  const day = options.getInteger('dia', true);
  if (sub === 'quitar') {
    db.prepare('DELETE FROM duty WHERE weekday = ?').run(day);
    return interaction.reply(eph(`El ${WEEKDAYS[day]} queda sin guardia.`));
  }
  const user = options.getUser('persona', true);
  db.prepare('INSERT INTO duty (weekday, user_id) VALUES (?, ?) ON CONFLICT(weekday) DO UPDATE SET user_id = excluded.user_id').run(day, user.id);
  return interaction.reply(eph(`<@${user.id}> está de guardia los ${WEEKDAYS[day]}.`));
}

// Resumen semanal del trabajo del staff, cada lunes por la mañana, en el canal de moderación.
async function tick(ctx, now) {
  const { db, client, settings } = ctx;
  const clock = wallClock(now, settings.get('timezone'));
  if (clock.weekday !== MONDAY || clock.hour < REPORT_HOUR) return;
  const today = `${clock.year}-${clock.month}-${clock.day}`;
  if (settings.get('last_workload') === today) return;
  settings.set('last_workload', today);
  await sendModLog(ctx, { embeds: [workloadEmbed(computeWorkload(db, now - 7 * DAY, now, client.user.id), 7)], allowedMentions: { parse: [] } });
}

export default { id: 'staffing', name: 'Guardias y carga del staff', commands, onCommand, tick };
