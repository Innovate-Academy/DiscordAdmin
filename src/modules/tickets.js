import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { withDuty } from '../duty.js';
import { buildTranscript } from '../lib/transcript.js';
import { registerTicketKind, registry } from '../registry.js';
import { sendModLog } from '../sanctions.js';
import { UserError, eph, fetchChannel, isAdmin, isStaff, requireAdmin } from '../util.js';

const HOUR = 3_600_000;
const DELETE_DELAY_MS = 5000;
const REMIND_AFTER_MS = 12 * HOUR;
const ESCALATE_AFTER_MS = 20 * HOUR;
const BUTTONS_PER_ROW = 5;
const MEMBER_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
];

// Tipos de ticket del núcleo; las extensiones añaden más con registerTicketKind.
// - `roles`: claves de configuración de los roles que lo atienden; se usa el primero configurado.
// - `staff`: lo atiende además cualquier miembro del staff.
// - `transcript`: al cerrar deja transcripción en el canal de logs, que ve todo el staff.
// - `confidential`: fuera de su canal nunca se muestra su título.
// - `labels`: las tres preguntas del formulario (máximo 45 caracteres cada una).
registerTicketKind('bug', {
  button: 'Reportar bug',
  style: ButtonStyle.Danger,
  help: '🐛 **Reportar bug:** algo no funciona.',
  prefix: 'bug',
  roles: ['role_staff'],
  staff: true,
  transcript: true,
  modalTitle: 'Reportar un bug',
  labels: ['Título', '¿Qué ha pasado?', 'Pasos para reproducirlo'],
  heading: (ticket) => `🐛 Bug #${ticket.id}: ${ticket.title}`,
  author: 'Reportado por',
  steps: 'Pasos para reproducirlo',
  color: 0xed4245,
});
registerTicketKind('soporte', {
  button: 'Pedir ayuda',
  style: ButtonStyle.Primary,
  help: '💬 **Pedir ayuda:** cualquier duda o problema con el servidor.',
  prefix: 'ayuda',
  roles: ['role_staff'],
  staff: true,
  transcript: true,
  modalTitle: 'Pedir ayuda',
  labels: ['Asunto', '¿En qué podemos ayudarte?', 'Algo más que debamos saber'],
  heading: (ticket) => `💬 Consulta #${ticket.id}: ${ticket.title}`,
  author: 'Enviada por',
  steps: 'Más información',
  color: 0x5865f2,
});
registerTicketKind('report', {
  button: 'Reportar a un usuario',
  style: ButtonStyle.Secondary,
  help: '🚩 **Reportar a un usuario:** confidencial; solo lo ven los supervisores.',
  prefix: 'reporte',
  roles: ['role_supervisor'],
  confidential: true,
  modalTitle: 'Reportar a un usuario',
  labels: ['¿A quién quieres reportar?', '¿Qué ha pasado?', 'Pruebas (enlaces a mensajes, capturas...)'],
  heading: (ticket) => `🚩 Reporte #${ticket.id} sobre ${ticket.title}`,
  author: 'Enviado por',
  steps: 'Pruebas',
  color: 0xe67e22,
});

const kinds = registry.ticketKinds;
// Los paneles antiguos y los tipos que ya no existen se tratan como bugs.
const kindOf = (value) => (kinds.has(value) ? value : 'bug');
const kindDef = (ticket) => kinds.get(kindOf(ticket.kind));
// Nombre del ticket que se puede mostrar fuera de su canal: el de un reporte no dice sobre quién es.
const publicName = (ticket) => (kindDef(ticket).confidential ? `Reporte confidencial #${ticket.id}` : kindDef(ticket).heading(ticket));

const command = new SlashCommandBuilder()
  .setName('tickets')
  .setDescription('Tickets de soporte')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) => sub.setName('panel').setDescription('Publica en este canal los botones para abrir un ticket'));

const getTicket = (db, id) => db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);

// Rol que atiende un tipo de ticket: el primero configurado que siga existiendo, o null.
function handlerRole(settings, guild, kind) {
  for (const key of kinds.get(kind).roles) {
    const roleId = settings.get(key);
    if (roleId && (!guild || guild.roles.cache.has(roleId))) return roleId;
  }
  return null;
}

function canHandle(interaction, settings, ticket) {
  const kind = kindDef(ticket);
  if (isAdmin(interaction) || (kind.staff && isStaff(interaction, settings))) return true;
  return kind.roles.some((key) => settings.get(key) && interaction.member.roles.cache.has(settings.get(key)));
}

function reportModal(kind) {
  const { modalTitle, labels } = kinds.get(kind);
  const input = (id, label, style, required, max) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max),
    );
  return new ModalBuilder()
    .setCustomId(`tickets:submit:${kind}`)
    .setTitle(modalTitle)
    .addComponents(
      input('titulo', labels[0], TextInputStyle.Short, true, 80),
      input('descripcion', labels[1], TextInputStyle.Paragraph, true, 1000),
      input('pasos', labels[2], TextInputStyle.Paragraph, false, 1000),
    );
}

function ticketMessage(ticket) {
  const kind = kindDef(ticket);
  const embed = new EmbedBuilder()
    .setColor(kind.color)
    .setTitle(kind.heading(ticket))
    .setDescription(ticket.description)
    .addFields({ name: kind.author, value: `<@${ticket.user_id}>`, inline: true });
  if (ticket.steps) embed.addFields({ name: kind.steps, value: ticket.steps });
  if (ticket.claimed_by) embed.addFields({ name: 'Lo lleva', value: `<@${ticket.claimed_by}>`, inline: true });
  const claim = new ButtonBuilder()
    .setCustomId(`tickets:claim:${ticket.id}`)
    .setLabel('Reclamar')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(Boolean(ticket.claimed_by));
  const close = new ButtonBuilder().setCustomId(`tickets:close:${ticket.id}`).setLabel('Cerrar').setStyle(ButtonStyle.Danger);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(claim, close)] };
}

async function onCommand(interaction) {
  requireAdmin(interaction);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('¿Necesitas ayuda?')
    .setDescription(`Elige el motivo y se abrirá un canal privado contigo.\n\n${[...kinds.values()].map((kind) => kind.help).join('\n')}`);
  const buttons = [...kinds].map(([id, { button, style }]) => new ButtonBuilder().setCustomId(`tickets:open:${id}`).setLabel(button).setStyle(style));
  const rows = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + BUTTONS_PER_ROW)));
  await interaction.channel.send({ embeds: [embed], components: rows });
  return interaction.reply(eph('Panel publicado.'));
}

async function open(interaction, ctx, kind) {
  const { db, client } = ctx;
  const existing = db.prepare("SELECT * FROM tickets WHERE user_id = ? AND kind = ? AND status = 'open'").get(interaction.user.id, kind);
  if (existing) {
    if (await fetchChannel(client, existing.channel_id)) {
      throw new UserError(`Ya tienes un ticket abierto: <#${existing.channel_id}>. Ciérralo antes de abrir otro.`);
    }
    // El canal se borró a mano: se da el ticket por cerrado.
    db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ?").run(Date.now(), existing.id);
  }
  return interaction.showModal(reportModal(kind));
}

async function submit(interaction, ctx, kind) {
  const { db, settings, client } = ctx;
  const category = await fetchChannel(client, settings.get('category_tickets'));
  if (category?.type !== ChannelType.GuildCategory) {
    throw new UserError('Los tickets aún no están configurados. Avisa a un administrador (`/config canal` > Categoría de tickets).');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { lastInsertRowid } = db
    .prepare('INSERT INTO tickets (user_id, kind, title, description, steps, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      interaction.user.id,
      kind,
      interaction.fields.getTextInputValue('titulo'),
      interaction.fields.getTextInputValue('descripcion'),
      interaction.fields.getTextInputValue('pasos') || null,
      Date.now(),
    );
  const ticket = getTicket(db, Number(lastInsertRowid));
  // Si ninguno de los roles configurados existe, el ticket lo verán solo los administradores.
  const roleId = handlerRole(settings, interaction.guild, kind);

  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name: `${kinds.get(kind).prefix}-${ticket.id}`,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: publicName(ticket),
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: MEMBER_PERMISSIONS },
        { id: client.user.id, allow: [...MEMBER_PERMISSIONS, PermissionFlagsBits.ManageChannels] },
        ...(roleId ? [{ id: roleId, allow: MEMBER_PERMISSIONS }] : []),
      ],
    });
  } catch (err) {
    db.prepare('DELETE FROM tickets WHERE id = ?').run(ticket.id);
    console.error('[tickets] No se pudo crear el canal:', err.message);
    throw new UserError('No he podido crear el canal del ticket. Al bot le falta el permiso "Gestionar canales".');
  }

  db.prepare('UPDATE tickets SET channel_id = ? WHERE id = ?').run(channel.id, ticket.id);
  try {
    await channel.send({
      content: `${interaction.user}${roleId ? ` <@&${roleId}>` : ''}`,
      allowedMentions: { users: [interaction.user.id], roles: roleId ? [roleId] : [] },
      ...ticketMessage(ticket),
    });
  } catch (err) {
    // Sin el mensaje con el botón "Cerrar" el ticket quedaría atascado: se deshace.
    db.prepare('DELETE FROM tickets WHERE id = ?').run(ticket.id);
    await channel.delete().catch(() => {});
    console.error('[tickets] No se pudo escribir en el canal del ticket:', err.message);
    throw new UserError('No he podido abrir el ticket. Avisa a un administrador.');
  }
  await interaction.editReply(`Ticket creado: ${channel}`);
}

async function claim(interaction, ctx, id) {
  const ticket = getTicket(ctx.db, id);
  if (!ticket || ticket.status !== 'open') throw new UserError('Este ticket ya está cerrado.');
  if (!canHandle(interaction, ctx.settings, ticket)) throw new UserError('No tienes permiso para atender este ticket.');
  if (ticket.claimed_by) throw new UserError(`Este ticket ya lo lleva <@${ticket.claimed_by}>.`);
  ctx.db
    .prepare('UPDATE tickets SET claimed_by = ?, first_response_at = COALESCE(first_response_at, ?) WHERE id = ?')
    .run(interaction.user.id, Date.now(), id);
  await interaction.update(ticketMessage({ ...ticket, claimed_by: interaction.user.id }));
  await interaction.followUp({ content: `${interaction.user} se encarga de este ticket.`, allowedMentions: { parse: [] } });
}

async function close(interaction, ctx, id) {
  const { db, client, settings } = ctx;
  const ticket = getTicket(db, id);
  if (!ticket) throw new UserError('Este ticket ya no existe.');
  if (ticket.user_id !== interaction.user.id && !canHandle(interaction, settings, ticket)) {
    throw new UserError('Solo quien abrió el ticket o quien lo atiende puede cerrarlo.');
  }
  await interaction.reply('Ticket cerrado. El canal se borrará en unos segundos.');

  if (ticket.status === 'open') {
    db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?").run(Date.now(), interaction.user.id, id);
    const kind = kindDef(ticket);
    const logs = kind.transcript ? await fetchChannel(client, settings.get('channel_logs')) : null;
    if (logs?.isTextBased()) {
      const messages = db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at').all(ticket.channel_id);
      const file = new AttachmentBuilder(Buffer.from(buildTranscript(ticket, messages), 'utf8'), { name: `${kind.prefix}-${id}.txt` });
      await logs
        .send({ content: `${kind.heading(ticket)}, de <@${ticket.user_id}>, cerrado por ${interaction.user}.`, files: [file], allowedMentions: { parse: [] } })
        .catch((err) => console.error('[tickets] No se pudo enviar la transcripción:', err.message));
    }
  }
  setTimeout(() => interaction.channel?.delete().catch(() => {}), DELETE_DELAY_MS).unref();
}

async function onComponent(interaction, ctx, action, arg) {
  if (action === 'open') return open(interaction, ctx, kindOf(arg));
  if (action === 'submit') return submit(interaction, ctx, kindOf(arg));
  if (action === 'claim') return claim(interaction, ctx, Number(arg));
  if (action === 'close') return close(interaction, ctx, Number(arg));
}

// Plazo de respuesta: a las 12 h sin respuesta se avisa en el ticket; a las 20 h se escala al canal de moderación.
async function tick(ctx, now) {
  const { db, client, settings } = ctx;
  const waiting = db.prepare("SELECT * FROM tickets WHERE status = 'open' AND first_response_at IS NULL AND channel_id IS NOT NULL").all();
  for (const ticket of waiting) {
    // Cuenta como respuesta el primer mensaje de alguien que no sea quien abrió el ticket ni el bot.
    const { at } = db
      .prepare('SELECT MIN(created_at) AS at FROM messages WHERE channel_id = ? AND author_id NOT IN (?, ?)')
      .get(ticket.channel_id, ticket.user_id, client.user.id);
    if (at) {
      db.prepare('UPDATE tickets SET first_response_at = ? WHERE id = ?').run(at, ticket.id);
      continue;
    }

    const age = now - ticket.created_at;
    if (age >= ESCALATE_AFTER_MS && ticket.sla_stage < 2) {
      db.prepare('UPDATE tickets SET sla_stage = 2 WHERE id = ?').run(ticket.id);
      const supervisor = settings.get('role_supervisor');
      await sendModLog(
        ctx,
        {
          content: `${supervisor ? `<@&${supervisor}> ` : ''}🚨 **${publicName(ticket)}** (<#${ticket.channel_id}>) lleva 20 horas sin respuesta.`,
          allowedMentions: { roles: supervisor ? [supervisor] : [] },
        },
        { notifyDuty: true },
      );
    } else if (age >= REMIND_AFTER_MS && ticket.sla_stage < 1) {
      db.prepare('UPDATE tickets SET sla_stage = 1 WHERE id = ?').run(ticket.id);
      const roleId = handlerRole(settings, null, kindOf(ticket.kind));
      const channel = await fetchChannel(client, ticket.channel_id);
      const reminder = { content: `${roleId ? `<@&${roleId}> ` : ''}⏰ este ticket lleva 12 horas sin respuesta.`, allowedMentions: { roles: roleId ? [roleId] : [] } };
      await channel?.send(withDuty(ctx, reminder, now)).catch((err) => console.error(`[tickets] No se pudo avisar del ticket #${ticket.id}:`, err.message));
    }
  }
}

export default { id: 'tickets', name: 'Tickets de soporte', commands: [command], onCommand, onComponent, tick };
