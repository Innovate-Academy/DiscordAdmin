// Sitios desde los que cualquier miembro puede compartir enlaces desde el primer día.
export const DEFAULT_ALLOWED_DOMAINS = [
  'github.com',
  'githubusercontent.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'meet.google.com',
  'stackoverflow.com',
  'developer.mozilla.org',
  'w3schools.com',
  'python.org',
  'replit.com',
  'codepen.io',
  'tenor.com',
  'giphy.com',
  'cdn.discordapp.com',
  'media.discordapp.net',
];

const OFFICIAL = [
  'discord.com',
  'discord.gg',
  'discordapp.com',
  'discordapp.net',
  'discord.gift',
  'discord.new',
  'discord.media',
  'discordstatus.com',
  'steamcommunity.com',
  'steampowered.com',
];
// Dominios que imitan a Discord o Steam (dlscord, disc0rd, steancommunity...) o prometen Nitro.
const LOOKALIKE = /d[i1l]s+c[o0]r[dcl]|nitro.*(gift|free|drop)|(gift|free|drop).*nitro|ste[a4e]?[mn]c[o0]mm?un[i1l]t/;
const BAIT =
  /(free|gratis|regal\w+|gift|giveaway|airdrop)[^\n]{0,40}(nitro|robux|v-?bucks)|(nitro|robux|v-?bucks)[^\n]{0,40}(free|gratis|regal\w+|gift|airdrop)/i;

// Solo cuenta como enlace lo que lleva http(s)://, www. o es una invitación de Discord:
// en un servidor de programación, "main.py" o "app.get" no son enlaces.
export function extractHosts(content) {
  const hosts = new Set();
  const pattern = /(?:https?:\/\/|www\.)([^\s/<>?#]+)|\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/gi;
  for (const match of content.matchAll(pattern)) {
    let host = (match[1] ?? 'discord.gg').toLowerCase();
    host = host.split('@').pop().split(':')[0].replace(/^www\./, '').replace(/[.,)\]]+$/, '');
    if (host.includes('.')) hosts.add(host);
  }
  return [...hosts];
}

export function isAllowed(host, domains) {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isLookalike(host) {
  return !isAllowed(host, OFFICIAL) && LOOKALIKE.test(host);
}

// "https://www.Ejemplo.com/ruta" -> "ejemplo.com"; null si no es un dominio.
export function normalizeDomain(input) {
  const domain = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#:]/)[0];
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain) ? domain : null;
}

// Decide si un mensaje infringe una regla. `scam` y `mentions` son graves; `link` es leve.
export function evaluateMessage(content, { isNewMember, allowedDomains, mentionCount = 0, maxMentions = 5 }) {
  const hosts = extractHosts(content);
  const lookalike = hosts.find(isLookalike);
  if (lookalike) return { rule: 'scam', detail: `Enlace que imita a un sitio oficial (${lookalike})` };

  const unlisted = hosts.filter((host) => !isAllowed(host, allowedDomains));
  if (unlisted.length && BAIT.test(content)) return { rule: 'scam', detail: 'Promesa de premios gratis con enlace' };
  if (unlisted.length && /@(everyone|here)/.test(content)) return { rule: 'scam', detail: 'Mención a todos con enlace' };
  if (mentionCount > maxMentions) return { rule: 'mentions', detail: `${mentionCount} menciones en un solo mensaje` };
  if (isNewMember && unlisted.length) return { rule: 'link', detail: unlisted[0] };
  return null;
}

// Detecta el mismo mensaje repetido en varios canales en poco tiempo.
export class DuplicateTracker {
  constructor({ windowMs = 30_000, channels = 3, minLength = 20, maxUsers = 5000 } = {}) {
    Object.assign(this, { windowMs, channels, minLength, maxUsers });
    this.byUser = new Map();
  }

  // Devuelve los mensajes repetidos ({ channelId, messageId }) si se alcanza el límite; si no, null.
  add(userId, { content, channelId, messageId, now }) {
    const key = content.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key.length < this.minLength) return null;
    if (this.byUser.size > this.maxUsers) this.byUser.clear();

    const recent = (this.byUser.get(userId) ?? []).filter((entry) => now - entry.now <= this.windowMs);
    recent.push({ key, channelId, messageId, now });
    this.byUser.set(userId, recent);

    const same = recent.filter((entry) => entry.key === key);
    if (new Set(same.map((entry) => entry.channelId)).size < this.channels) return null;
    this.byUser.delete(userId);
    return same.map((entry) => ({ channelId: entry.channelId, messageId: entry.messageId }));
  }
}

// Cuenta entradas recientes al servidor para detectar una oleada.
export class JoinWindow {
  joins = [];

  // true si, contando esta entrada, hay más de `limit` en los últimos `windowMs`.
  add(now, { limit, windowMs }) {
    this.joins = this.joins.filter((time) => now - time < windowMs);
    this.joins.push(now);
    return this.joins.length > limit;
  }
}
