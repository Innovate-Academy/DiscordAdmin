import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { discordTime } from '../lib/dates.js';
import { registry } from '../registry.js';

const commands = [
  new SlashCommandBuilder().setName('mis-datos').setDescription('Qué guarda el bot sobre ti'),
  new SlashCommandBuilder().setName('borrar-mis-datos').setDescription('Borra tus mensajes del registro del bot'),
];

const count = (db, sql, userId) => db.prepare(sql).get(userId).total;

// Borra del registro los mensajes de una persona y sus versiones anteriores. Devuelve cuántos.
export function eraseUserMessages(db, userId) {
  db.prepare('DELETE FROM message_edits WHERE message_id IN (SELECT id FROM messages WHERE author_id = ?)').run(userId);
  return Number(db.prepare('DELETE FROM messages WHERE author_id = ?').run(userId).changes);
}

async function onCommand(interaction, ctx) {
  const { db, settings } = ctx;
  const userId = interaction.user.id;

  if (interaction.commandName === 'borrar-mis-datos') {
    const button = new ButtonBuilder().setCustomId('privacy:erase').setLabel('Sí, borrar mis mensajes del registro').setStyle(ButtonStyle.Danger);
    return interaction.reply({
      content:
        'Se borrarán del registro del bot todos tus mensajes guardados. Tus mensajes en Discord no se tocan, y lo que escribas a partir de ahora se volverá a registrar.\n' +
        'Tu nivel se conserva, igual que las sanciones y los tickets, que el staff necesita para moderar. Para borrar eso, escribe al staff.',
      components: [new ActionRowBuilder().addComponents(button)],
      flags: MessageFlags.Ephemeral,
    });
  }

  const messages = db.prepare('SELECT COUNT(*) AS total, MIN(created_at) AS oldest FROM messages WHERE author_id = ?').get(userId);
  const level = db.prepare('SELECT xp, level FROM levels WHERE user_id = ?').get(userId);
  const retention = settings.getNumber('retention_days');
  const lines = [
    `**Mensajes en el registro:** ${messages.total}${messages.oldest ? ` (el más antiguo, de ${discordTime(messages.oldest, 'd')})` : ''}`,
    `**Nivel:** ${level ? `${level.level} (${level.xp} XP)` : 'sin experiencia todavía'}`,
    `**Sanciones:** ${count(db, 'SELECT COUNT(*) AS total FROM sanctions WHERE user_id = ?', userId)}`,
    `**Tickets abiertos por ti:** ${count(db, 'SELECT COUNT(*) AS total FROM tickets WHERE user_id = ?', userId)}`,
    `**Inscripciones a eventos:** ${count(db, 'SELECT COUNT(*) AS total FROM event_signups WHERE user_id = ?', userId)}`,
    `**Participaciones en sorteos:** ${count(db, 'SELECT COUNT(*) AS total FROM giveaway_entries WHERE user_id = ?', userId)}`,
    ...registry.privacyLines.map((line) => line(db, userId)),
    '',
    retention > 0 ? `Los mensajes del registro se borran solos a los ${retention} días.` : 'Los mensajes del registro no se borran automáticamente.',
    'Con `/borrar-mis-datos` puedes borrar ya tus mensajes del registro.',
  ];
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Lo que el bot guarda sobre ti').setDescription(lines.join('\n'));
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function onComponent(interaction, ctx, action) {
  if (action !== 'erase') return;
  const erased = eraseUserMessages(ctx.db, interaction.user.id);
  await interaction.update({ content: `Hecho: se han borrado ${erased} mensajes tuyos del registro.`, components: [] });
}

export default { id: 'privacy', name: 'Privacidad (/mis-datos)', commands, onCommand, onComponent };
