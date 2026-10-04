// Extensión de Innovate Academy: todo lo que es propio de una academia con cursos, grupos y clases en vivo.
// Se apoya en los puntos de extensión del núcleo (src/registry.js) y no modifica ningún archivo suyo.
import { ButtonStyle } from 'discord.js';
// Los módulos del núcleo que registran opciones se cargan antes, para que las suyas vayan primero.
import '../../modules/config.js';
import '../../modules/tickets.js';
import { registerConfig, registerMigrations, registerTicketKind, registry } from '../../registry.js';
import attendance from './attendance.js';
import catalog from './catalog.js';
import classDms from './classDms.js';
import { INTERESTS } from './courses.js';
import coursework from './coursework.js';
import doubts from './doubts.js';
import enrollment from './enrollment.js';
import graduation from './graduation.js';
import onboarding, { interestMenu } from './onboarding.js';
import radar from './radar.js';
import workshops from './workshops.js';

// Cambios de base de datos de la extensión, en orden. Un paso publicado nunca se edita ni se borra.
registerMigrations('academy', [
  `CREATE TABLE course_groups (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     course TEXT NOT NULL,
     name TEXT NOT NULL,
     role_id TEXT NOT NULL UNIQUE,
     category_id TEXT,
     announcements_id TEXT,
     doubts_id TEXT,
     submissions_id TEXT,
     teacher_id TEXT,
     status TEXT NOT NULL DEFAULT 'open',
     created_at INTEGER NOT NULL,
     closed_at INTEGER
   );
   CREATE TABLE enrollments (
     group_id INTEGER NOT NULL,
     user_id TEXT NOT NULL,
     source TEXT NOT NULL,
     enrolled_by TEXT,
     enrolled_at INTEGER NOT NULL,
     PRIMARY KEY (group_id, user_id)
   );
   CREATE TABLE enroll_codes (
     code TEXT PRIMARY KEY,
     group_id INTEGER NOT NULL,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     used_by TEXT,
     used_at INTEGER
   );
   CREATE TABLE doubts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     group_id INTEGER NOT NULL,
     user_id TEXT NOT NULL,
     title TEXT NOT NULL,
     attempt TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     message_id TEXT,
     thread_id TEXT,
     status TEXT NOT NULL DEFAULT 'open',
     helper_id TEXT,
     reminded INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     resolved_at INTEGER
   );
   CREATE TABLE help_points (
     user_id TEXT PRIMARY KEY,
     points INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE class_sessions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     group_id INTEGER NOT NULL,
     keyword TEXT NOT NULL,
     opened_by TEXT NOT NULL,
     opened_at INTEGER NOT NULL,
     closed_at INTEGER,
     recording TEXT,
     resources TEXT
   );
   CREATE TABLE attendance (
     session_id INTEGER NOT NULL,
     user_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (session_id, user_id)
   );
   CREATE TABLE exercises (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     group_id INTEGER NOT NULL,
     title TEXT NOT NULL,
     description TEXT,
     due_at INTEGER,
     is_final INTEGER NOT NULL DEFAULT 0,
     message_id TEXT,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE submissions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     exercise_id INTEGER NOT NULL,
     user_id TEXT NOT NULL,
     content TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     thread_id TEXT,
     feedback TEXT,
     reviewed_by TEXT,
     submitted_at INTEGER NOT NULL,
     reviewed_at INTEGER,
     UNIQUE (exercise_id, user_id)
   );
   CREATE TABLE certificates (
     code TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     group_id INTEGER NOT NULL,
     issued_by TEXT NOT NULL,
     issued_at INTEGER NOT NULL,
     UNIQUE (group_id, user_id)
   );
   CREATE TABLE member_interests (
     user_id TEXT PRIMARY KEY,
     interest TEXT NOT NULL,
     chosen_at INTEGER NOT NULL
   );
   CREATE TABLE workshops (
     event_id INTEGER PRIMARY KEY,
     course TEXT NOT NULL,
     followup_sent INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE class_dm_state (
     reminder_id INTEGER PRIMARY KEY,
     dm60_sent INTEGER,
     dm10_sent INTEGER
   );`,
]);

registerConfig({
  channels: { novedades: { key: 'channel_news', label: 'Canal de novedades (TikTok)' } },
  roles: {
    graduado: { key: 'role_graduate', label: 'Rol de graduado' },
    pagos: { key: 'role_billing', label: 'Rol que atiende pagos y reembolsos' },
  },
  texts: { patrocinador: { key: 'sponsor_text', label: 'Texto del patrocinador (/hosting)' } },
});

Object.assign(registry.defaults, {
  reminder_title: '📚 Nuestros cursos',
  reminder_text: '¿Sabías que tenemos cursos? Entra en nuestra web y échales un vistazo.',
  sponsor_text: 'Innovate Academy está patrocinada por **SolarCloud**: hosting para tus proyectos.',
  sponsor_url: 'https://solarcloud.lat/',
});

registry.allowedDomains.push('innovateacademy.site');
registry.managedRoles.push(['role_graduate', 'rol de graduado']);
registry.verifiedPrompts.push(() => ({ content: 'Si quieres, cuéntanos qué te gustaría aprender:', components: [interestMenu()] }));
registry.privacyLines.push(
  (db, userId) => `**Matrículas en grupos:** ${db.prepare('SELECT COUNT(*) AS total FROM enrollments WHERE user_id = ?').get(userId).total}`,
);

registry.statsFields.push(
  (db, since) => {
    const total = (sql) => db.prepare(sql).get(since).total;
    const signups = total(
      'SELECT COUNT(*) AS total FROM event_signups s JOIN workshops w ON w.event_id = s.event_id JOIN events e ON e.id = s.event_id WHERE e.cancelled = 0 AND e.starts_at >= ?',
    );
    const enrollments = total('SELECT COUNT(*) AS total FROM enrollments WHERE enrolled_at >= ?');
    const redeemed = total("SELECT COUNT(*) AS total FROM enrollments WHERE source = 'code' AND enrolled_at >= ?");
    return { name: 'Embudo', value: `Inscritos a talleres: ${signups}\nMatrículas: ${enrollments} (${redeemed} con código)`, inline: true };
  },
  (db, since) => {
    const count = db.prepare('SELECT COUNT(*) AS total FROM member_interests WHERE interest = ? AND chosen_at >= ?');
    return { name: 'Intereses elegidos', value: INTERESTS.map(({ id, emoji, label }) => `${emoji} ${label}: ${count.get(id, since).total}`).join('\n') };
  },
);

registry.workloadSources.push(
  {
    key: 'reviews',
    label: 'entregas corregidas',
    sql: 'SELECT reviewed_by AS user_id, COUNT(*) AS total FROM submissions WHERE reviewed_at >= ? AND reviewed_by IS NOT NULL GROUP BY reviewed_by',
    params: (since) => [since],
  },
  {
    key: 'doubts',
    label: 'dudas resueltas',
    sql: 'SELECT helper_id AS user_id, COUNT(*) AS total FROM doubts WHERE resolved_at >= ? AND helper_id IS NOT NULL GROUP BY helper_id',
    params: (since) => [since],
  },
);

registerTicketKind('curso', {
  button: 'Duda de un curso',
  style: ButtonStyle.Primary,
  help: '🎓 **Duda de un curso:** contenidos, horarios, cómo inscribirte.',
  prefix: 'curso',
  roles: ['role_staff'],
  staff: true,
  transcript: true,
  modalTitle: 'Duda sobre un curso',
  labels: ['¿Sobre qué curso?', '¿Qué quieres saber?', 'Algo más que debamos saber'],
  heading: (ticket) => `🎓 Curso #${ticket.id}: ${ticket.title}`,
  author: 'Enviada por',
  steps: 'Más información',
  color: 0x5865f2,
});
// Pagos y reembolsos: solo los ve el equipo de pagos (o los supervisores) y no dejan transcripción.
const billing = { style: ButtonStyle.Primary, roles: ['role_billing', 'role_supervisor'] };
registerTicketKind('pago', {
  ...billing,
  button: 'Problema con un pago',
  help: '💳 **Problema con un pago:** solo lo ve el equipo de pagos. Nunca envíes datos de tarjeta.',
  prefix: 'pago',
  modalTitle: 'Problema con un pago',
  labels: ['Curso o pack', '¿Qué ha pasado con el pago?', 'Fecha y forma de pago (sin datos de tarjeta)'],
  heading: (ticket) => `💳 Pago #${ticket.id}: ${ticket.title}`,
  author: 'Enviado por',
  steps: 'Fecha y forma de pago',
  color: 0x57f287,
});
registerTicketKind('reembolso', {
  ...billing,
  button: 'Reembolso',
  help: '↩️ **Reembolso:** solicitudes de reembolso o cancelación.',
  prefix: 'reembolso',
  modalTitle: 'Reembolso o cancelación',
  labels: ['Curso o pack', 'Motivo de la solicitud', 'Fecha de compra'],
  heading: (ticket) => `↩️ Reembolso #${ticket.id}: ${ticket.title}`,
  author: 'Solicitado por',
  steps: 'Fecha de compra',
  color: 0xfee75c,
});

export default {
  id: 'academy',
  modules: [enrollment, doubts, attendance, coursework, radar, graduation, onboarding, catalog, workshops, classDms],
};
