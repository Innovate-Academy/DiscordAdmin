import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { UserError, eph, fetchChannel, requireAdmin, requireStaff } from '../util.js';

const command = new SlashCommandBuilder()
  .setName('postulaciones')
  .setDescription('Postulaciones al equipo')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) => sub.setName('panel').setDescription('Publica en este canal el botón para postularse al equipo'));

const getApplication = (db, id) => db.prepare('SELECT * FROM applications WHERE id = ?').get(id);

function tally(db, id) {
  const count = (vote) => db.prepare('SELECT COUNT(*) AS total FROM application_votes WHERE application_id = ? AND vote = ?').get(id, vote).total;
  return { up: count('up'), down: count('down') };
}

function applicationMessage(application, votes) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📨 Postulación #${application.id}: ${application.position}`)
    .addFields(
      { name: 'Candidato', value: `<@${application.user_id}>`, inline: true },
      { name: 'Disponibilidad', value: application.availability, inline: true },
      { name: 'Votos del staff', value: `👍 ${votes.up} · 👎 ${votes.down}`, inline: true },
      { name: 'Experiencia', value: application.experience },
      { name: 'Por qué quiere unirse', value: application.motivation },
    );
  const button = (action, label, style) => new ButtonBuilder().setCustomId(`applications:${action}:${application.id}`).setLabel(label).setStyle(style);
  const rows = [
    new ActionRowBuilder().addComponents(button('up', '👍 A favor', ButtonStyle.Secondary), button('down', '👎 En contra', ButtonStyle.Secondary)),
    new ActionRowBuilder().addComponents(button('accept', 'Aceptar', ButtonStyle.Success), button('reject', 'Rechazar', ButtonStyle.Danger)),
  ];
  return { embeds: [embed], components: rows };
}

function applyModal() {
  const input = (id, label, style, max) =>
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(true).setMaxLength(max));
  return new ModalBuilder()
    .setCustomId('applications:send')
    .setTitle('Postulación al equipo')
    .addComponents(
      input('puesto', 'Puesto (moderador, soporte, eventos...)', TextInputStyle.Short, 80),
      input('experiencia', 'Experiencia relacionada', TextInputStyle.Paragraph, 800),
      input('disponibilidad', 'Disponibilidad semanal', TextInputStyle.Short, 100),
      input('motivo', '¿Por qué quieres unirte?', TextInputStyle.Paragraph, 800),
    );
}

async function onCommand(interaction) {
  requireAdmin(interaction);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Únete a nuestro equipo')
    .setDescription('¿Quieres ayudar en el servidor? Rellena el formulario y el equipo lo revisará. Te responderemos por mensaje privado.');
  const button = new ButtonBuilder().setCustomId('applications:open').setLabel('Postularme').setStyle(ButtonStyle.Primary);
  await interaction.channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] });
  return interaction.reply(eph('Panel de postulaciones publicado.'));
}

const hasPending = (db, userId) => Boolean(db.prepare("SELECT 1 FROM applications WHERE user_id = ? AND status = 'pending'").get(userId));

async function submit(interaction, ctx) {
  const { db, client, settings } = ctx;
  if (hasPending(db, interaction.user.id)) throw new UserError('Ya tienes una postulación en revisión.');
  const channel = await fetchChannel(client, settings.get('channel_applications') ?? settings.get('channel_mod'));
  if (!channel) throw new UserError('Las postulaciones aún no están configuradas. Avisa a un administrador.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const field = (name) => interaction.fields.getTextInputValue(name).trim();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO applications (user_id, position, experience, availability, motivation, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(interaction.user.id, field('puesto'), field('experiencia'), field('disponibilidad'), field('motivo'), channel.id, Date.now());
  const application = getApplication(db, Number(lastInsertRowid));
  try {
    const message = await channel.send({ ...applicationMessage(application, { up: 0, down: 0 }), allowedMentions: { parse: [] } });
    db.prepare('UPDATE applications SET message_id = ? WHERE id = ?').run(message.id, application.id);
  } catch (err) {
    db.prepare('DELETE FROM applications WHERE id = ?').run(application.id);
    console.error('[postulaciones] No se pudo publicar la postulación:', err.message);
    throw new UserError('No he podido registrar tu postulación. Avisa a un administrador.');
  }
  await interaction.editReply('¡Postulación enviada! El equipo la revisará y te responderemos por mensaje privado.');
}

// Un voto por persona del staff. Repetir el mismo voto lo retira; el contrario lo cambia.
async function vote(interaction, ctx, id, value) {
  const { db } = ctx;
  requireStaff(interaction, ctx.settings);
  const application = getApplication(db, id);
  if (!application || application.status !== 'pending') throw new UserError('Esta postulación ya está resuelta.');
  if (application.user_id === interaction.user.id) throw new UserError('No puedes votar tu propia postulación.');

  const previous = db.prepare('SELECT vote FROM application_votes WHERE application_id = ? AND voter_id = ?').get(id, interaction.user.id)?.vote;
  if (previous === value) db.prepare('DELETE FROM application_votes WHERE application_id = ? AND voter_id = ?').run(id, interaction.user.id);
  else {
    db.prepare(
      'INSERT INTO application_votes (application_id, voter_id, vote) VALUES (?, ?, ?) ON CONFLICT(application_id, voter_id) DO UPDATE SET vote = excluded.vote',
    ).run(id, interaction.user.id, value);
  }
  await interaction.update(applicationMessage(application, tally(db, id)));
}

async function decide(interaction, ctx, id, accepted) {
  const { db, client } = ctx;
  requireAdmin(interaction);
  const application = getApplication(db, id);
  if (!application || application.status !== 'pending') throw new UserError('Esta postulación ya está resuelta.');
  db.prepare('UPDATE applications SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(accepted ? 'accepted' : 'rejected', interaction.user.id, Date.now(), id);

  const embed = applicationMessage(application, tally(db, id)).embeds[0].addFields({
    name: 'Resolución',
    value: `${accepted ? '✅ Aceptada' : '❌ Rechazada'} por ${interaction.user}`,
  });
  await interaction.update({ embeds: [embed], components: [] });

  // La persona pidió una respuesta al postularse, así que se le escribe aunque no tenga activados los avisos.
  const user = await client.users.fetch(application.user_id).catch(() => null);
  const text = accepted
    ? `¡Buenas noticias! Tu postulación como **${application.position}** en **${interaction.guild.name}** ha sido aceptada. El equipo se pondrá en contacto contigo.`
    : `Gracias por postularte como **${application.position}** en **${interaction.guild.name}**. Esta vez no hemos podido seguir adelante con tu candidatura, pero puedes volver a intentarlo más adelante.`;
  const delivered = await user?.send(text).then(
    () => true,
    () => false,
  );
  if (!delivered) await interaction.followUp(eph(`No he podido avisar a <@${application.user_id}> por privado: tiene los mensajes cerrados. Avísale tú.`));
}

async function onComponent(interaction, ctx, action, arg) {
  if (action === 'open') {
    if (hasPending(ctx.db, interaction.user.id)) throw new UserError('Ya tienes una postulación en revisión.');
    return interaction.showModal(applyModal());
  }
  if (action === 'send') return submit(interaction, ctx);
  if (action === 'up' || action === 'down') return vote(interaction, ctx, Number(arg), action);
  if (action === 'accept' || action === 'reject') return decide(interaction, ctx, Number(arg), action === 'accept');
}

export default { id: 'applications', name: 'Postulaciones al equipo', commands: [command], onCommand, onComponent };
