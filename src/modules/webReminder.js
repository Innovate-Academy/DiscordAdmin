import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events } from 'discord.js';
import { nextCounter } from '../lib/counter.js';
import { isMemberMessage, safe } from '../util.js';

function register(client, ctx) {
  const { db, settings } = ctx;
  client.on(
    Events.MessageCreate,
    safe('recordatorio web', async (message) => {
      if (!isMemberMessage(message, ctx)) return;
      if (message.channelId !== settings.get('channel_general')) return;
      const url = settings.get('web_url');
      if (!url) return;

      const row = db.prepare('SELECT count, last_sent_at FROM counters WHERE channel_id = ?').get(message.channelId);
      const next = nextCounter(
        { count: row?.count ?? 0, lastSentAt: row?.last_sent_at ?? null },
        {
          every: settings.getNumber('reminder_every'),
          minGapMs: settings.getNumber('reminder_min_minutes') * 60_000,
          now: Date.now(),
        },
      );
      db.prepare(
        `INSERT INTO counters (channel_id, count, last_sent_at) VALUES (?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET count = excluded.count, last_sent_at = excluded.last_sent_at`,
      ).run(message.channelId, next.count, next.lastSentAt);
      if (!next.send) return;

      const embed = new EmbedBuilder().setColor(0x57f287).setTitle(settings.get('reminder_title')).setDescription(settings.get('reminder_text'));
      const button = new ButtonBuilder().setLabel('Ir a la web').setStyle(ButtonStyle.Link).setURL(url);
      await message.channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] });
    }),
  );
}

export default { id: 'webReminder', name: 'Recordatorio periódico', register };
