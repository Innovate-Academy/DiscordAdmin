import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { discordTime, formatDuration, parseDuration } from '../lib/dates.js';
import { SANCTION_LABELS, countWarnings, getHistory, recordSanction } from '../sanctions.js';
import { UserError, memberIsStaff, requireStaff } from '../util.js';

const DAY = 86_400_000;
const WARN_WINDOW_MS = 30 * DAY;
const WARN_LIMIT = 3;
const AUTO_TIMEOUT_MS = DAY;
// Límite de Discord para un aislamiento.
const MAX_TIMEOUT_MS = 28 * DAY;

const userOption = (opt) => opt.setName('usuario').setDescription('Miembro').setRequired(true);
const reasonOption = (opt) => opt.setName('motivo').setDescription('Motivo (se le envía por privado)').setRequired(true).setMaxLength(500);

const commands = [
  new SlashCommandBuilder().setName('advertir').setDescription('Advierte a un miembro; 3 en 30 días lo silencian 24 h (staff)').addUserOption(userOption).addStringOption(reasonOption),
  new SlashCommandBuilder()
    .setName('silenciar')
    .setDescription('Silencia temporalmente a un miembro (staff)')
    .addUserOption(userOption)
    .addStringOption((opt) => opt.setName('duracion').setDescription('Por ejemplo 10m, 2h o 1d (máximo 28d)').setRequired(true))
    .addStringOption(reasonOption),
  new SlashCommandBuilder().setName('desilenciar').setDescription('Retira el silencio a un miembro (staff)').addUserOption(userOption),
  new SlashCommandBuilder().setName('expulsar').setDescription('Expulsa a un miembro; puede volver a entrar (staff)').addUserOption(userOption).addStringOption(reasonOption),
  new SlashCommandBuilder()
    .setName('banear')
    .setDescription('Banea a alguien del servidor (staff)')
    .addUserOption(userOption)
    .addStringOption(reasonOption)
    .addIntegerOption((opt) => opt.setName('borrar_dias').setDescription('Borrar sus mensajes de los últimos días (0 a 7)').setMinValue(0).setMaxValue(7)),
  new SlashCommandBuilder().setName('historial').setDescription('Sanciones de un miembro (staff)').addUserOption(userOption),
];

function assertSanctionable(interaction, member, ctx) {
  if (member.id === interaction.user.id) throw new UserError('No puedes sancionarte a ti mismo.');
  if (member.id === ctx.client.user.id) throw new UserError('No puedo sancionarme a mí mismo.');
  if (memberIsStaff(member, ctx.settings)) throw new UserError('No se puede sancionar a un miembro del staff.');
}

function targetMember(interaction, ctx) {
  const member = interaction.options.getMember('usuario');
  if (!member) throw new UserError('Esa persona ya no está en el servidor.');
  assertSanctionable(interaction, member, ctx);
  return member;
}

// El aviso por privado puede fallar si la persona tiene los mensajes cerrados; no es un error.
const notify = (user, text) => user.send(text).catch(() => {});

async function warn(interaction, ctx) {
  const member = targetMember(interaction, ctx);
  const reason = interaction.options.getString('motivo', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await recordSanction(ctx, { type: 'warn', userId: member.id, moderatorId: interaction.user.id, reason });
  await notify(member.user, `Has recibido una advertencia en **${interaction.guild.name}**.\nMotivo: ${reason}`);

  const warnings = countWarnings(ctx.db, member.id, Date.now() - WARN_WINDOW_MS);
  let extra = '';
  if (warnings >= WARN_LIMIT && member.moderatable) {
    const autoReason = `${warnings} advertencias en 30 días`;
    await member.timeout(AUTO_TIMEOUT_MS, autoReason);
    await recordSanction(ctx, { type: 'timeout', userId: member.id, moderatorId: ctx.client.user.id, reason: autoReason, durationMs: AUTO_TIMEOUT_MS });
    extra = ' Al acumular 3, queda silenciado 24 horas.';
  }
  await interaction.editReply(`Advertencia registrada para ${member} (${warnings} en los últimos 30 días).${extra}`);
}

async function timeout(interaction, ctx) {
  const member = targetMember(interaction, ctx);
  const reason = interaction.options.getString('motivo', true);
  const durationMs = parseDuration(interaction.options.getString('duracion', true));
  if (!durationMs) throw new UserError('Duración no válida. Ejemplos: `10m`, `2h`, `1d`.');
  if (durationMs > MAX_TIMEOUT_MS) throw new UserError('Discord no permite silenciar más de 28 días.');
  if (!member.moderatable) throw new UserError('No puedo silenciar a esa persona: su rol está por encima del mío.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await member.timeout(durationMs, reason);
  await recordSanction(ctx, { type: 'timeout', userId: member.id, moderatorId: interaction.user.id, reason, durationMs });
  await notify(member.user, `Has sido silenciado ${formatDuration(durationMs)} en **${interaction.guild.name}**.\nMotivo: ${reason}`);
  await interaction.editReply(`${member} queda silenciado ${formatDuration(durationMs)}.`);
}

async function untimeout(interaction, ctx) {
  const member = targetMember(interaction, ctx);
  if (!member.moderatable) throw new UserError('No puedo modificar a esa persona: su rol está por encima del mío.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await member.timeout(null);
  await recordSanction(ctx, { type: 'untimeout', userId: member.id, moderatorId: interaction.user.id, reason: 'Retirado por el staff' });
  await interaction.editReply(`${member} ya puede escribir.`);
}

async function kick(interaction, ctx) {
  const member = targetMember(interaction, ctx);
  const reason = interaction.options.getString('motivo', true);
  if (!member.kickable) throw new UserError('No puedo expulsar a esa persona: su rol está por encima del mío.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // El aviso va antes: una vez fuera del servidor ya no se le puede escribir.
  await notify(member.user, `Has sido expulsado de **${interaction.guild.name}**.\nMotivo: ${reason}`);
  await member.kick(reason);
  await recordSanction(ctx, { type: 'kick', userId: member.id, moderatorId: interaction.user.id, reason });
  await interaction.editReply(`${member} ha sido expulsado.`);
}

async function ban(interaction, ctx) {
  const user = interaction.options.getUser('usuario', true);
  const member = interaction.options.getMember('usuario');
  const reason = interaction.options.getString('motivo', true);
  // Se puede banear a alguien que ya salió del servidor; entonces solo hay usuario, no miembro.
  assertSanctionable(interaction, member ?? user, ctx);
  if (member && !member.bannable) throw new UserError('No puedo banear a esa persona: su rol está por encima del mío.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await notify(user, `Has sido baneado de **${interaction.guild.name}**.\nMotivo: ${reason}`);
  await interaction.guild.members.ban(user.id, { reason, deleteMessageSeconds: (interaction.options.getInteger('borrar_dias') ?? 0) * 86_400 });
  await recordSanction(ctx, { type: 'ban', userId: user.id, moderatorId: interaction.user.id, reason });
  await interaction.editReply(`<@${user.id}> ha sido baneado.`);
}

async function history(interaction, ctx) {
  const user = interaction.options.getUser('usuario', true);
  const rows = getHistory(ctx.db, user.id);
  const lines = rows.map((row) => {
    const duration = row.duration_ms ? ` (${formatDuration(row.duration_ms)})` : '';
    return `${discordTime(row.created_at, 'd')} **${SANCTION_LABELS[row.type]}**${duration} por <@${row.moderator_id}>: ${row.reason}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Historial de sanciones')
    .setDescription(`<@${user.id}>\n\n${lines.join('\n') || 'Sin sanciones.'}`.slice(0, 4000));
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

const handlers = { advertir: warn, silenciar: timeout, desilenciar: untimeout, expulsar: kick, banear: ban, historial: history };

async function onCommand(interaction, ctx) {
  requireStaff(interaction, ctx.settings);
  return handlers[interaction.commandName](interaction, ctx);
}

export default { id: 'moderation', name: 'Sanciones', commands, onCommand };
