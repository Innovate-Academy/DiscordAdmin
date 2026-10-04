import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { dmIfOptedIn } from '../dm.js';
import { isHttpUrl } from '../lib/text.js';
import { grantXp } from './levels.js';
import { sendModLog } from '../sanctions.js';
import { UserError, fetchChannel, requireStaff } from '../util.js';

const PUBLISH_XP = 50;

const command = new SlashCommandBuilder().setName('proyecto').setDescription('Enseña un proyecto tuyo en el escaparate del servidor');

const getProject = (db, id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id);

function projectModal() {
  const input = (id, label, style, required, max) =>
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max));
  return new ModalBuilder()
    .setCustomId('showcase:send')
    .setTitle('Tu proyecto')
    .addComponents(
      input('titulo', 'Nombre del proyecto', TextInputStyle.Short, true, 80),
      input('descripcion', '¿Qué hace y qué has aprendido?', TextInputStyle.Paragraph, true, 600),
      input('enlace', 'Enlace (GitHub, web publicada...)', TextInputStyle.Short, true, 300),
      input('imagen', 'Enlace a una captura (opcional)', TextInputStyle.Short, false, 300),
    );
}

function projectEmbed(project) {
  const embed = new EmbedBuilder()
    .setColor(0xeb459e)
    .setTitle(`🚀 ${project.title}`)
    .setURL(project.url)
    .setDescription(project.description)
    .addFields({ name: 'Autor', value: `<@${project.user_id}>`, inline: true });
  if (project.image_url) embed.setImage(project.image_url);
  return embed;
}

async function onCommand(interaction, ctx) {
  const pending = ctx.db.prepare("SELECT 1 FROM projects WHERE user_id = ? AND status = 'pending'").get(interaction.user.id);
  if (pending) throw new UserError('Ya tienes un proyecto esperando revisión. En cuanto el staff lo vea podrás enviar otro.');
  return interaction.showModal(projectModal());
}

async function submit(interaction, ctx) {
  const { db, settings } = ctx;
  const field = (name) => interaction.fields.getTextInputValue(name).trim();
  if (!isHttpUrl(field('enlace'))) throw new UserError('El enlace del proyecto tiene que empezar por http:// o https://');
  if (field('imagen') && !isHttpUrl(field('imagen'))) throw new UserError('El enlace de la captura tiene que empezar por http:// o https://');
  if (!settings.get('channel_mod') || !settings.get('channel_projects')) throw new UserError('El escaparate aún no está configurado. Avisa a un administrador.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { lastInsertRowid } = db
    .prepare('INSERT INTO projects (user_id, title, description, url, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(interaction.user.id, field('titulo'), field('descripcion'), field('enlace'), field('imagen') || null, Date.now());
  const project = getProject(db, Number(lastInsertRowid));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`showcase:approve:${project.id}`).setLabel('Publicar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`showcase:reject:${project.id}`).setLabel('Rechazar').setStyle(ButtonStyle.Danger),
  );
  await sendModLog(ctx, { content: 'Proyecto pendiente de revisión para el escaparate:', embeds: [projectEmbed(project)], components: [buttons], allowedMentions: { parse: [] } });
  await interaction.editReply('¡Recibido! El staff lo revisará y aparecerá en el escaparate.');
}

async function review(interaction, ctx, action, id) {
  const { db, client, settings } = ctx;
  requireStaff(interaction, settings);
  const project = getProject(db, id);
  if (!project || project.status !== 'pending') throw new UserError('Este proyecto ya está revisado.');

  let resolution;
  if (action === 'approve') {
    const channel = await fetchChannel(client, settings.get('channel_projects'));
    if (!channel) throw new UserError('Falta configurar el canal de proyectos con `/config canal`.');
    const link = new ButtonBuilder().setLabel('Ver el proyecto').setStyle(ButtonStyle.Link).setURL(project.url);
    const message = await channel.send({ embeds: [projectEmbed(project)], components: [new ActionRowBuilder().addComponents(link)], allowedMentions: { parse: [] } });
    db.prepare("UPDATE projects SET status = 'published', message_id = ?, reviewed_by = ? WHERE id = ?").run(message.id, interaction.user.id, id);
    grantXp(db, project.user_id, PUBLISH_XP);
    await dmIfOptedIn(ctx, project.user_id, `Tu proyecto **${project.title}** ya está en el escaparate: ${channel}. ¡Y te llevas ${PUBLISH_XP} XP!`);
    resolution = `Publicado por ${interaction.user}`;
  } else {
    db.prepare("UPDATE projects SET status = 'rejected', reviewed_by = ? WHERE id = ?").run(interaction.user.id, id);
    resolution = `Rechazado por ${interaction.user}`;
  }
  const embed = EmbedBuilder.from(interaction.message.embeds[0]).addFields({ name: 'Resolución', value: resolution });
  await interaction.update({ embeds: [embed], components: [] });
}

async function onComponent(interaction, ctx, action, arg) {
  if (action === 'send') return submit(interaction, ctx);
  if (action === 'approve' || action === 'reject') return review(interaction, ctx, action, Number(arg));
}

export default { id: 'showcase', name: 'Escaparate de proyectos', commands: [command], onCommand, onComponent };
