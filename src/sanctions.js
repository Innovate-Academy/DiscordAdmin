import { EmbedBuilder } from 'discord.js';
import { withDuty } from './duty.js';
import { formatDuration } from './lib/dates.js';
import { fetchChannel } from './util.js';

export const SANCTION_LABELS = {
  warn: 'Advertencia',
  timeout: 'Silencio',
  untimeout: 'Fin del silencio',
  kick: 'Expulsión',
  ban: 'Baneo',
};
const COLORS = { warn: 0xfee75c, timeout: 0xe67e22, untimeout: 0x57f287, kick: 0xed4245, ban: 0x992d22 };

export function addSanction(db, { userId, moderatorId, type, reason, durationMs = null, now = Date.now() }) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO sanctions (user_id, moderator_id, type, reason, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, moderatorId, type, reason, durationMs, now);
  return Number(lastInsertRowid);
}

export function getHistory(db, userId, limit = 15) {
  return db.prepare('SELECT * FROM sanctions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(userId, limit);
}

export function countWarnings(db, userId, since) {
  return db.prepare("SELECT COUNT(*) AS total FROM sanctions WHERE user_id = ? AND type = 'warn' AND created_at >= ?").get(userId, since).total;
}

// Publica en el canal de moderación. Si no está configurado, no hace nada.
// Con `notifyDuty`, menciona además a la persona de guardia ese día.
export async function sendModLog(ctx, payload, { notifyDuty = false } = {}) {
  const channel = await fetchChannel(ctx.client, ctx.settings.get('channel_mod'));
  if (!channel?.isTextBased()) return null;
  return channel.send(notifyDuty ? withDuty(ctx, payload) : payload).catch((err) => {
    console.error('[moderación] No se pudo escribir en el canal de moderación:', err.message);
    return null;
  });
}

export function sanctionEmbed({ type, userId, moderatorId, reason, durationMs = null }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS[type])
    .setTitle(SANCTION_LABELS[type])
    .addFields({ name: 'Miembro', value: `<@${userId}>`, inline: true }, { name: 'Staff', value: `<@${moderatorId}>`, inline: true });
  if (durationMs) embed.addFields({ name: 'Duración', value: formatDuration(durationMs), inline: true });
  return embed.addFields({ name: 'Motivo', value: reason });
}

// Guarda la sanción en el historial y la publica en el canal de moderación.
export async function recordSanction(ctx, sanction) {
  const id = addSanction(ctx.db, sanction);
  await sendModLog(ctx, { embeds: [sanctionEmbed(sanction)], allowedMentions: { parse: [] } });
  return id;
}
