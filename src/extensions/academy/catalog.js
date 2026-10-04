import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { isHttpUrl } from '../../lib/text.js';
import { COURSES, COURSES_URL, PACKS, courseLine, courseName, formatPrice } from './courses.js';
import { UserError, eph, requireChannel, requireStaff } from '../../util.js';

const commands = [
  new SlashCommandBuilder().setName('cursos').setDescription('Cursos y packs de Innovate Academy'),
  new SlashCommandBuilder().setName('hosting').setDescription('Nuestro patrocinador de hosting'),
  new SlashCommandBuilder()
    .setName('tiktok')
    .setDescription('Anuncia un vídeo nuevo en el canal de novedades (staff)')
    .addStringOption((opt) => opt.setName('enlace').setDescription('Enlace del vídeo').setRequired(true))
    .addStringOption((opt) => opt.setName('texto').setDescription('Frase para acompañarlo').setMaxLength(300)),
];

const linkButton = (label, url) => new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url));

async function onCommand(interaction, ctx) {
  const { settings } = ctx;

  if (interaction.commandName === 'cursos') {
    const packs = PACKS.map((pack) => `**${pack.name}** · ${pack.courses.map(courseName).join(' + ')} · ${formatPrice(pack.price)}`);
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('📚 Cursos de Innovate Academy')
      .setDescription(`Clases en vivo dos veces por semana, seguimiento cercano y proyecto final. Pago único por curso.\n\n${COURSES.map(courseLine).join('\n')}`)
      .addFields({ name: 'Packs (15 % de ahorro)', value: packs.join('\n') })
      .setFooter({ text: 'Precios orientativos en USD. El precio vigente y otras monedas, en la web.' });
    return interaction.reply({ embeds: [embed], components: [linkButton('Ver en la web', settings.get('web_url') ?? COURSES_URL)] });
  }

  if (interaction.commandName === 'hosting') {
    return interaction.reply({ content: settings.get('sponsor_text'), components: [linkButton('Ir a SolarCloud', settings.get('sponsor_url'))] });
  }

  requireStaff(interaction, settings);
  const url = interaction.options.getString('enlace', true).trim();
  if (!isHttpUrl(url) || !/(^|\.)tiktok\.com$/.test(new URL(url).hostname)) throw new UserError('El enlace tiene que ser de tiktok.com.');
  const channel = await requireChannel(ctx, 'channel_news', 'el canal de novedades');
  const text = interaction.options.getString('texto') ?? '¡Nuevo vídeo en nuestro TikTok!';
  await channel.send(`📱 ${text}\n${url}`);
  return interaction.reply(eph(`Publicado en ${channel}.`));
}

export default { id: 'catalog', name: 'Catálogo, TikTok y patrocinador', commands, onCommand };
