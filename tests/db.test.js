import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createSettings, DEFAULTS } from '../src/settings.js';

test('db: crea todas las tablas y se puede abrir dos veces', () => {
  const db = openDb(':memory:');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const name of ['settings', 'levels', 'level_rewards', 'counters', 'events', 'event_signups', 'giveaways', 'giveaway_entries', 'weekly_reminders', 'tickets', 'tasks', 'messages', 'message_edits']) {
    assert.ok(tables.includes(name), name);
  }
});

test('settings: valores por defecto, guardar, sobrescribir y borrar', () => {
  const settings = createSettings(openDb(':memory:'));
  assert.equal(settings.get('channel_welcome'), null);
  assert.equal(settings.get('timezone'), DEFAULTS.timezone);
  assert.equal(settings.getNumber('reminder_every'), 100);
  assert.equal(settings.getNumber('channel_welcome'), null);

  settings.set('reminder_every', 50);
  settings.set('reminder_every', 25);
  assert.equal(settings.getNumber('reminder_every'), 25);

  settings.set('channel_welcome', '123456789012345678');
  assert.equal(settings.get('channel_welcome'), '123456789012345678');
  settings.unset('channel_welcome');
  assert.equal(settings.get('channel_welcome'), null);
});
