import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backupDatabase } from '../db.js';
import { wallClock } from '../lib/dates.js';

const KEEP = 7;
const DAILY = /^bot-\d{4}-\d{2}-\d{2}\.db$/;

// Conserva solo las `keep` copias diarias más recientes.
export function pruneBackups(dir, keep = KEEP) {
  const files = readdirSync(dir).filter((name) => DAILY.test(name)).sort();
  for (const name of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, name));
}

// Una copia al día de la base de datos en data/backups.
function tick(ctx, now) {
  if (!ctx.dataDir) return;
  const { year, month, day } = wallClock(now, ctx.settings.get('timezone'));
  const today = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (ctx.settings.get('last_backup') === today) return;

  const dir = join(ctx.dataDir, 'backups');
  backupDatabase(ctx.db, dir, `bot-${today}.db`);
  pruneBackups(dir);
  ctx.settings.set('last_backup', today);
}

export default { id: 'backup', name: 'Copias de seguridad', required: true, tick };
