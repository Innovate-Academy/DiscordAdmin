// Progreso de un alumno en un grupo: ejercicios con su estado y asistencia a las clases cerradas
// desde que se matriculó.
export function progressOf(db, groupId, userId) {
  const enrolledAt = db.prepare('SELECT enrolled_at FROM enrollments WHERE group_id = ? AND user_id = ?').get(groupId, userId)?.enrolled_at ?? 0;
  const exercises = db
    .prepare(
      `SELECT x.id, x.title, x.is_final, x.due_at, s.status
       FROM exercises x LEFT JOIN submissions s ON s.exercise_id = x.id AND s.user_id = ?
       WHERE x.group_id = ? ORDER BY x.id`,
    )
    .all(userId, groupId);
  const sessions = db
    .prepare('SELECT id FROM class_sessions WHERE group_id = ? AND closed_at IS NOT NULL AND opened_at >= ? ORDER BY id')
    .all(groupId, enrolledAt)
    .map((row) => row.id);
  const attended = new Set(
    db
      .prepare('SELECT a.session_id FROM attendance a JOIN class_sessions s ON s.id = a.session_id WHERE s.group_id = ? AND a.user_id = ?')
      .all(groupId, userId)
      .map((row) => row.session_id),
  );
  return { exercises, sessions, attended: sessions.filter((id) => attended.has(id)) };
}

// Motivos por los que un alumno puede estar a punto de abandonar. Lista vacía = sin señales.
export function riskReasons(progress, now) {
  const reasons = [];
  const lastTwo = progress.sessions.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((id) => !progress.attended.includes(id))) reasons.push('faltó a las 2 últimas clases');
  const overdue = progress.exercises.filter((exercise) => exercise.due_at && exercise.due_at < now && !exercise.status).length;
  if (overdue >= 2) reasons.push(`${overdue} ejercicios vencidos sin entregar`);
  return reasons;
}
