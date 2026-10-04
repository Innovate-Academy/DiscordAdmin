import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from './env.js';
import { registerMigrations, registry } from './registry.js';

// Esquema base del núcleo. Los cambios posteriores no se hacen aquí, sino añadiendo pasos a las migraciones.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_versions (
  namespace TEXT PRIMARY KEY,
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS levels (
  user_id TEXT PRIMARY KEY,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  last_xp_at INTEGER
);

CREATE TABLE IF NOT EXISTS level_rewards (
  level INTEGER PRIMARY KEY,
  role_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  channel_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT,
  link TEXT,
  starts_at INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  discord_event_id TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_signups (
  event_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prize TEXT NOT NULL,
  winners INTEGER NOT NULL DEFAULT 1,
  ends_at INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  ended INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (giveaway_id, user_id)
);

CREATE TABLE IF NOT EXISTS weekly_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  weekday INTEGER NOT NULL,
  time TEXT NOT NULL,
  lead_minutes INTEGER NOT NULL DEFAULT 10,
  channel_id TEXT NOT NULL,
  role_id TEXT,
  link TEXT,
  last_sent INTEGER
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'bug',
  channel_id TEXT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  steps TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  claimed_by TEXT,
  created_at INTEGER NOT NULL,
  first_response_at INTEGER,
  sla_stage INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER,
  closed_by TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  role_id TEXT,
  user_id TEXT,
  due_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  overdue_notified INTEGER NOT NULL DEFAULT 0,
  channel_id TEXT,
  message_id TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT,
  content TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS messages_author ON messages (author_id, created_at);

CREATE TABLE IF NOT EXISTS message_edits (
  message_id TEXT NOT NULL,
  old_content TEXT NOT NULL,
  edited_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS message_edits_message ON message_edits (message_id);

CREATE TABLE IF NOT EXISTS log_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  user_id TEXT,
  channel_id TEXT,
  text TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sanctions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sanctions_user ON sanctions (user_id, created_at);

CREATE TABLE IF NOT EXISTS allowed_domains (
  domain TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS verification_pending (
  user_id TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dm_optin (
  user_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS member_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS member_events_at ON member_events (type, at);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  url TEXT NOT NULL,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  message_id TEXT,
  reviewed_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_invites (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referrals (
  invited_id TEXT PRIMARY KEY,
  inviter_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  qualified_at INTEGER,
  checked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  topic TEXT,
  xp INTEGER NOT NULL DEFAULT 100,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  ends_at INTEGER NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS challenge_entries (
  challenge_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (challenge_id, user_id)
);

CREATE TABLE IF NOT EXISTS challenge_streaks (
  user_id TEXT PRIMARY KEY,
  streak INTEGER NOT NULL,
  last_challenge_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS duty (
  weekday INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  position TEXT NOT NULL,
  experience TEXT NOT NULL,
  availability TEXT NOT NULL,
  motivation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  channel_id TEXT,
  message_id TEXT,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE IF NOT EXISTS application_votes (
  application_id INTEGER NOT NULL,
  voter_id TEXT NOT NULL,
  vote TEXT NOT NULL,
  PRIMARY KEY (application_id, voter_id)
);
`;

// Cambios del núcleo sobre el esquema base, en orden. Un paso publicado nunca se edita ni se borra:
// los cambios nuevos se añaden al final. Las extensiones registran los suyos con otro nombre.
registerMigrations('core', []);

// Copia completa y coherente de la base de datos, aunque el bot esté en marcha.
export function backupDatabase(db, dir, name) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  return file;
}

function migrate(db, backupDir) {
  const versionOf = db.prepare('SELECT version FROM schema_versions WHERE namespace = ?');
  const pending = [];
  for (const [namespace, steps] of registry.migrations) {
    const current = versionOf.get(namespace)?.version ?? 0;
    for (let version = current; version < steps.length; version++) pending.push({ namespace, version: version + 1, sql: steps[version] });
  }
  if (!pending.length) return;

  // Antes de cambiar una base de datos con datos, se guarda una copia.
  if (backupDir) backupDatabase(db, backupDir, `antes-de-actualizar-${pending[0].namespace}-v${pending[0].version - 1}.db`);
  const setVersion = db.prepare(
    'INSERT INTO schema_versions (namespace, version) VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET version = excluded.version',
  );
  for (const { namespace, version, sql } of pending) {
    db.exec('BEGIN');
    try {
      db.exec(sql);
      setVersion.run(namespace, version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function openDb(path = join(ROOT, 'data', 'bot.db')) {
  const inMemory = path === ':memory:';
  const existed = !inMemory && existsSync(path);
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    // El bloqueo exclusivo impide que dos copias del bot usen a la vez la misma base de datos:
    // la segunda falla al abrirla con "database is locked".
    if (!inMemory) db.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);
    migrate(db, existed ? join(dirname(path), 'backups') : null);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
