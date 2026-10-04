import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { dmIfOptedIn } from '../../dm.js';
import { groupLabel } from './groups.js';
import { wallClock } from '../../lib/dates.js';
import { progressOf, riskReasons } from './progress.js';
import { sendModLog } from '../../sanctions.js';
import { eph, requireStaff } from '../../util.js';

const MONDAY = 1;
const REPORT_HOUR = 9;

const command = new SlashCommandBuilder().setName('radar').setDescription('Alumnos en riesgo de abandonar, por grupo (staff)');

// Alumnos con señales de abandono en cada grupo abierto. Los grupos sin nadie en riesgo no aparecen.
export function buildRadar(db, now) {
  return db
    .prepare("SELECT * FROM course_groups WHERE status = 'open' ORDER BY id")
    .all()
    .map((group) => ({
      group,
      students: db
        .prepare('SELECT user_id FROM enrollments WHERE group_id = ? ORDER BY enrolled_at')
        .all(group.id)
        .map(({ user_id }) => ({ userId: user_id, reasons: riskReasons(progressOf(db, group.id, user_id), now) }))
        .filter((student) => student.reasons.length),
    }))
    .filter((entry) => entry.students.length);
}

function radarEmbed(report) {
  const sections = report.map(
    ({ group, students }) => `**${groupLabel(group)}**\n${students.map((s) => `<@${s.userId}>: ${s.reasons.join('; ')}`).join('\n')}`,
  );
  return new EmbedBuilder().setColor(0xe67e22).setTitle('📡 Alumnos en riesgo de abandono').setDescription(sections.join('\n\n').slice(0, 4000));
}

async function onCommand(interaction, ctx) {
  requireStaff(interaction, ctx.settings);
  const report = buildRadar(ctx.db, Date.now());
  if (!report.length) return interaction.reply(eph('Ningún alumno muestra señales de abandono ahora mismo.'));
  return interaction.reply({ embeds: [radarEmbed(report)], flags: MessageFlags.Ephemeral });
}

// Cada lunes por la mañana: informe al canal de moderación y un privado amable a quien tenga los avisos activados.
async function tick(ctx, now) {
  const { db, settings } = ctx;
  const clock = wallClock(now, settings.get('timezone'));
  if (clock.weekday !== MONDAY || clock.hour < REPORT_HOUR) return;
  const today = `${clock.year}-${clock.month}-${clock.day}`;
  if (settings.get('last_radar') === today) return;
  settings.set('last_radar', today);

  const report = buildRadar(db, now);
  if (!report.length) return;
  const supervisor = settings.get('role_supervisor');
  await sendModLog(ctx, {
    content: supervisor ? `<@&${supervisor}>` : undefined,
    embeds: [radarEmbed(report)],
    allowedMentions: { roles: supervisor ? [supervisor] : [] },
  });
  for (const { group, students } of report) {
    for (const { userId, reasons } of students) {
      await dmIfOptedIn(
        ctx,
        userId,
        `Hola. En **${groupLabel(group)}** hemos visto esto: ${reasons.join('; ')}. Si te has atascado o te ha surgido algo, cuéntaselo a tu profesor o pregunta con \`/duda\`: estamos para ayudarte.`,
      );
    }
  }
}

export default { id: 'radar', name: 'Radar de abandono', commands: [command], onCommand, tick };
