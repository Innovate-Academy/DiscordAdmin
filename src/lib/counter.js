// Cuenta un mensaje más y decide si toca enviar el recordatorio.
// Si se alcanza `every` pero aún no ha pasado `minGapMs`, el contador sigue
// subiendo y el recordatorio sale con el primer mensaje tras cumplirse el plazo.
export function nextCounter({ count, lastSentAt }, { every, minGapMs, now }) {
  const next = count + 1;
  const gapOk = lastSentAt == null || now - lastSentAt >= minGapMs;
  if (next >= every && gapOk) return { count: 0, lastSentAt: now, send: true };
  return { count: next, lastSentAt, send: false };
}
