import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { JoinWindow } from '../lib/automod.js';
import { discordTime } from '../lib/dates.js';
import { registry } from '../registry.js';
import { recordSanction, sendModLog } from '../sanctions.js';
import { UserError, eph, requireAdmin, requireStaff, safe } from '../util.js';
import { recordMemberEvent } from './stats.js';

const DAY = 86_400_000;

const commands = [
  new SlashCommandBuilder()
    .setName('verificacion')
    .setDescription('Verificación de entrada')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) => sub.setName('panel').setDescription('Publica en este canal el botón para aceptar las normas'))
    .addSubcommand((sub) => sub.setName('existentes').setDescription('Da el rol de verificado a quienes ya están en el servidor')),
  new SlashCommandBuilder()
    .setName('raid')
    .setDescription('Modo raid: pausa la verificación de nuevas entradas (staff)')
    .addSubcommand((sub) => sub.setName('activar').setDescription('Pausa la verificación'))
    .addSubcommand((sub) => sub.setName('desactivar').setDescription('Reanuda la verificación'))
    .addSubcommand((sub) => sub.setName('estado').setDescription('Muestra si el modo raid está activo')),
];

const raidActive = (settings) => settings.get('raid_mode') === '1';

function register(client, ctx) {
  const { settings } = ctx;
  const joins = new JoinWindow();

  client.on(
    Events.GuildMemberAdd,
    safe('anti-raid', async (member) => {
      if (member.guild.id !== ctx.guildId) return;
      const limit = settings.getNumber('raid_joins');
      const seconds = settings.getNumber('raid_seconds');
      if (!joins.add(Date.now(), { limit, windowMs: seconds * 1000 }) || raidActive(settings)) return;

      settings.set('raid_mode', 1);
      const staffRole = settings.get('role_staff');
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('🚨 Modo raid activado')
        .setDescription(`Han entrado más de ${limit} cuentas en ${seconds} segundos. La verificación queda en pausa: nadie nuevo puede acceder al servidor hasta que la reanudéis.`);
      const button = new ButtonBuilder().setCustomId('verification:raidoff').setLabel('Desactivar modo raid').setStyle(ButtonStyle.Success);
      await sendModLog(
        ctx,
        {
          content: staffRole ? `<@&${staffRole}>` : undefined,
          embeds: [embed],
          components: [new ActionRowBuilder().addComponents(button)],
          allowedMentions: { roles: staffRole ? [staffRole] : [] },
        },
        { notifyDuty: true },
      );
    }),
  );
}

async function onCommand(interaction, ctx) {
  const { settings } = ctx;
  if (interaction.commandName === 'verificacion') {
    requireAdmin(interaction);
    const roleId = settings.get('role_verified');
    if (!roleId) throw new UserError('Primero configura el rol de verificado con `/config rol`.');

    if (interaction.options.getSubcommand() === 'existentes') {
      // Para activar la verificación en un servidor con gente dentro sin dejar a nadie fuera.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const members = await interaction.guild.members.fetch();
      let given = 0;
      let failed = 0;
      for (const member of members.values()) {
        if (member.user.bot || member.roles.cache.has(roleId)) continue;
        await member.roles.add(roleId).then(
          () => given++,
          () => failed++,
        );
      }
      return interaction.editReply(`Rol de verificado dado a ${given} miembros.${failed ? ` No se pudo con ${failed}: revisa que el rol del bot esté por encima.` : ''}`);
    }

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Verificación')
      .setDescription('Lee las normas del servidor y pulsa el botón para acceder al resto de canales.');
    const button = new ButtonBuilder().setCustomId('verification:accept').setLabel('Acepto las normas').setStyle(ButtonStyle.Success);
    await interaction.channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] });
    return interaction.reply(eph('Panel de verificación publicado.'));
  }

  requireStaff(interaction, settings);
  const sub = interaction.options.getSubcommand();
  if (sub === 'estado') return interaction.reply(eph(raidActive(settings) ? 'El modo raid está **activado**.' : 'El modo raid está desactivado.'));
  settings.set('raid_mode', sub === 'activar' ? 1 : 0);
  return interaction.reply(eph(sub === 'activar' ? 'Modo raid activado: la verificación queda en pausa.' : 'Modo raid desactivado: la verificación vuelve a funcionar.'));
}

async function accept(interaction, ctx) {
  const { db, settings } = ctx;
  const roleId = settings.get('role_verified');
  if (!roleId) throw new UserError('La verificación aún no está configurada. Avisa a un administrador.');
  const member = interaction.member;
  if (member.roles.cache.has(roleId)) return interaction.reply(eph('Ya estás verificado.'));
  if (raidActive(settings)) throw new UserError('La verificación está en pausa por seguridad. Inténtalo de nuevo más tarde.');

  const minDays = settings.getNumber('verify_min_account_days');
  const user = interaction.user;
  if (Date.now() - user.createdTimestamp >= minDays * DAY) {
    await member.roles.add(roleId);
    recordMemberEvent(db, user.id, 'verify');
    // Las extensiones pueden añadir algo a la respuesta, por ejemplo una pregunta de bienvenida.
    const prompts = registry.verifiedPrompts.map((build) => build());
    return interaction.reply({
      content: ['¡Listo! Ya puedes ver el resto del servidor.', ...prompts.map((prompt) => prompt.content)].join(' '),
      components: prompts.flatMap((prompt) => prompt.components),
      flags: MessageFlags.Ephemeral,
    });
  }

  // Cuenta recién creada: la revisa el staff antes de dejarla pasar.
  const pending = db.prepare('SELECT 1 FROM verification_pending WHERE user_id = ?').get(user.id);
  if (!pending) {
    db.prepare('INSERT INTO verification_pending (user_id, requested_at) VALUES (?, ?)').run(user.id, Date.now());
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('🔎 Cuenta nueva en revisión')
      .addFields({ name: 'Miembro', value: `${user}`, inline: true }, { name: 'Cuenta creada', value: discordTime(user.createdTimestamp, 'R'), inline: true });
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`verification:approve:${user.id}`).setLabel('Aprobar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`verification:kick:${user.id}`).setLabel('Expulsar').setStyle(ButtonStyle.Danger),
    );
    await sendModLog(ctx, { embeds: [embed], components: [buttons], allowedMentions: { parse: [] } }, { notifyDuty: true });
  }
  return interaction.reply(eph('Tu cuenta de Discord es muy reciente, así que el staff revisará tu acceso. Te daremos paso en cuanto lo veamos.'));
}

// Botones de la alerta de cuenta nueva.
async function review(interaction, ctx, action, userId) {
  const { db, settings } = ctx;
  requireStaff(interaction, settings);
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  let resolution;
  if (!member) {
    resolution = 'Ya no está en el servidor';
  } else if (action === 'approve') {
    await member.roles.add(settings.get('role_verified'));
    recordMemberEvent(db, userId, 'verify');
    resolution = `Aprobado por ${interaction.user}`;
  } else {
    if (!member.kickable) throw new UserError('No puedo expulsar a esa persona: su rol está por encima del mío.');
    await member.kick('Cuenta nueva rechazada en la verificación');
    await recordSanction(ctx, { type: 'kick', userId, moderatorId: interaction.user.id, reason: 'Cuenta nueva rechazada en la verificación' });
    resolution = `Expulsado por ${interaction.user}`;
  }
  db.prepare('DELETE FROM verification_pending WHERE user_id = ?').run(userId);
  const embed = EmbedBuilder.from(interaction.message.embeds[0]).addFields({ name: 'Resolución', value: resolution });
  await interaction.update({ embeds: [embed], components: [] });
}

async function onComponent(interaction, ctx, action, arg) {
  if (action === 'accept') return accept(interaction, ctx);
  if (action === 'approve' || action === 'kick') return review(interaction, ctx, action, arg);
  if (action === 'raidoff') {
    requireStaff(interaction, ctx.settings);
    ctx.settings.set('raid_mode', 0);
    const embed = EmbedBuilder.from(interaction.message.embeds[0]).addFields({ name: 'Resolución', value: `Desactivado por ${interaction.user}` });
    await interaction.update({ embeds: [embed], components: [] });
  }
}

export default { id: 'verification', name: 'Verificación de entrada y anti-raid', commands, register, onCommand, onComponent };
