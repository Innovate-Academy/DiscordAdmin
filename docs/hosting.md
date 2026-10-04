# Pasar el bot a un servidor 24/7

Hazlo cuando el bot ya funcione bien en tu PC. Nada de esta guía se ha probado en un servidor real: está preparada a partir de cómo funcionan estos paneles en general, así que algún nombre de botón puede variar.

## La regla más importante

**Nunca dos copias del bot encendidas a la vez con el mismo token.** Las dos responderían a todo: mensajes duplicados, XP doble, tickets repetidos. Antes de encender el bot en el servidor:

1. Cierra la ventana de `iniciar.bat` en tu PC.
2. Si creaste el acceso directo de arranque automático (`Win + R` > `shell:startup`), bórralo.

El bot impide que dos copias usen la misma carpeta de datos, pero no puede saber si hay otra copia encendida en otro ordenador.

## Opción A: panel de hosting con Pterodactyl

Muchos proveedores de hosting de bots usan el panel Pterodactyl, que es lo que describe esta opción. El bot usa poca memoria (calculo entre 100 y 250 MB con unos pocos miles de miembros; no está medido), así que el plan de bots más pequeño debería bastar.

### Qué pedir al contratar

- Servidor de tipo **Node.js**, con **Node 22 o 24**. Con una versión anterior a la 22.13 el bot no arranca.
- Que los archivos del servidor sean persistentes (lo normal en Pterodactyl): ahí vive la base de datos.

### Pasos

1. **Empaqueta el código.** En tu PC, doble clic en `empaquetar.bat`. Crea `bot.zip` con el código. No incluye el token ni la base de datos.
2. **Sube el código.** En el panel, entra en tu servidor > **Files** > **Upload** y sube `bot.zip`. Luego, en los tres puntos del archivo, **Unarchive**. Deben quedar en la raíz `index.js`, `package.json`, `package-lock.json` y la carpeta `src`.
3. **Crea el `.env`.** En **Files** > **New File**, con el nombre `.env` y este contenido (los mismos valores que en tu PC):

   ```
   DISCORD_TOKEN=tu_token
   GUILD_ID=id_de_tu_servidor
   ```

   Si el panel tiene una pestaña de variables de entorno, también puedes ponerlas ahí en lugar del archivo.
4. **Lleva tus datos (opcional, pero recomendado).** Para conservar niveles, matrículas, configuración y demás, crea en el panel la carpeta `data` y sube dentro el archivo `data/bot.db` de tu PC. Hazlo con el bot del PC ya cerrado. Si existen, sube también `bot.db-wal` y `bot.db-shm`. Si no subes nada, el bot empieza de cero y hay que repetir `/config`.
5. **Archivo de arranque.** En **Startup**, el archivo principal debe ser `index.js` (suele ser el valor por defecto).
6. **Enciende.** En **Console**, pulsa **Start**. La primera vez instala las dependencias y tarda un poco. Debe aparecer `Conectado como ...`.
7. **Comprueba.** En Discord, `/estado` muestra desde cuándo está encendido, y `/config revisar` debe seguir diciendo "Todo en orden".

Es normal ver en la consola una línea `ExperimentalWarning: SQLite is an experimental feature`: no es un error.

### Si no arranca

| Lo que ves en la consola | Qué hacer |
|---|---|
| `Faltan valores en el archivo .env` | El `.env` no está en la raíz o le falta una línea |
| `El DISCORD_TOKEN ... no es válido` | Copia el token de nuevo desde el Developer Portal |
| `Ya hay otra copia del bot en marcha` | El servidor tiene dos procesos; reinícialo desde el panel |
| `Cannot find module 'node:sqlite'` o un error de sintaxis al arrancar | La versión de Node es antigua: pide Node 22 o 24 |
| `Cannot find package 'discord.js'` | No se instalaron las dependencias: reinicia, o escribe a soporte para que el servidor ejecute `npm install` |

## Opción B: servidor propio (VPS) con Docker

Para quien tenga un VPS y sepa usar la terminal. En la carpeta del proyecto, con el `.env` creado:

```bash
docker compose up -d --build
```

```bash
docker compose logs -f
```

La base de datos queda en el volumen `bot-data`, que sobrevive a reinicios y actualizaciones. El contenedor se reinicia solo si se cae. Para llevar tus datos del PC, copia `data/bot.db` al volumen antes del primer arranque.

## Actualizar el bot más adelante

1. Para el bot (**Stop** en el panel).
2. Sube el nuevo `bot.zip` y descomprímelo encima: sustituye `src`, `index.js` y `package.json`.
3. No toques `.env` ni `data`.
4. **Start**. Si la nueva versión cambia la base de datos, el bot guarda antes una copia en `data/backups/antes-de-actualizar-*.db`.

## Copias de seguridad en el servidor

El bot sigue haciendo una copia diaria en `data/backups` y conservando 7. Están en el mismo servidor que la base de datos, así que no protegen si el servidor se pierde: descarga una de vez en cuando desde **Files**. Contienen los mensajes del servidor; no las compartas.

## Volver al PC

Para el bot en el servidor, descarga `data/bot.db` (y `bot.db-wal` si existe) a la carpeta `data` de tu PC, y arranca con `iniciar.bat`.
