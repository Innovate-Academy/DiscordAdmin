import { isEnabled } from './settings.js';
import { UserError, eph, reportError } from './util.js';

// Reparte cada interacción al módulo que la maneja:
// los comandos por nombre, y los botones, menús y formularios por el prefijo de su customId.
export function createRouter(modules, ctx) {
  const byCommand = new Map();
  const byId = new Map();
  for (const mod of modules) {
    byId.set(mod.id, mod);
    for (const command of mod.commands ?? []) byCommand.set(command.name, mod);
  }
  const enabled = (mod) => {
    if (mod && !isEnabled(ctx.settings, mod)) throw new UserError('Esta función está desactivada en este servidor.');
    return mod;
  };

  return async function route(interaction) {
    if (interaction.guildId !== ctx.guildId) return;
    try {
      if (interaction.isChatInputCommand()) {
        await enabled(byCommand.get(interaction.commandName))?.onCommand(interaction, ctx);
      } else if (interaction.isButton() || interaction.isModalSubmit() || interaction.isAnySelectMenu()) {
        const [id, action, arg] = interaction.customId.split(':');
        await enabled(byId.get(id))?.onComponent?.(interaction, ctx, action, arg);
      }
    } catch (err) {
      const known = err instanceof UserError;
      if (!known) reportError('interacción', err);
      if (!interaction.isRepliable()) return;
      const reply = eph(known ? err.message : 'Ha ocurrido un error inesperado. El staff ya ha sido avisado.');
      const send = interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply);
      await send.catch(() => {});
    }
  };
}
