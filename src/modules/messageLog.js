import { EmbedBuilder, Events, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { discordTime } from '../lib/dates.js';
import { escapeLike, truncate } from '../lib/text.js';
import { eph, requireAdmin, safe } from '../util.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

export function logMessage(db, message) {
  db.prepare(
    `INSERT OR IGNORE INTO messages (id, channel_id, author_id, author_name, content, attachments, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(message.id, message.channelId, message.authorId, message.authorName, message.content, message.attachments, message.createdAt);
}

// Guarda el texto anterior y actualiza el mensaje. Devuelve false si no estaba registrado o no cambió.
export function logEdit(db, id, content, now) {
  const row = db.prepare('SELECT content FROM messages WHERE id = ?').get(id);
  if (!row || row.content === content) return false;
  db.prepare('INSERT INTO message_edits (message_id, old_content, edited_at) VALUES (?, ?, ?)').run(id, row.content, now);
  db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, now, id);
  return true;
}

export function logDelete(db, id, now) {
  db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id);
}

export function searchMessages(db, { userId = null, channelId = null, text = null, limit = 20 } = {}) {
  const where = [];
  const params = [];
  if (userId) {
    where.push('author_id = ?');
    params.push(userId);
  }
  if (channelId) {
    where.push('channel_id = ?');
    params.push(channelId);
  }
  if (text) {
    where.push("content LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(text)}%`);
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM messages ${filter} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
}

export function purgeOlderThan(db, cutoff) {
  db.prepare('DELETE FROM message_edits WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)').run(cutoff);
  return Number(db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff).changes);
}

const toRecord = (message) => ({
  id: message.id,
  channelId: message.channelId,
  authorId: message.author.id,
  authorName: message.author.username,
  content: message.content ?? '',
  attachments: [...message.attachments.values()].map((attachment) => attachment.url).join(' '),
  createdAt: message.createdTimestamp,
});

const command = new SlashCommandBuilder()
  .setName('registro')
  .setDescription('Consulta el registro de mensajes')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('buscar')
      .setDescription('Últimos 20 mensajes que cumplen los filtros')
      .addUserOption((opt) => opt.setName('usuario').setDescription('Autor del mensaje'))
      .addChannelOption((opt) => opt.setName('canal').setDescription('Canal donde se escribió'))
      .addStringOption((opt) => opt.setName('texto').setDescription('Texto que contiene').setMaxLength(100)),
  )
  .addSubcommand((sub) => sub.setName('auditoria').setDescription('Últimas consultas hechas al registro: quién buscó qué y cuándo'));

function register(client, ctx) {
  const { db } = ctx;
  const inGuild = (message) => message.guildId === ctx.guildId;

  client.on(
    Events.MessageCreate,
    safe('registro', (message) => {
      if (inGuild(message) && !message.system) logMessage(db, toRecord(message));
    }),
  );

  client.on(
    Events.MessageUpdate,
    safe('registro', async (_old, updated) => {
      if (!inGuild(updated)) return;
      const message = updated.partial ? await updated.fetch().catch(() => null) : updated;
      if (!message?.author || message.system) return;
      const record = toRecord(message);
      // Si el mensaje es anterior al bot, se registra ahora con su texto actual.
      if (!logEdit(db, record.id, record.content, Date.now())) logMessage(db, record);
    }),
  );

  client.on(
    Events.MessageDelete,
    safe('registro', (message) => {
      if (inGuild(message)) logDelete(db, message.id, Date.now());
    }),
  );

  client.on(
    Events.MessageBulkDelete,
    safe('registro', (messages) => {
      const now = Date.now();
      for (const message of messages.values()) {
        if (inGuild(message)) logDelete(db, message.id, now);
      }
    }),
  );
}

function showAudit(interaction, ctx) {
  const rows = ctx.db.prepare('SELECT * FROM log_searches ORDER BY id DESC LIMIT 20').all();
  if (!rows.length) return interaction.reply(eph('Nadie ha consultado el registro todavía.'));
  const lines = rows.map((row) => {
    const filters = [row.user_id && `de <@${row.user_id}>`, row.channel_id && `en <#${row.channel_id}>`, row.text && `con "${truncate(row.text, 40)}"`];
    return `${discordTime(row.created_at, 'f')} <@${row.admin_id}> buscó mensajes ${filters.filter(Boolean).join(' ') || 'sin filtros'}`;
  });
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Consultas al registro').setDescription(lines.join('\n').slice(0, 4000));
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function onCommand(interaction, ctx) {
  requireAdmin(interaction);
  if (interaction.options.getSubcommand() === 'auditoria') return showAudit(interaction, ctx);

  const filters = {
    userId: interaction.options.getUser('usuario')?.id ?? null,
    channelId: interaction.options.getChannel('canal')?.id ?? null,
    text: interaction.options.getString('texto'),
  };
  // Cada consulta queda anotada: quién buscó qué y cuándo.
  ctx.db
    .prepare('INSERT INTO log_searches (admin_id, user_id, channel_id, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(interaction.user.id, filters.userId, filters.channelId, filters.text, Date.now());
  const rows = searchMessages(ctx.db, filters);
  if (!rows.length) return interaction.reply(eph('No hay mensajes registrados con esos filtros.'));

  let description = '';
  for (const row of rows) {
    const marks = `${row.edited_at ? ' *(editado)*' : ''}${row.deleted_at ? ' *(borrado)*' : ''}`;
    const body = truncate(row.content || row.attachments || '(sin texto)', 150);
    const line = `${discordTime(row.created_at, 'f')} <#${row.channel_id}> <@${row.author_id}>${marks}: ${body}\n`;
    if (description.length + line.length > 4000) break;
    description += line;
  }
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Registro de mensajes').setDescription(description);
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

let lastPurge = 0;
function tick(ctx, now) {
  if (now - lastPurge < HOUR) return;
  lastPurge = now;
  const days = ctx.settings.getNumber('retention_days');
  if (days > 0) purgeOlderThan(ctx.db, now - days * DAY);
}

export default { id: 'messageLog', name: 'Registro de mensajes', commands: [command], register, onCommand, tick };
