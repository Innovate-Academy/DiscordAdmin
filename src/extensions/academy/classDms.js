import { dmIfOptedIn } from '../../dm.js';
import { discordTime, weeklyDue } from '../../lib/dates.js';

// Recordatorio personal de clase: cuando un aviso semanal del núcleo (/aviso-semanal) menciona el rol
// de un grupo, sus alumnos con los avisos activados reciben un privado 1 hora y 10 minutos antes.
async function tick(ctx, now) {
  const { db, settings } = ctx;
  const timeZone = settings.get('timezone');
  const classes = db
    .prepare(
      `SELECT w.*, s.dm60_sent, s.dm10_sent FROM weekly_reminders w
       JOIN course_groups g ON g.role_id = w.role_id AND g.status = 'open'
       LEFT JOIN class_dm_state s ON s.reminder_id = w.id`,
    )
    .all();
  const saveState = db.prepare(
    `INSERT INTO class_dm_state (reminder_id, dm60_sent, dm10_sent) VALUES (?, ?, ?)
     ON CONFLICT(reminder_id) DO UPDATE SET dm60_sent = excluded.dm60_sent, dm10_sent = excluded.dm10_sent`,
  );

  for (const cls of classes) {
    const due10 = weeklyDue({ ...cls, lead_minutes: 10, last_sent: cls.dm10_sent }, now, timeZone);
    const due60 = weeklyDue({ ...cls, lead_minutes: 60, last_sent: cls.dm60_sent }, now, timeZone);
    const start = due10 ?? due60;
    if (!start) continue;
    // Si tocan los dos a la vez (el bot acaba de arrancar), se envía uno solo.
    saveState.run(cls.id, now, due10 ? now : cls.dm10_sent);

    const students = db
      .prepare(
        `SELECT e.user_id FROM enrollments e
         JOIN course_groups g ON g.id = e.group_id
         JOIN dm_optin o ON o.user_id = e.user_id
         WHERE g.role_id = ? AND g.status = 'open'`,
      )
      .all(cls.role_id);
    const text = `📚 **${cls.name}** empieza ${discordTime(start, 'R')}, a las ${discordTime(start, 't')} en tu hora.${cls.link ? `\nEnlace: ${cls.link}` : ''}`;
    for (const { user_id } of students) await dmIfOptedIn(ctx, user_id, text);
  }
}

export default { id: 'classDms', name: 'Recordatorio personal de clase', tick };
