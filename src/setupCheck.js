import { PermissionFlagsBits } from 'discord.js';
import { registry } from './registry.js';

// Permisos que el bot usa de verdad. Con esto no necesita ser Administrador.
export const REQUIRED_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, label: 'Ver canales' },
  { flag: PermissionFlagsBits.SendMessages, label: 'Enviar mensajes' },
  { flag: PermissionFlagsBits.EmbedLinks, label: 'Insertar enlaces' },
  { flag: PermissionFlagsBits.AttachFiles, label: 'Adjuntar archivos' },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: 'Leer el historial de mensajes' },
  { flag: PermissionFlagsBits.MentionEveryone, label: 'Mencionar todos los roles' },
  { flag: PermissionFlagsBits.CreateInstantInvite, label: 'Crear invitación' },
  { flag: PermissionFlagsBits.ManageMessages, label: 'Gestionar mensajes' },
  { flag: PermissionFlagsBits.ManageRoles, label: 'Gestionar roles' },
  { flag: PermissionFlagsBits.ManageChannels, label: 'Gestionar canales' },
  { flag: PermissionFlagsBits.ManageEvents, label: 'Gestionar eventos' },
  { flag: PermissionFlagsBits.CreatePublicThreads, label: 'Crear hilos públicos' },
  { flag: PermissionFlagsBits.CreatePrivateThreads, label: 'Crear hilos privados' },
  { flag: PermissionFlagsBits.SendMessagesInThreads, label: 'Enviar mensajes en hilos' },
  { flag: PermissionFlagsBits.ManageThreads, label: 'Gestionar hilos' },
  { flag: PermissionFlagsBits.ModerateMembers, label: 'Aislar temporalmente a miembros' },
  { flag: PermissionFlagsBits.KickMembers, label: 'Expulsar miembros' },
  { flag: PermissionFlagsBits.BanMembers, label: 'Banear miembros' },
];

// Lista, en lenguaje llano, lo que falta para que el bot funcione bien y con seguridad.
export function checkSetup(guild, ctx) {
  const { settings, db } = ctx;
  const problems = [];
  const me = guild.members.me;
  if (!me) return problems;

  if (me.permissions.has(PermissionFlagsBits.Administrator)) {
    problems.push('El bot tiene el permiso Administrador. Es más seguro quitárselo y dejarle solo los permisos de la lista del README.');
  } else {
    const missing = REQUIRED_PERMISSIONS.filter(({ flag }) => !me.permissions.has(flag)).map(({ label }) => label);
    if (missing.length) problems.push(`Al bot le faltan permisos: ${missing.join(', ')}.`);
  }

  const roles = [
    [settings.get('role_auto'), 'rol automático'],
    [settings.get('role_verified'), 'rol de verificado'],
    ...registry.managedRoles.map(([key, label]) => [settings.get(key), label]),
    ...db.prepare('SELECT level, role_id FROM level_rewards').all().map((row) => [row.role_id, `rol del nivel ${row.level}`]),
  ].filter(([id]) => id);
  for (const [id, label] of roles) {
    const role = guild.roles.cache.get(id);
    if (!role) problems.push(`El ${label} configurado ya no existe.`);
    else if (me.roles.highest.comparePositionTo(role) <= 0) {
      problems.push(`El rol del bot está por debajo del ${label} (${role.name}) y no podrá asignarlo. Súbelo en Ajustes del servidor > Roles.`);
    }
  }

  if (!settings.get('role_staff')) problems.push('Falta configurar el rol de staff (`/config rol`).');
  if (!settings.get('channel_mod')) {
    problems.push('Falta configurar el canal de moderación (`/config canal`): ahí llegan las alertas de spam, las cuentas en revisión y las sanciones.');
  }
  if (!settings.get('role_verified')) problems.push('Falta configurar el rol de verificado (`/config rol`): sin él no funciona el botón de verificación.');
  return problems;
}
