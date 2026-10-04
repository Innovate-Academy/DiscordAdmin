import { MessageFlags, PermissionFlagsBits } from 'discord.js';

// Error cuyo mensaje se muestra tal cual a quien usó el comando.
export class UserError extends Error {}

// Destino extra para los errores inesperados (el canal de logs); lo fija index.js al arrancar.
let errorSink = null;
export function setErrorSink(sink) {
  errorSink = sink;
}

export function reportError(label, err) {
  console.error(`[${label}]`, err);
  errorSink?.(label, err);
}

// Envuelve un listener para que un fallo se registre sin tumbar el bot.
export function safe(label, fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      reportError(label, err);
    }
  };
}

export const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });

export function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

export function isStaff(interaction, settings) {
  if (isAdmin(interaction)) return true;
  const staffRole = settings.get('role_staff');
  return Boolean(staffRole && interaction.member?.roles?.cache?.has(staffRole));
}

// Igual que isStaff, pero para un miembro cualquiera (o un usuario que ya no está en el servidor).
export function memberIsStaff(member, settings) {
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  const staffRole = settings.get('role_staff');
  return Boolean(staffRole && member.roles?.cache?.has(staffRole));
}

export function requireStaff(interaction, settings) {
  if (!isStaff(interaction, settings)) throw new UserError('Solo el staff puede hacer esto.');
}

export function requireAdmin(interaction) {
  if (!isAdmin(interaction)) throw new UserError('Solo los administradores pueden hacer esto.');
}

export async function fetchChannel(client, id) {
  if (!id) return null;
  return client.channels.fetch(id).catch(() => null);
}

export async function requireChannel(ctx, key, label) {
  const channel = await fetchChannel(ctx.client, ctx.settings.get(key));
  if (!channel) {
    throw new UserError(`Falta configurar ${label}. Un administrador puede hacerlo con \`/config canal\`.`);
  }
  return channel;
}

// Mensaje de una persona (no bot, no sistema) en el servidor del bot.
export function isMemberMessage(message, ctx) {
  return message.guildId === ctx.guildId && !message.author?.bot && !message.system;
}
