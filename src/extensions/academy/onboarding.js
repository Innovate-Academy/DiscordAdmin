import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SlashCommandBuilder, StringSelectMenuBuilder } from 'discord.js';
import { COURSES_URL, INTERESTS, getInterest, recommend } from './courses.js';
import { ensureRole } from '../../roles.js';
import { UserError } from '../../util.js';

const command = new SlashCommandBuilder().setName('intereses').setDescription('Dinos qué quieres aprender y te recomendamos por dónde empezar');

export const interestRoleKey = (interestId) => `role_interest_${interestId}`;

// Menú "¿Qué quieres aprender?". Se muestra al verificarse y con /intereses.
export function interestMenu() {
  const select = new StringSelectMenuBuilder()
    .setCustomId('onboarding:interest')
    .setPlaceholder('¿Qué quieres aprender?')
    .addOptions(INTERESTS.map(({ id, label, emoji }) => ({ label, value: id, emoji })));
  return new ActionRowBuilder().addComponents(select);
}

async function onCommand(interaction) {
  return interaction.reply({
    content: 'Elige lo que más te interesa. Lo usamos para recomendarte un curso y avisarte solo de los talleres que te encajan.',
    components: [interestMenu()],
    flags: MessageFlags.Ephemeral,
  });
}

async function onComponent(interaction, ctx, action) {
  if (action !== 'interest') return;
  const { db, settings } = ctx;
  const interest = getInterest(interaction.values[0]);
  if (!interest) throw new UserError('Esa opción ya no existe. Usa `/intereses` de nuevo.');
  const userId = interaction.user.id;

  // Un solo interés por persona: se cambia el rol anterior por el nuevo.
  const previous = db.prepare('SELECT interest FROM member_interests WHERE user_id = ?').get(userId)?.interest;
  const roleId = await ensureRole(interaction.guild, settings, interestRoleKey(interest.id), `Interés · ${interest.label}`);
  const previousRole = previous && previous !== interest.id ? settings.get(interestRoleKey(previous)) : null;
  if (previousRole) await interaction.member.roles.remove(previousRole).catch(() => {});
  await interaction.member.roles.add(roleId);
  db.prepare(
    'INSERT INTO member_interests (user_id, interest, chosen_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET interest = excluded.interest, chosen_at = excluded.chosen_at',
  ).run(userId, interest.id, Date.now());

  const link = new ButtonBuilder().setLabel('Ver los cursos').setStyle(ButtonStyle.Link).setURL(settings.get('web_url') ?? COURSES_URL);
  await interaction.update({
    content: `${interest.emoji} Apuntado: **${interest.label}**.\n${recommend(interest.id)}\nPuedes ver todo el catálogo con \`/cursos\` y cambiar de interés con \`/intereses\`.`,
    components: [new ActionRowBuilder().addComponents(link)],
  });
}

export default { id: 'onboarding', name: 'Intereses y recomendación', commands: [command], onCommand, onComponent };
