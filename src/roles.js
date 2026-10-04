// Roles que el bot crea por su cuenta la primera vez que hacen falta (intereses, embajador).
// Su id se guarda en la configuración; si alguien borra el rol, se vuelve a crear.
export async function ensureRole(guild, settings, key, name) {
  const existing = settings.get(key);
  if (existing && guild.roles.cache.has(existing)) return existing;
  const role = await guild.roles.create({ name, reason: 'Rol creado por el bot' });
  settings.set(key, role.id);
  return role.id;
}
