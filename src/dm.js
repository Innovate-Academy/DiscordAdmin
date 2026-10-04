// Los mensajes privados del bot sobre clases y progreso solo se envían a quien los ha pedido con /avisos.

export const optedIn = (db, userId) => Boolean(db.prepare('SELECT 1 FROM dm_optin WHERE user_id = ?').get(userId));

// Devuelve true si el mensaje se envió.
export async function dmIfOptedIn(ctx, userId, payload) {
  if (!optedIn(ctx.db, userId)) return false;
  const user = await ctx.client.users.fetch(userId).catch(() => null);
  if (!user) return false;
  // Puede fallar si la persona tiene cerrados los mensajes privados; no es un error.
  return user.send(payload).then(
    () => true,
    () => false,
  );
}
