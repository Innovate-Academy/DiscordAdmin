# Extensiones

Una extensión añade al bot funciones propias de una comunidad concreta (por ejemplo, las de una academia) sin modificar ningún archivo del núcleo. Así el núcleo se puede actualizar sin conflictos.

## Cómo se carga

Al arrancar, `src/modules/index.js` busca carpetas dentro de `src/extensions/`. Cada carpeta con un `index.js` es una extensión. Ese archivo:

1. Registra lo que necesite en `src/registry.js`.
2. Exporta `{ id, modules }`, donde `modules` es una lista de módulos con la misma forma que los del núcleo.

```js
// src/extensions/mi-comunidad/index.js
import { registerConfig, registerMigrations } from '../../registry.js';
import saludos from './saludos.js';

registerMigrations('mi-comunidad', ['CREATE TABLE saludos (user_id TEXT PRIMARY KEY, veces INTEGER NOT NULL DEFAULT 0)']);
registerConfig({ channels: { saludos: { key: 'channel_greetings', label: 'Canal de saludos' } } });

export default { id: 'mi-comunidad', modules: [saludos] };
```

## Forma de un módulo

```js
export default {
  id: 'saludos',            // único; también es el prefijo de los customId de sus botones
  name: 'Saludos',          // lo que se ve en /config modulos
  commands: [/* SlashCommandBuilder */],
  register(client, ctx) {}, // listeners de eventos de Discord
  async onCommand(interaction, ctx) {},
  async onComponent(interaction, ctx, action, arg) {}, // botones, menús y formularios "saludos:accion:argumento"
  async tick(ctx, now) {},  // cada 30 segundos, para trabajo programado
};
```

`ctx` lleva `db` (SQLite), `settings` (configuración), `client` y `guildId`. Para un error que deba ver quien usó el comando, lanza `UserError` (de `src/util.js`).

## Puntos de extensión

| En `src/registry.js` | Para qué |
|---|---|
| `registerMigrations(nombre, pasos)` | Tablas propias. Cada paso es SQL; se aplican en orden, una sola vez, con copia previa. Un paso publicado nunca se edita: los cambios van en pasos nuevos |
| `registerConfig({ channels, roles, texts })` | Opciones nuevas en `/config canal`, `/config rol` y `/config texto` |
| `registerTicketKind(id, definición)` | Un tipo de ticket nuevo, con su formulario y el rol que lo atiende |
| `registry.defaults` | Valores por defecto de la configuración (tienen prioridad sobre los del núcleo) |
| `registry.allowedDomains` | Sitios de los que cualquiera puede compartir enlaces desde el primer día |
| `registry.verifiedPrompts` | Algo que añadir a la respuesta cuando alguien se verifica |
| `registry.statsFields` | Campos extra en `/stats` |
| `registry.workloadSources` | Fuentes extra de trabajo en `/carga` |
| `registry.privacyLines` | Líneas extra en `/mis-datos` |
| `registry.managedRoles` | Roles que el bot asigna y cuya posición debe vigilar `/config revisar` |

Las extensiones también pueden usar funciones del núcleo, como `publishEvent` (de `src/modules/events.js`) para crear eventos, `grantXp` (de `src/modules/levels.js`) para dar experiencia o `dmIfOptedIn` (de `src/dm.js`) para escribir por privado solo a quien lo ha pedido.

## Pruebas

Las pruebas de una extensión van en su propia carpeta dentro de `tests/` e importan primero su `index.js`, para que sus tablas y opciones estén registradas:

```js
import '../../src/extensions/mi-comunidad/index.js';
```

Las pruebas del núcleo no importan ninguna extensión, así que siguen pasando con o sin ellas.
