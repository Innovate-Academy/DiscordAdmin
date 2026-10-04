import { SlashCommandBuilder } from 'discord.js';
import { publishEvent } from '../../modules/events.js';
import { fetchChannel, requireStaff } from '../../util.js';
import { COURSES, courseLine, courseName, getCourse, interestOfCourse } from './courses.js';
import { interestRoleKey } from './onboarding.js';

const FOLLOW_UP_AFTER_MS = 90 * 60_000;
const DAY = 86_400_000;

const command = new SlashCommandBuilder()
  .setName('taller')
  .setDescription('Talleres abiertos: clases de prueba para quien aún no es alumno')
  .addSubcommand((sub) =>
    sub
      .setName('crear')
      .setDescription('Publica un taller abierto como evento con inscripción (staff)')
      .addStringOption((opt) => opt.setName('titulo').setDescription('Título del taller').setRequired(true).setMaxLength(80))
      .addStringOption((opt) => opt.setName('fecha').setDescription('DD/MM/AAAA HH:MM, por ejemplo 25/10/2026 18:30').setRequired(true))
      .addStringOption((opt) => opt.setName('descripcion').setDescription('Qué se hará en el taller').setRequired(true).setMaxLength(1000))
      .addStringOption((opt) =>
        opt.setName('curso').setDescription('Curso que da a probar').setRequired(true).addChoices(...COURSES.map(({ id, name }) => ({ name, value: id }))),
      )
      .addStringOption((opt) => opt.setName('enlace').setDescription('Enlace para entrar (Google Meet)').setMaxLength(100)),
  );

// Un taller es un evento normal del bot que, además, avisa solo a quienes eligieron ese interés
// y deja un único mensaje con el curso cuando termina.
async function onCommand(interaction, ctx) {
  const { db, settings } = ctx;
  const { options } = interaction;
  requireStaff(interaction, settings);
  const course = options.getString('curso', true);
  const { event, channel, warning } = await publishEvent(interaction, ctx, {
    title: `Taller abierto: ${options.getString('titulo', true)}`,
    description: options.getString('descripcion', true),
    dateText: options.getString('fecha', true),
    link: options.getString('enlace')?.trim() || null,
    // El rol de interés solo existe si alguien lo ha elegido ya.
    mentionRoleId: settings.get(interestRoleKey(interestOfCourse(course).id)),
  });
  db.prepare('INSERT INTO workshops (event_id, course) VALUES (?, ?)').run(event.id, course);
  await interaction.editReply(`Taller #${event.id} (${courseName(course)}) publicado en ${channel}.${warning}`);
}

async function tick(ctx, now) {
  const { db, client } = ctx;
  const finished = db
    .prepare(
      `SELECT e.*, w.course FROM workshops w JOIN events e ON e.id = w.event_id
       WHERE w.followup_sent = 0 AND e.cancelled = 0 AND e.starts_at <= ?`,
    )
    .all(now - FOLLOW_UP_AFTER_MS);
  for (const event of finished) {
    db.prepare('UPDATE workshops SET followup_sent = 1 WHERE event_id = ?').run(event.id);
    // Si el bot estuvo apagado y ya ha pasado un día, no se envía a destiempo.
    if (now > event.starts_at + DAY) continue;
    const channel = await fetchChannel(client, event.channel_id);
    await channel
      ?.send(`🎓 ¿Te gustó **${event.title}**? El curso completo: ${courseLine(getCourse(event.course))}, con clases en vivo dos veces por semana. Míralo con \`/cursos\`.`)
      .catch((err) => console.error(`[talleres] No se pudo enviar el mensaje posterior al taller #${event.id}:`, err.message));
  }
}

export default { id: 'workshops', name: 'Talleres abiertos', commands: [command], onCommand, tick };
