import { registry } from './registry.js';

export const DEFAULTS = {
  timezone: 'Europe/Madrid',
  welcome_text: '¡Hola {usuario}! Te damos la bienvenida a **{servidor}**. Ya somos {miembros} miembros.',
  reminder_title: '📌 Recordatorio',
  reminder_text: 'Pásate por nuestra web para estar al día.',
  reminder_every: '100',
  reminder_min_minutes: '30',
  retention_days: '30',
  automod_enabled: '1',
  automod_link_days: '7',
  verify_min_account_days: '7',
  raid_joins: '10',
  raid_seconds: '60',
  raid_mode: '0',
  modules_disabled: '',
};

export function createSettings(db) {
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setStmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const delStmt = db.prepare('DELETE FROM settings WHERE key = ?');

  return {
    // Lo guardado manda; si no hay nada, el valor por defecto de una extensión y, después, el del núcleo.
    get(key) {
      return getStmt.get(key)?.value ?? registry.defaults[key] ?? DEFAULTS[key] ?? null;
    },
    getNumber(key) {
      const value = this.get(key);
      if (value === null) return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    },
    set(key, value) {
      setStmt.run(key, String(value));
    },
    unset(key) {
      delStmt.run(key);
    },
  };
}

// Módulos que el servidor ha desactivado con /config modulo. Los marcados como `required` no se pueden desactivar.
export function isEnabled(settings, mod) {
  return Boolean(mod.required) || !settings.get('modules_disabled').split(',').includes(mod.id);
}
