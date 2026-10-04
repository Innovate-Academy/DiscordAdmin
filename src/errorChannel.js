import { ROOT } from './env.js';
import { truncate } from './lib/text.js';
import { fetchChannel } from './util.js';

// Publica los errores inesperados en el canal de logs, como mucho uno por minuto,
// para que el staff se entere aunque nadie esté mirando la consola.
export function createErrorSink(ctx, { minGapMs = 60_000, now = Date.now } = {}) {
  let lastSent = -Infinity;
  let skipped = 0;

  return async function sink(label, err) {
    const time = now();
    if (time - lastSent < minGapMs) {
      skipped++;
      return;
    }
    lastSent = time;
    const channel = await fetchChannel(ctx.client, ctx.settings.get('channel_logs'));
    if (!channel?.isTextBased()) return;

    // Las rutas del ordenador donde corre el bot no se publican.
    const detail = truncate(String(err?.stack ?? err).replaceAll(ROOT, '.'), 1500);
    const more = skipped ? ` (y ${skipped} más desde el último aviso)` : '';
    skipped = 0;
    await channel
      .send({ content: `⚠️ Error en **${label}**${more}\n\`\`\`\n${detail}\n\`\`\``, allowedMentions: { parse: [] } })
      .catch(() => {});
  };
}
