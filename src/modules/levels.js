import { EmbedBuilder, Events, SlashCommandBuilder } from 'discord.js';
import { canEarnXp, levelFromXp, randomXp } from '../lib/xp.js';
import { eph, fetchChannel, isMemberMessage, safe } from '../util.js';

// Suma la XP de un mensaje. Devuelve null si aún no ha pasado la espera.
export function awardXp(db, userId, now, rng = Math.random) {
  const row = db.prepare('SELECT xp, level, last_xp_at FROM levels WHERE user_id = ?').get(userId);
  if (row && !canEarnXp(row.last_xp_at, now)) return null;
  const xp = (row?.xp ?? 0) + randomXp(rng);
  const { level } = levelFromXp(xp);
  db.prepare(
    `INSERT INTO levels (user_id, xp, level, last_xp_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET xp = excluded.xp, level = excluded.level, last_xp_at = excluded.last_xp_at`,
  ).run(userId, xp, level, now);
  return { xp, level, leveledUp: level > (row?.level ?? 0) };
}

// XP de premio (retos, referidos, proyectos). No toca el nivel guardado: así el siguiente mensaje
// de la persona detecta la subida, la anuncia y da los roles de recompensa.
export function grantXp(db, userId, amount) {
  db.prepare('INSERT INTO levels (user_id, xp) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET xp = xp + excluded.xp').run(userId, amount);
}

const commands = [
  new SlashCommandBuilder()
    .setName('nivel')
    .setDescription('Muestra tu nivel o el de otra persona')
    .addUserOption((opt) => opt.setName('usuario').setDescription('Persona a consultar')),
  new SlashCommandBuilder().setName('top').setDescription('Clasificación de niveles del servidor'),
];

function register(client, ctx) {
  client.on(
    Events.MessageCreate,
    safe('niveles', async (message) => {
      if (!isMemberMessage(message, ctx)) return;
      const result = awardXp(ctx.db, message.author.id, Date.now());
      if (!result?.leveledUp) return;

      const rewards = ctx.db.prepare('SELECT role_id FROM level_rewards WHERE level <= ?').all(result.level);
      if (rewards.length) {
        const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
        for (const { role_id } of rewards) {
          if (member && !member.roles.cache.has(role_id)) {
            await member.roles.add(role_id).catch((err) => console.error('[niveles] No se pudo dar el rol de recompensa:', err.message));
          }
        }
      }

      const channel = (await fetchChannel(client, ctx.settings.get('channel_levels'))) ?? message.channel;
      await channel.send(`🎉 ${message.author} ha subido al **nivel ${result.level}**.`);
    }),
  );
}

async function onCommand(interaction, ctx) {
  const { db } = ctx;
  if (interaction.commandName === 'nivel') {
    const user = interaction.options.getUser('usuario') ?? interaction.user;
    const row = db.prepare('SELECT xp FROM levels WHERE user_id = ?').get(user.id);
    if (!row) return interaction.reply(eph(`${user} todavía no tiene experiencia.`));
    const { level, progress, needed } = levelFromXp(row.xp);
    const { rank } = db.prepare('SELECT COUNT(*) + 1 AS rank FROM levels WHERE xp > ?').get(row.xp);
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: user.displayName, iconURL: user.displayAvatarURL() })
      .addFields(
        { name: 'Nivel', value: String(level), inline: true },
        { name: 'Puesto', value: `#${rank}`, inline: true },
        { name: 'Progreso', value: `${progress} / ${needed} XP`, inline: true },
      );
    const streak = db.prepare('SELECT streak FROM challenge_streaks WHERE user_id = ?').get(user.id)?.streak;
    if (streak) embed.addFields({ name: 'Racha de retos', value: `🔥 ${streak}`, inline: true });
    return interaction.reply({ embeds: [embed] });
  }

  const rows = db.prepare('SELECT user_id, xp, level FROM levels ORDER BY xp DESC LIMIT 10').all();
  if (!rows.length) return interaction.reply(eph('Todavía no hay nadie en la clasificación.'));
  const lines = rows.map((row, i) => `**${i + 1}.** <@${row.user_id}> · nivel ${levelFromXp(row.xp).level} · ${row.xp} XP`);
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🏆 Clasificación').setDescription(lines.join('\n'));
  return interaction.reply({ embeds: [embed] });
}

export default { id: 'levels', name: 'Niveles y experiencia', commands, register, onCommand };
