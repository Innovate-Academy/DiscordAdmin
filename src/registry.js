// Puntos de extensión del bot. Los módulos del núcleo se apuntan aquí al cargarse, y una extensión
// (una carpeta en src/extensions) añade lo suyo sin tocar los archivos del núcleo.
export const registry = {
  // Tipos de ticket: id -> definición (ver modules/tickets.js).
  ticketKinds: new Map(),
  // Opciones de /config canal, /config rol y /config texto: id -> { key, label, category? }.
  channels: new Map(),
  roles: new Map(),
  texts: new Map(),
  // Valores por defecto de la configuración; tienen prioridad sobre los del núcleo.
  defaults: {},
  // Sitios de los que cualquier miembro puede compartir enlaces desde el primer día.
  allowedDomains: [],
  // Cambios de base de datos por espacio de nombres: nombre -> lista ordenada de pasos SQL.
  migrations: new Map(),
  // Al verificarse alguien: funciones que devuelven { content, components } para añadir a la respuesta.
  verifiedPrompts: [],
  // Campos extra de /stats: (db, since, now) => { name, value, inline? }.
  statsFields: [],
  // Fuentes extra de /carga: { key, label, sql, params: (since, botId) => [...] }; el SQL devuelve user_id y total.
  workloadSources: [],
  // Líneas extra de /mis-datos: (db, userId) => texto.
  privacyLines: [],
  // Roles que el bot asigna y cuya posición revisa /config revisar: [clave de configuración, etiqueta].
  managedRoles: [],
};

export function registerConfig({ channels = {}, roles = {}, texts = {} }) {
  for (const [id, entry] of Object.entries(channels)) registry.channels.set(id, entry);
  for (const [id, entry] of Object.entries(roles)) registry.roles.set(id, entry);
  for (const [id, entry] of Object.entries(texts)) registry.texts.set(id, entry);
}

export function registerMigrations(namespace, steps) {
  registry.migrations.set(namespace, steps);
}

export function registerTicketKind(id, definition) {
  registry.ticketKinds.set(id, definition);
}
