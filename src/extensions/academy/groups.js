import { courseName } from './courses.js';
import { UserError, isStaff } from '../../util.js';

export const groupLabel = (group) => `${courseName(group.course)} · ${group.name}`;

export const getGroup = (db, id) => db.prepare('SELECT * FROM course_groups WHERE id = ?').get(id);

// Grupo al que pertenece un canal (o un hilo de ese canal), por su categoría.
export function groupOfChannel(db, channel) {
  const categoryId = channel?.isThread?.() ? channel.parent?.parentId : channel?.parentId;
  if (!categoryId) return null;
  return db.prepare('SELECT * FROM course_groups WHERE category_id = ?').get(categoryId) ?? null;
}

export const isEnrolled = (db, groupId, userId) =>
  Boolean(db.prepare('SELECT 1 FROM enrollments WHERE group_id = ? AND user_id = ?').get(groupId, userId));

export const canTeach = (interaction, settings, group) => isStaff(interaction, settings) || interaction.user.id === group.teacher_id;

// Grupo sobre el que actúa un profesor: el del canal donde escribe.
export function teacherGroup(interaction, ctx) {
  const group = groupOfChannel(ctx.db, interaction.channel);
  if (!group) throw new UserError('Usa este comando en un canal del grupo.');
  if (!canTeach(interaction, ctx.settings, group)) throw new UserError('Solo el profesor del grupo o el staff puede hacer esto.');
  return group;
}

// Grupo de un alumno: el del canal si está matriculado en él; si no, su único grupo abierto.
export function studentGroup(interaction, db) {
  const userId = interaction.user.id;
  const here = groupOfChannel(db, interaction.channel);
  if (here && isEnrolled(db, here.id, userId)) return here;
  const groups = db
    .prepare("SELECT g.* FROM course_groups g JOIN enrollments e ON e.group_id = g.id WHERE e.user_id = ? AND g.status = 'open'")
    .all(userId);
  if (!groups.length) throw new UserError('No estás matriculado en ningún grupo. Si ya compraste un curso, usa `/canjear` con tu código.');
  if (groups.length > 1) throw new UserError('Estás en varios grupos: usa este comando en un canal del grupo que corresponda.');
  return groups[0];
}

// A quién avisar de algo del grupo: su profesor o, si no tiene, el rol de staff.
export function teacherMention(group, settings) {
  if (group.teacher_id) return { text: `<@${group.teacher_id}>`, allowedMentions: { users: [group.teacher_id] } };
  const staffRole = settings.get('role_staff');
  return staffRole ? { text: `<@&${staffRole}>`, allowedMentions: { roles: [staffRole] } } : { text: '', allowedMentions: { parse: [] } };
}
