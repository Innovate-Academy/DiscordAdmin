import { SlashCommandBuilder } from 'discord.js';
import { optedIn } from '../dm.js';
import { eph } from '../util.js';

const command = new SlashCommandBuilder()
  .setName('avisos')
  .setDescription('Avisos del bot por mensaje privado')
  .addSubcommand((sub) => sub.setName('activar').setDescription('Recibir por privado los avisos que te afectan (eventos a los que te apuntas, novedades tuyas)'))
  .addSubcommand((sub) => sub.setName('desactivar').setDescription('Dejar de recibir privados del bot'));

// El bot solo escribe por privado a quien lo ha pedido aquí (ver dm.js).
async function onCommand(interaction, ctx) {
  const { db } = ctx;
  const userId = interaction.user.id;
  if (interaction.options.getSubcommand() === 'desactivar') {
    db.prepare('DELETE FROM dm_optin WHERE user_id = ?').run(userId);
    return interaction.reply(eph('Hecho: ya no recibirás mensajes privados del bot.'));
  }
  if (!optedIn(db, userId)) db.prepare('INSERT INTO dm_optin (user_id, created_at) VALUES (?, ?)').run(userId, Date.now());
  // Se prueba ahora, para avisar si Discord no deja escribirle por privado.
  const delivered = await interaction.user.send('🔔 Avisos activados. Te escribiré por aquí cuando haya algo que te afecte.').then(
    () => true,
    () => false,
  );
  return interaction.reply(
    eph(delivered ? 'Avisos activados. Te acabo de enviar un privado de prueba.' : 'Avisos activados, pero no puedo escribirte por privado: en los ajustes de privacidad del servidor, permite los mensajes directos.'),
  );
}

export default { id: 'notifications', name: 'Avisos por privado', commands: [command], onCommand };
