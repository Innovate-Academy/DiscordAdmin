import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { isValidTimeZone } from '../lib/dates.js';
import { isHttpUrl, truncate } from '../lib/text.js';
import { registerConfig, registry } from '../registry.js';
import { isEnabled } from '../settings.js';
import { checkSetup } from '../setupCheck.js';
import { UserError, eph, requireAdmin } from '../util.js';

// Canales, roles y textos del núcleo. Las extensiones añaden los suyos con registerConfig.
registerConfig({
  channels: {
    bienvenida: { key: 'channel_welcome', label: 'Canal de bienvenida' },
    niveles: { key: 'channel_levels', label: 'Canal de niveles' },
    general: { key: 'channel_general', label: 'Canal general (recordatorio periódico)' },
    eventos: { key: 'channel_events', label: 'Canal de eventos' },
    tareas: { key: 'channel_tasks', label: 'Canal de tareas' },
    logs: { key: 'channel_logs', label: 'Canal de logs' },
    moderacion: { key: 'channel_mod', label: 'Canal de moderación (alertas y sanciones)' },
    proyectos: { key: 'channel_projects', label: 'Canal de proyectos (escaparate)' },
    retos: { key: 'channel_challenges', label: 'Canal de retos' },
    postulaciones: { key: 'channel_applications', label: 'Canal de postulaciones (solo staff)' },
    tickets: { key: 'category_tickets', label: 'Categoría de tickets', category: true },
  },
  roles: {
    staff: { key: 'role_staff', label: 'Rol de staff' },
    auto: { key: 'role_auto', label: 'Rol automático al entrar' },
    verificado: { key: 'role_verified', label: 'Rol de miembro verificado' },
    supervisor: { key: 'role_supervisor', label: 'Rol de supervisor (reportes confidenciales)' },
  },
  texts: {
    bienvenida: { key: 'welcome_text', label: 'Texto de bienvenida' },
    recordatorio: { key: 'reminder_text', label: 'Texto del recordatorio periódico' },
  },
});

const choices = (map) => [...map].map(([value, { label }]) => ({ name: label, value }));

// El comando se construye la primera vez que se pide, cuando las extensiones ya han registrado sus opciones.
let command = null;
function buildCommand() {
  return new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configura el bot')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) => sub.setName('ver').setDescription('Muestra la configuración actual'))
    .addSubcommand((sub) =>
      sub
        .setName('canal')
        .setDescription('Asigna un canal (o la categoría de tickets)')
        .addStringOption((opt) => opt.setName('tipo').setDescription('Para qué se usa').setRequired(true).addChoices(...choices(registry.channels)))
        .addChannelOption((opt) => opt.setName('canal').setDescription('Canal o categoría').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('rol')
        .setDescription('Asigna un rol')
        .addStringOption((opt) => opt.setName('tipo').setDescription('Para qué se usa').setRequired(true).addChoices(...choices(registry.roles)))
        .addRoleOption((opt) => opt.setName('rol').setDescription('Rol').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('texto')
        .setDescription('Cambia un texto. En la bienvenida puedes usar {usuario}, {servidor} y {miembros}')
        .addStringOption((opt) => opt.setName('tipo').setDescription('Qué texto').setRequired(true).addChoices(...choices(registry.texts)))
        .addStringOption((opt) => opt.setName('texto').setDescription('Nuevo texto').setRequired(true).setMaxLength(1500)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('web')
        .setDescription('URL que enlaza el recordatorio periódico')
        .addStringOption((opt) => opt.setName('url').setDescription('Por ejemplo https://miweb.com').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('recordatorio')
        .setDescription('Cada cuántos mensajes aparece el recordatorio periódico')
        .addIntegerOption((opt) => opt.setName('cada').setDescription('Número de mensajes').setRequired(true).setMinValue(5))
        .addIntegerOption((opt) => opt.setName('minutos').setDescription('Minutos mínimos entre recordatorios').setMinValue(0)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('retencion')
        .setDescription('Días que se conserva el registro de mensajes')
        .addIntegerOption((opt) => opt.setName('dias').setDescription('0 = no borrar nunca').setRequired(true).setMinValue(0)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('nivel-rol')
        .setDescription('Rol que se da al alcanzar un nivel (sin rol = quitar la recompensa)')
        .addIntegerOption((opt) => opt.setName('nivel').setDescription('Nivel').setRequired(true).setMinValue(1))
        .addRoleOption((opt) => opt.setName('rol').setDescription('Rol de recompensa')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('zona')
        .setDescription('Zona horaria para las fechas de eventos, avisos y tareas')
        .addStringOption((opt) => opt.setName('zona').setDescription('Por ejemplo Europe/Madrid o America/Mexico_City').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('seguridad')
        .setDescription('Ajustes del filtro de spam, la verificación y el anti-raid')
        .addIntegerOption((opt) =>
          opt.setName('dias_enlaces').setDescription('Días en los que un miembro nuevo solo puede enviar enlaces permitidos').setMinValue(0).setMaxValue(90),
        )
        .addIntegerOption((opt) =>
          opt.setName('dias_cuenta').setDescription('Antigüedad mínima de la cuenta para verificarse sin revisión del staff').setMinValue(0).setMaxValue(90),
        )
        .addIntegerOption((opt) => opt.setName('raid_entradas').setDescription('Entradas seguidas que activan el modo raid').setMinValue(3).setMaxValue(100))
        .addIntegerOption((opt) => opt.setName('raid_segundos').setDescription('En cuántos segundos').setMinValue(10).setMaxValue(600)),
    )
    .addSubcommand((sub) => sub.setName('revisar').setDescription('Comprueba permisos, roles y lo que falte por configurar'))
    .addSubcommand((sub) => sub.setName('modulos').setDescription('Lista los módulos del bot y cuáles están activos'))
    .addSubcommand((sub) =>
      sub
        .setName('modulo')
        .setDescription('Activa o desactiva un módulo en este servidor')
        .addStringOption((opt) =>
          opt.setName('accion').setDescription('Qué hacer').setRequired(true).addChoices({ name: 'Activar', value: 'on' }, { name: 'Desactivar', value: 'off' }),
        )
        .addStringOption((opt) => opt.setName('nombre').setDescription('Identificador del módulo, como aparece en /config modulos').setRequired(true)),
    );
}

const SECURITY_OPTIONS = {
  dias_enlaces: 'automod_link_days',
  dias_cuenta: 'verify_min_account_days',
  raid_entradas: 'raid_joins',
  raid_segundos: 'raid_seconds',
};

function securitySummary(settings) {
  return [
    `filtro ${settings.get('automod_enabled') === '1' ? 'activado' : 'desactivado'}`,
    `enlaces restringidos los primeros ${settings.get('automod_link_days')} días`,
    `revisión de cuentas de menos de ${settings.get('verify_min_account_days')} días`,
    `modo raid con más de ${settings.get('raid_joins')} entradas en ${settings.get('raid_seconds')} s`,
  ].join(' · ');
}

function showConfig(ctx) {
  const { settings, db } = ctx;
  const value = (key, format) => (settings.get(key) ? format(settings.get(key)) : '*sin configurar*');
  const lines = [
    ...[...registry.channels.values()].map(({ key, label }) => `**${label}:** ${value(key, (id) => `<#${id}>`)}`),
    ...[...registry.roles.values()].map(({ key, label }) => `**${label}:** ${value(key, (id) => `<@&${id}>`)}`),
    `**Web:** ${value('web_url', (url) => url)}`,
    `**Recordatorio periódico:** cada ${settings.get('reminder_every')} mensajes, mínimo ${settings.get('reminder_min_minutes')} min entre avisos`,
    `**Retención del registro:** ${settings.getNumber('retention_days') > 0 ? `${settings.get('retention_days')} días` : 'sin borrado'}`,
    `**Zona horaria:** ${settings.get('timezone')}`,
    `**Seguridad:** ${securitySummary(settings)}`,
    ...[...registry.texts.values()].map(({ key, label }) => `**${label}:** ${truncate(settings.get(key) ?? '', 300)}`),
  ];
  const rewards = db.prepare('SELECT level, role_id FROM level_rewards ORDER BY level').all();
  lines.push(`**Roles por nivel:** ${rewards.length ? rewards.map((r) => `nivel ${r.level} → <@&${r.role_id}>`).join(', ') : '*ninguno*'}`);
  return new EmbedBuilder().setColor(0x5865f2).setTitle('Configuración del bot').setDescription(truncate(lines.join('\n'), 4000));
}

function listModules(ctx) {
  const lines = (ctx.modules ?? []).map((mod) => {
    const state = mod.required ? '🔒 siempre activo' : isEnabled(ctx.settings, mod) ? '🟢 activo' : '⚪ desactivado';
    return `\`${mod.id}\` · ${mod.name} — ${state}`;
  });
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Módulos')
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: 'Usa /config modulo con el identificador de la izquierda.' });
}

async function toggleModule(interaction, ctx) {
  const { settings } = ctx;
  const id = interaction.options.getString('nombre', true).trim();
  const mod = (ctx.modules ?? []).find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
  if (!mod) throw new UserError('No existe ningún módulo con ese identificador. Míralos con `/config modulos`.');
  if (mod.required) throw new UserError(`El módulo **${mod.name}** no se puede desactivar.`);

  const disabled = new Set(settings.get('modules_disabled').split(',').filter(Boolean));
  const turnOn = interaction.options.getString('accion', true) === 'on';
  if (turnOn) disabled.delete(mod.id);
  else disabled.add(mod.id);
  settings.set('modules_disabled', [...disabled].join(','));

  // Sus comandos aparecen o desaparecen del servidor al momento.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await ctx.refreshCommands?.();
  return interaction.editReply(`Módulo **${mod.name}** ${turnOn ? 'activado' : 'desactivado'}.`);
}

async function onCommand(interaction, ctx) {
  requireAdmin(interaction);
  const { settings, db } = ctx;
  const options = interaction.options;

  switch (options.getSubcommand()) {
    case 'ver':
      return interaction.reply({ embeds: [showConfig(ctx)], flags: MessageFlags.Ephemeral });
    case 'canal': {
      const entry = registry.channels.get(options.getString('tipo', true));
      const channel = options.getChannel('canal', true);
      const isCategory = channel.type === ChannelType.GuildCategory;
      if (entry.category && !isCategory) throw new UserError('Para los tickets tienes que elegir una categoría, no un canal.');
      if (!entry.category && channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
        throw new UserError('Elige un canal de texto.');
      }
      settings.set(entry.key, channel.id);
      return interaction.reply(eph(`${entry.label}: ${channel}`));
    }
    case 'rol': {
      const entry = registry.roles.get(options.getString('tipo', true));
      const role = options.getRole('rol', true);
      settings.set(entry.key, role.id);
      return interaction.reply(eph(`${entry.label}: ${role}`));
    }
    case 'texto': {
      const entry = registry.texts.get(options.getString('tipo', true));
      settings.set(entry.key, options.getString('texto', true));
      return interaction.reply(eph(`${entry.label} actualizado.`));
    }
    case 'web': {
      const url = options.getString('url', true).trim();
      if (!isHttpUrl(url)) throw new UserError('La URL tiene que empezar por http:// o https://');
      settings.set('web_url', url);
      return interaction.reply(eph(`Web: ${url}`));
    }
    case 'recordatorio': {
      settings.set('reminder_every', options.getInteger('cada', true));
      const minutes = options.getInteger('minutos');
      if (minutes !== null) settings.set('reminder_min_minutes', minutes);
      return interaction.reply(
        eph(`Recordatorio cada ${settings.get('reminder_every')} mensajes, mínimo ${settings.get('reminder_min_minutes')} min entre avisos.`),
      );
    }
    case 'retencion': {
      const days = options.getInteger('dias', true);
      settings.set('retention_days', days);
      return interaction.reply(eph(days > 0 ? `El registro se conserva ${days} días.` : 'El registro ya no se borra automáticamente.'));
    }
    case 'nivel-rol': {
      const level = options.getInteger('nivel', true);
      const role = options.getRole('rol');
      if (!role) {
        db.prepare('DELETE FROM level_rewards WHERE level = ?').run(level);
        return interaction.reply(eph(`El nivel ${level} ya no da ningún rol.`));
      }
      db.prepare('INSERT INTO level_rewards (level, role_id) VALUES (?, ?) ON CONFLICT(level) DO UPDATE SET role_id = excluded.role_id').run(level, role.id);
      return interaction.reply(eph(`Al llegar al nivel ${level} se dará el rol ${role}.`));
    }
    case 'zona': {
      const zone = options.getString('zona', true).trim();
      if (!isValidTimeZone(zone)) throw new UserError('Zona horaria no reconocida. Ejemplos: Europe/Madrid, America/Mexico_City.');
      settings.set('timezone', zone);
      return interaction.reply(eph(`Zona horaria: ${zone}`));
    }
    case 'seguridad': {
      for (const [option, key] of Object.entries(SECURITY_OPTIONS)) {
        const value = options.getInteger(option);
        if (value !== null) settings.set(key, value);
      }
      return interaction.reply(eph(`Seguridad: ${securitySummary(settings)}.`));
    }
    case 'revisar': {
      const problems = checkSetup(interaction.guild, ctx);
      const text = problems.length ? problems.map((problem) => `⚠️ ${problem}`).join('\n') : '✅ Todo en orden: permisos, roles y configuración.';
      return interaction.reply(eph(text));
    }
    case 'modulos':
      return interaction.reply({ embeds: [listModules(ctx)], flags: MessageFlags.Ephemeral });
    case 'modulo':
      return toggleModule(interaction, ctx);
  }
}

export default {
  id: 'config',
  name: 'Configuración',
  required: true,
  get commands() {
    command ??= buildCommand();
    return [command];
  },
  onCommand,
};
