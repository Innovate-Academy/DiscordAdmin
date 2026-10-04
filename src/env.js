import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Carpeta del proyecto, para que el bot funcione igual se lance desde donde se lance.
export const ROOT = join(import.meta.dirname, '..');

export function loadEnv() {
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const missing = ['DISCORD_TOKEN', 'GUILD_ID'].filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`Faltan valores en el archivo .env: ${missing.join(', ')}.`);
    console.error('Copia .env.example como .env y rellénalo (ver README.md).');
    // 2 = problema de configuración: iniciar.bat no reintenta.
    process.exit(2);
  }
  return { token: process.env.DISCORD_TOKEN, guildId: process.env.GUILD_ID };
}
