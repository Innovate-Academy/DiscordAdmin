import { isEnabled } from './settings.js';
import { reportError } from './util.js';

// Llama periódicamente al `tick` de cada módulo activo (eventos, sorteos, avisos, tareas, limpieza).
export function startScheduler(modules, ctx, intervalMs = 30_000) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    for (const mod of modules) {
      if (!mod.tick || !isEnabled(ctx.settings, mod)) continue;
      try {
        await mod.tick(ctx, Date.now());
      } catch (err) {
        reportError(`planificador ${mod.id}`, err);
      }
    }
    running = false;
  };
  run();
  return setInterval(run, intervalMs);
}
