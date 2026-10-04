import { wallClock } from './lib/dates.js';

// Persona de guardia hoy (según la zona horaria configurada), o null si ese día no hay nadie asignado.
export function onDutyId(ctx, now = Date.now()) {
  const { weekday } = wallClock(now, ctx.settings.get('timezone'));
  return ctx.db.prepare('SELECT user_id FROM duty WHERE weekday = ?').get(weekday)?.user_id ?? null;
}

// Añade al mensaje la mención a la persona de guardia, si la hay.
export function withDuty(ctx, payload, now = Date.now()) {
  const userId = onDutyId(ctx, now);
  if (!userId) return payload;
  return {
    ...payload,
    content: `<@${userId}> ${payload.content ?? ''}`.trim(),
    allowedMentions: { ...payload.allowedMentions, users: [...(payload.allowedMentions?.users ?? []), userId] },
  };
}
