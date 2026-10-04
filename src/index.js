import { join } from 'node:path';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { ROOT, loadEnv } from './env.js';
import modules from './modules/index.js';
import { openDb } from './db.js';
import { createSettings, isEnabled } from './settings.js';
import { createRouter } from './router.js';
import { startScheduler } from './scheduler.js';
import { checkSetup } from './setupCheck.js';
import { createErrorSink } from './errorChannel.js';
import { fetchChannel, reportError, setErrorSink } from './util.js';

// Código de salida 2 = problema de configuración: iniciar.bat no reintenta. 1 = caída: sí reintenta.
const CONFIG_ERROR = 2;

const env = loadEnv();
// En un servidor, DATA_DIR permite guardar la base de datos en un disco persistente.
const dataDir = process.env.DATA_DIR || join(ROOT, 'data');
const dbPath = join(dataDir, 'bot.db');
let db;
try {
  db = openDb(dbPath);
} catch (err) {
  if (!/locked|busy/i.test(String(err.message))) throw err;
  console.error('Ya hay otra copia del bot en marcha usando esta carpeta de datos. Ciérrala antes de arrancar otra.');
  process.exit(CONFIG_ERROR);
}
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildScheduledEvents,
  ],
  // Para recibir ediciones y borrados de mensajes anteriores al arranque, y las salidas de miembros no cargados.
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});
const settings = createSettings(db);
const ctx = { db, settings, client, guildId: env.guildId, dataDir, dbPath, modules };

// Cada módulo recibe un cliente cuyos listeners solo se ejecutan mientras el módulo esté activo,
// así /config modulo surte efecto sin reiniciar el bot.
function clientFor(mod) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'on' || prop === 'once') {
        return (event, listener) => target[prop](event, (...args) => (isEnabled(settings, mod) ? listener(...args) : undefined));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

for (const mod of modules) mod.register?.(clientFor(mod), ctx);
client.on(Events.InteractionCreate, createRouter(modules, ctx));

let scheduler = null;

// Cierra ordenadamente en vez de usar process.exit, que en Windows puede abortar con un error de libuv.
async function shutdown() {
  clearInterval(scheduler);
  await client.destroy();
  db.close();
}

async function stop(message, code = 1) {
  console.error(message);
  process.exitCode = code;
  await shutdown();
}

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(env.guildId).catch(() => null);
    if (!guild) return await stop('El bot no está en el servidor indicado en GUILD_ID. Invítalo primero (ver README.md).', CONFIG_ERROR);
    // Solo se registran los comandos de los módulos activos; /config modulo vuelve a llamar a esto.
    ctx.refreshCommands = () =>
      guild.commands.set(modules.filter((mod) => isEnabled(settings, mod)).flatMap((mod) => mod.commands ?? []).map((command) => command.toJSON()));
    await ctx.refreshCommands();
    setErrorSink(createErrorSink(ctx));
    scheduler = startScheduler(modules, ctx);
    console.log(`Conectado como ${client.user.tag} en "${guild.name}". Comandos registrados.`);
    for (const problem of checkSetup(guild, ctx)) console.warn(`Aviso: ${problem}`);
    const logs = await fetchChannel(client, settings.get('channel_logs'));
    await logs?.send('✅ Bot iniciado.').catch(() => {});
  } catch (err) {
    console.error(err);
    await stop('No se pudieron registrar los comandos. Comprueba que invitaste al bot con el scope "applications.commands".', CONFIG_ERROR);
  }
});

// Un fallo aislado se registra y el bot sigue en marcha.
client.on(Events.Error, (err) => reportError('discord', err));
process.on('unhandledRejection', (err) => reportError('error no capturado', err));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(env.token).catch((err) => {
  if (String(err.message).toLowerCase().includes('disallowed intents')) {
    return stop('Activa "Server Members Intent" y "Message Content Intent" en el Developer Portal > Bot.', CONFIG_ERROR);
  }
  if (err.code === 'TokenInvalid') return stop('El DISCORD_TOKEN del archivo .env no es válido.', CONFIG_ERROR);
  return stop(err);
});
