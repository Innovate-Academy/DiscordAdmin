import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { discordTime, parseDateTime } from '../lib/dates.js';
import { UserError, eph, fetchChannel, isStaff, requireChannel, requireStaff } from '../util.js';

const command = new SlashCommandBuilder()
  .setName('tarea')
  .setDescription('Tareas del staff')
  .addSubcommand((sub) =>
    sub
      .setName('crear')
      .setDescription('Crea una tarea y la asigna a un rol o a una persona')
      .addStringOption((opt) => opt.setName('titulo').setDescription('Qué hay que hacer').setRequired(true).setMaxLength(200))
      .addStringOption((opt) => opt.setName('descripcion').setDescription('Detalles').setMaxLength(1000))
      .addRoleOption((opt) => opt.setName('rol').setDescription('Rol responsable'))
      .addUserOption((opt) => opt.setName('persona').setDescription('Persona responsable'))
      .addStringOption((opt) => opt.setName('fecha_limite').setDescription('DD/MM/AAAA HH:MM')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('lista')
      .setDescription('Lista de tareas')
      .addStringOption((opt) =>
        opt.setName('estado').setDescription('Por defecto, pendientes').addChoices({ name: 'Pendientes', value: 'pending' }, { name: 'Hechas', value: 'done' }),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('hecha')
      .setDescription('Marca una tarea como hecha')
      .addIntegerOption((opt) => opt.setName('id').setDescription('Número de la tarea').setRequired(true).setMinValue(1)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('borrar')
      .setDescription('Borra una tarea')
      .addIntegerOption((opt) => opt.setName('id').setDescription('Número de la tarea').setRequired(true).setMinValue(1)),
  );

const getTask = (db, id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

function assignee(task) {
  return [task.role_id && `<@&${task.role_id}>`, task.user_id && `<@${task.user_id}>`].filter(Boolean).join(' ');
}

const assigneeMentions = (task) => ({
  roles: task.role_id ? [task.role_id] : [],
  users: task.user_id ? [task.user_id] : [],
});

function taskMessage(task) {
  const done = task.status === 'done';
  const embed = new EmbedBuilder()
    .setColor(done ? 0x57f287 : 0xfee75c)
    .setTitle(`${done ? '✅' : '📝'} Tarea #${task.id}: ${task.title}`)
    .addFields(
      { name: 'Asignada a', value: assignee(task), inline: true },
      { name: 'Fecha límite', value: task.due_at ? discordTime(task.due_at, 'f') : 'Sin fecha', inline: true },
      { name: 'Estado', value: done ? 'Hecha' : 'Pendiente', inline: true },
    );
  if (task.description) embed.setDescription(task.description);
  const button = new ButtonBuilder().setCustomId(`tasks:done:${task.id}`).setLabel('Marcar como hecha').setStyle(ButtonStyle.Success);
  return { embeds: [embed], components: done ? [] : [new ActionRowBuilder().addComponents(button)] };
}

function markDone(db, id) {
  const task = getTask(db, id);
  if (!task) throw new UserError('No existe ninguna tarea con ese número.');
  if (task.status === 'done') throw new UserError('Esa tarea ya estaba hecha.');
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
  return { ...task, status: 'done' };
}

async function fetchTaskMessage(client, task) {
  const channel = await fetchChannel(client, task.channel_id);
  return task.message_id ? channel?.messages.fetch(task.message_id).catch(() => null) : null;
}

async function onCommand(interaction, ctx) {
  const { db, settings, client } = ctx;
  const options = interaction.options;
  requireStaff(interaction, settings);

  switch (options.getSubcommand()) {
    case 'crear': {
      const role = options.getRole('rol');
      const user = options.getUser('persona');
      if (!role && !user) throw new UserError('Indica un rol o una persona responsable.');
      const dueText = options.getString('fecha_limite');
      const dueAt = dueText ? parseDateTime(dueText, settings.get('timezone')) : null;
      if (dueText && !dueAt) throw new UserError('Fecha no válida. Usa el formato `DD/MM/AAAA HH:MM`, por ejemplo `25/10/2026 18:30`.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channel = await requireChannel(ctx, 'channel_tasks', 'el canal de tareas');

      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO tasks (title, description, role_id, user_id, due_at, created_by, created_at, channel_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(options.getString('titulo', true), options.getString('descripcion'), role?.id ?? null, user?.id ?? null, dueAt, interaction.user.id, Date.now(), channel.id);
      const task = getTask(db, Number(lastInsertRowid));
      try {
        const message = await channel.send({ content: assignee(task), allowedMentions: assigneeMentions(task), ...taskMessage(task) });
        db.prepare('UPDATE tasks SET message_id = ? WHERE id = ?').run(message.id, task.id);
      } catch {
        db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
        throw new UserError(`No puedo escribir en ${channel}. Revisa los permisos del bot en ese canal.`);
      }
      return interaction.editReply(`Tarea #${task.id} creada en ${channel}.`);
    }
    case 'lista': {
      const status = options.getString('estado') ?? 'pending';
      const rows = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY due_at IS NULL, due_at, id LIMIT 25').all(status);
      if (!rows.length) return interaction.reply(eph(status === 'pending' ? 'No hay tareas pendientes.' : 'No hay tareas hechas.'));
      const lines = rows.map((t) => `**#${t.id} · ${t.title}** — ${assignee(t)}${t.due_at ? ` · límite ${discordTime(t.due_at, 'f')}` : ''}`);
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(status === 'pending' ? '📝 Tareas pendientes' : '✅ Tareas hechas')
        .setDescription(lines.join('\n'));
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    case 'hecha': {
      const task = markDone(db, options.getInteger('id', true));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const message = await fetchTaskMessage(client, task);
      await message?.edit(taskMessage(task)).catch(() => {});
      return interaction.editReply(`Tarea #${task.id} marcada como hecha.`);
    }
    case 'borrar': {
      const task = getTask(db, options.getInteger('id', true));
      if (!task) throw new UserError('No existe ninguna tarea con ese número.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
      const message = await fetchTaskMessage(client, task);
      await message?.delete().catch(() => {});
      return interaction.editReply(`Tarea #${task.id} borrada.`);
    }
  }
}

async function onComponent(interaction, ctx, action, arg) {
  if (action !== 'done') return;
  const task = getTask(ctx.db, Number(arg));
  if (!task) throw new UserError('Esta tarea ya no existe.');
  const assigned = task.user_id === interaction.user.id || (task.role_id && interaction.member.roles.cache.has(task.role_id));
  if (!assigned && !isStaff(interaction, ctx.settings)) throw new UserError('Solo el staff o la persona asignada puede cerrar esta tarea.');
  await interaction.update(taskMessage(markDone(ctx.db, task.id)));
}

async function tick(ctx, now) {
  const { db, client } = ctx;
  const overdue = db.prepare("SELECT * FROM tasks WHERE status = 'pending' AND overdue_notified = 0 AND due_at IS NOT NULL AND due_at <= ?").all(now);
  for (const task of overdue) {
    db.prepare('UPDATE tasks SET overdue_notified = 1 WHERE id = ?').run(task.id);
    const channel = await fetchChannel(client, task.channel_id);
    if (!channel?.isTextBased()) continue;
    await channel
      .send({
        content: `⏰ ${assignee(task)} la tarea **#${task.id} · ${task.title}** ha vencido.`,
        allowedMentions: assigneeMentions(task),
      })
      .catch((err) => console.error(`[tareas] No se pudo avisar de la tarea #${task.id}:`, err.message));
  }
}

export default { id: 'tasks', name: 'Tareas del staff', commands: [command], onCommand, onComponent, tick };
