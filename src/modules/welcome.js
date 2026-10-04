import { EmbedBuilder, Events } from 'discord.js';
import { fillTemplate } from '../lib/text.js';
import { fetchChannel, safe } from '../util.js';

function register(client, ctx) {
  client.on(
    Events.GuildMemberAdd,
    safe('bienvenida', async (member) => {
      if (member.guild.id !== ctx.guildId || member.user.bot) return;

      const autoRole = ctx.settings.get('role_auto');
      if (autoRole) {
        await member.roles.add(autoRole).catch((err) => console.error('[bienvenida] No se pudo dar el rol automático:', err.message));
      }

      const channel = await fetchChannel(client, ctx.settings.get('channel_welcome'));
      if (!channel?.isTextBased()) return;
      const text = fillTemplate(ctx.settings.get('welcome_text'), {
        usuario: `${member}`,
        servidor: member.guild.name,
        miembros: member.guild.memberCount,
      });
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`¡Bienvenid@, ${member.displayName}!`)
        .setDescription(text)
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }));
      await channel.send({ content: `${member}`, embeds: [embed] });
    }),
  );
}

export default { id: 'welcome', name: 'Bienvenida', register };
