import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import applications from './applications.js';
import automod from './automod.js';
import backup from './backup.js';
import challenges from './challenges.js';
import config from './config.js';
import events from './events.js';
import giveaways from './giveaways.js';
import levels from './levels.js';
import messageLog from './messageLog.js';
import moderation from './moderation.js';
import notifications from './notifications.js';
import privacy from './privacy.js';
import referrals from './referrals.js';
import showcase from './showcase.js';
import staffing from './staffing.js';
import stats from './stats.js';
import status from './status.js';
import tasks from './tasks.js';
import tickets from './tickets.js';
import verification from './verification.js';
import webReminder from './webReminder.js';
import weekly from './weekly.js';
import welcome from './welcome.js';

// Módulos del núcleo. Cada uno exporta { id, name, commands?, register?, onCommand?, onComponent?, tick? }.
const core = [
  config,
  welcome,
  verification,
  automod,
  moderation,
  messageLog,
  privacy,
  levels,
  notifications,
  webReminder,
  events,
  giveaways,
  weekly,
  tasks,
  tickets,
  stats,
  referrals,
  challenges,
  showcase,
  applications,
  staffing,
  backup,
  status,
];

// Extensiones: cada carpeta de src/extensions con un index.js que exporta { id, modules }.
// Al cargarse registran lo que necesiten en src/registry.js (tipos de ticket, opciones de /config, tablas...).
const extensionsDir = join(import.meta.dirname, '..', 'extensions');
const extensions = [];
if (existsSync(extensionsDir)) {
  for (const name of readdirSync(extensionsDir).sort()) {
    const entry = join(extensionsDir, name, 'index.js');
    if (existsSync(entry)) extensions.push((await import(pathToFileURL(entry).href)).default);
  }
}

export default [...core, ...extensions.flatMap((extension) => extension.modules)];
