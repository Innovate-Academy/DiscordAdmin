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
import { DEFAULT_ALLOWED_DOMAINS, DuplicateTracker, evaluateMessage, normalizeDomain } from '../lib/automod.js';
import { truncate } from '../lib/text.js';
import { registry } from '../registry.js';
import { recordSanction, sendModLog } from '../sanctions.js';
import { UserError, eph, fetchChannel, isMemberMessage, memberIsStaff, requireAdmin, requireStaff, safe } from '../util.js';

const DAY = 86_400_000;
const TIMEOUT_MS = DAY;
const NOTICE_MS = 15_000;
const RULE_LABELS = { scam: 'Posible estafa', mentions: 'Menciones masivas', duplicate: 'Mismo mensaje en varios canales' };

const command = new SlashCommandBuilder()
  .setName('automod')
  .setDescription('Filtro automático de estafas y spam')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) => sub.setName('activar').setDescription('Activa el filtro'))
  .addSubcommand((sub) => sub.setName('desactivar').setDescription('Desactiva el filtro'))
  .addSubcommand((sub) => sub.setName('dominios').setDescription('Sitios de los que los miembros nuevos pueden compartir enlaces'))
  .addSubcommand((sub) =>
    sub
      .setName('permitir')
      .setDescription('Añade un sitio permitido')
      .addStringOption((opt) => opt.setName('dominio').setDescription('Por ejemplo ejemplo.com').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('quitar')
      .setDescription('Quita un sitio que añadiste')
      .addStringOption((opt) => opt.setName('dominio').setDescription('Por ejemplo ejemplo.com').setRequired(true)),
  );

// Sitios permitidos de serie: los del núcleo más los que aporte una extensión.
const builtInDomains = () => [...DEFAULT_ALLOWED_DOMAINS, ...registry.allowedDomains];

export function allowedDomains(db) {
  return [...builtInDomains(), ...db.prepare('SELECT domain FROM allowed_domains').all().map((row) => row.domain)];
}

function alertMessage(member, channelId, content, label, detail) {
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`🚨 ${label}`)
    .setDescription(truncate(content || '(sin texto)', 1000))
    .addFields(
      { name: 'Miembro', value: `${member}`, inline: true },
      { name: 'Canal', value: `<#${channelId}>`, inline: true },
      { name: 'Detalle', value: detail },
      { name: 'Acción', value: 'Mensaje borrado y miembro silenciado 24 h.' },
    );
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`automod:ban:${member.id}`).setLabel('Banear').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`automod:release:${member.id}`).setLabel('Liberar (falso positivo)').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [buttons], allowedMentions: { parse: [] } };
}

// Infracción grave: borra, silencia 24 h, lo anota en el historial y avisa al staff.
async function punish(ctx, message, member, rule, detail, duplicates = []) {
  await message.delete().catch(() => {});
  for (const { channelId, messageId } of duplicates) {
    if (messageId === message.id) continue;
    const channel = await fetchChannel(ctx.client, channelId);
    await channel?.messages.delete(messageId).catch(() => {});
  }
  const label = RULE_LABELS[rule];
  if (member.moderatable) await member.timeout(TIMEOUT_MS, `Automático: ${label}`).catch(() => {});
  await recordSanction(ctx, {
    type: 'timeout',
    userId: member.id,
    moderatorId: ctx.client.user.id,
    reason: `Automático: ${label}. ${detail}`,
    durationMs: TIMEOUT_MS,
  });
  await sendModLog(ctx, alertMessage(member, message.channelId, message.content, label, detail), { notifyDuty: true });
}

// Infracción leve: enlace de un sitio no permitido por parte de un miembro nuevo.
async function removeLink(ctx, message, member) {
  await message.delete().catch(() => {});
  const days = ctx.settings.getNumber('automod_link_days');
  const notice = await message.channel
    .send({
      content: `${member}, durante tus primeros ${days} días solo puedes compartir enlaces de sitios permitidos. Si es una duda de clase, pega el código directamente o pide ayuda al staff.`,
      allowedMentions: { users: [member.id] },
    })
    .catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), NOTICE_MS).unref();
}

function register(client, ctx) {
  const { db, settings } = ctx;
  const duplicates = new DuplicateTracker();

  client.on(
    Events.MessageCreate,
    safe('automod', async (message) => {
      if (!isMemberMessage(message, ctx) || settings.get('automod_enabled') !== '1') return;
      const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
      if (!member || memberIsStaff(member, settings)) return;

      const now = Date.now();
      const verdict = evaluateMessage(message.content, {
        isNewMember: now - member.joinedTimestamp < settings.getNumber('automod_link_days') * DAY,
        allowedDomains: allowedDomains(db),
        mentionCount: message.mentions.users.size,
      });
      if (verdict && verdict.rule !== 'link') return punish(ctx, message, member, verdict.rule, verdict.detail);

      const repeated = duplicates.add(member.id, { content: message.content, channelId: message.channelId, messageId: message.id, now });
      if (repeated) return punish(ctx, message, member, 'duplicate', `Repetido en ${repeated.length} mensajes en menos de 30 s`, repeated);

      if (verdict) return removeLink(ctx, message, member);
    }),
  );
}

async function onCommand(interaction, ctx) {
  requireAdmin(interaction);
  const { db, settings } = ctx;
  const sub = interaction.options.getSubcommand();

  if (sub === 'activar' || sub === 'desactivar') {
    settings.set('automod_enabled', sub === 'activar' ? 1 : 0);
    return interaction.reply(eph(sub === 'activar' ? 'Filtro automático activado.' : 'Filtro automático desactivado.'));
  }
  if (sub === 'dominios') {
    const extra = db.prepare('SELECT domain FROM allowed_domains ORDER BY domain').all().map((row) => row.domain);
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Sitios permitidos')
      .setDescription(`**De serie:** ${builtInDomains().join(', ')}\n\n**Añadidos:** ${extra.join(', ') || '*ninguno*'}`.slice(0, 4000));
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  const domain = normalizeDomain(interaction.options.getString('dominio', true));
  if (!domain) throw new UserError('Eso no parece un dominio. Ejemplo: `ejemplo.com`.');
  if (sub === 'permitir') {
    db.prepare('INSERT OR IGNORE INTO allowed_domains (domain) VALUES (?)').run(domain);
    return interaction.reply(eph(`Los miembros nuevos ya pueden compartir enlaces de \`${domain}\`.`));
  }
  if (builtInDomains().includes(domain)) throw new UserError('Ese sitio viene permitido de serie y no se puede quitar.');
  const { changes } = db.prepare('DELETE FROM allowed_domains WHERE domain = ?').run(domain);
  if (!changes) throw new UserError('Ese sitio no estaba en la lista.');
  return interaction.reply(eph(`\`${domain}\` ya no está permitido.`));
}

// Botones de la alerta en el canal de moderación.
async function onComponent(interaction, ctx, action, userId) {
  requireStaff(interaction, ctx.settings);
  let resolution;
  if (action === 'ban') {
    await interaction.guild.members.ban(userId, { reason: 'Estafa o spam (alerta automática)', deleteMessageSeconds: 86_400 });
    await recordSanction(ctx, { type: 'ban', userId, moderatorId: interaction.user.id, reason: 'Estafa o spam (alerta automática)' });
    resolution = `Baneado por ${interaction.user}`;
  } else if (action === 'release') {
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    await member?.timeout(null).catch(() => {});
    await recordSanction(ctx, { type: 'untimeout', userId, moderatorId: interaction.user.id, reason: 'Falso positivo del filtro automático' });
    resolution = `Liberado por ${interaction.user}`;
  } else {
    return;
  }
  const embed = EmbedBuilder.from(interaction.message.embeds[0]).addFields({ name: 'Resolución', value: resolution });
  await interaction.update({ embeds: [embed], components: [] });
}

export default { id: 'automod', name: 'Filtro de estafas y spam', commands: [command], register, onCommand, onComponent };
