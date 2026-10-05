# Bot administrador de Discord

Bot propio, en español, para administrar un servidor de Discord: seguridad, moderación, niveles, eventos, tickets, herramientas para el staff y registro de mensajes. Funciona en un solo servidor, guarda todo en un archivo SQLite y no depende de ningún servicio externo.

Cada servidor activa solo los módulos que quiere (`/config modulos`), y las funciones propias de una comunidad concreta se añaden como extensiones sin tocar el núcleo ([docs/extensiones.md](docs/extensiones.md)).

Este proyecto incluye la extensión de Innovate Academy (grupos y matrícula, dudas, asistencia, entregas, graduación, catálogo de cursos y más): [docs/innovate-academy.md](docs/innovate-academy.md).

> **Estado:** el bot tiene pruebas automáticas con dobles de Discord, pero todavía no se ha ejecutado contra un servidor real. La primera puesta en marcha debe hacerse en un servidor de pruebas, siguiendo la lista del final.

## Qué incluye

| Bloque | Módulos |
|---|---|
| Entrada y seguridad | Bienvenida, verificación de entrada y anti-raid, filtro de estafas y spam, sanciones con historial |
| Comunidad | Niveles, eventos con inscripción, sorteos, avisos semanales, retos, referidos, escaparate de proyectos, recordatorio periódico |
| Soporte y staff | Tickets con plazo de respuesta, tareas, guardias y carga de trabajo, postulaciones al equipo, estadísticas |
| Registro y privacidad | Registro de mensajes, `/mis-datos`, `/borrar-mis-datos`, auditoría de consultas |
| Operación | `/config`, `/config revisar`, copias diarias, `/estado`, arranque automático, guía de hosting |

## Puesta en marcha

### 1. Crear el bot en Discord

1. Entra en <https://discord.com/developers/applications> y pulsa **New Application**.
2. En **Bot**, activa **Server Members Intent** y **Message Content Intent** y guarda.
3. En **Bot**, pulsa **Reset Token** y copia el token. Es como una contraseña: no lo compartas con nadie.
4. En **OAuth2 > URL Generator**, marca los scopes `bot` y `applications.commands` y estos permisos (no marques Administrator):

   - Ver canales, Enviar mensajes, Insertar enlaces, Adjuntar archivos, Leer el historial de mensajes
   - Mencionar todos los roles, Crear invitación
   - Gestionar mensajes, Gestionar roles, Gestionar canales, Gestionar eventos
   - Crear hilos públicos, Crear hilos privados, Enviar mensajes en hilos, Gestionar hilos
   - Aislar temporalmente a miembros, Expulsar miembros, Banear miembros

   El número de permisos resultante es `1503507246103`.

   Opcional: **Gestionar servidor**, solo si quieres activar los referidos (`/invitar`). Es un permiso amplio; sin él todo lo demás funciona igual.
5. Abre la URL generada e invita el bot a tu servidor.

### 2. Configurar el proyecto

1. Copia `.env.example` como `.env`.
2. Pega el token en `DISCORD_TOKEN`.
3. En Discord, activa **Ajustes > Avanzado > Modo desarrollador**, haz clic derecho en el icono del servidor, **Copiar ID del servidor**, y pégalo en `GUILD_ID`.

### 3. Arrancar

Hace falta Node 22.13 o superior.

```bash
npm install
```

```bash
npm start
```

Cuando veas `Conectado como ...`, el bot está funcionando y los comandos ya aparecen en el servidor. Si falta algo por configurar, lo verás como líneas `Aviso: ...`.

**Para el día a día en Windows** usa `iniciar.bat` (doble clic): vuelve a levantar el bot si se cae y guarda todo lo que pasa en `data\bot.log`. Si el problema es de configuración (falta el `.env`, token incorrecto), se detiene y te lo dice en vez de reintentar. Para que arranque al encender el PC, pulsa `Win + R`, escribe `shell:startup` y crea ahí un acceso directo a `iniciar.bat`.

Para pasarlo a un servidor encendido 24/7, sigue [docs/hosting.md](docs/hosting.md). Si intentas arrancar una segunda copia sobre la misma carpeta de datos, se niega y te lo dice.

### 4. Configurar desde Discord

Todo se hace con `/config` (solo administradores). Qué canales y roles crear, y en qué orden, está en "Configuración completa desde cero", más abajo.

| Comando | Para qué |
|---|---|
| `/config canal` | Canal de bienvenida, niveles, general, eventos, tareas, logs, **moderación**, proyectos, retos y postulaciones, y la **categoría** de tickets |
| `/config rol` | Rol de staff, rol automático al entrar, rol de miembro verificado y rol de supervisor |
| `/config texto` | Texto de bienvenida (`{usuario}`, `{servidor}`, `{miembros}`) y del recordatorio periódico |
| `/config web` | URL que enlaza el recordatorio periódico |
| `/config recordatorio` | Cada cuántos mensajes aparece el recordatorio y minutos mínimos entre avisos |
| `/config nivel-rol` | Rol que se da al alcanzar un nivel |
| `/config retencion` | Días que se conserva el registro de mensajes (0 = no borrar) |
| `/config zona` | Zona horaria de las fechas (por defecto `Europe/Madrid`) |
| `/config seguridad` | Días de restricción de enlaces, antigüedad mínima de cuenta y umbral del modo raid |
| `/config modulos`, `/config modulo` | Lista los módulos y activa o desactiva uno |
| `/config revisar` | Comprueba permisos, posición de roles y lo que falte por configurar |
| `/config ver` | Muestra la configuración actual |

El rol del bot tiene que estar **por encima** de los roles que deba asignar y de los miembros a los que deba sancionar. `/config revisar` te avisa si no es así.

### Activar solo lo que necesitas

`/config modulos` muestra todos los módulos con su identificador. `/config modulo accion:Desactivar nombre:giveaways` apaga los sorteos: sus comandos desaparecen del servidor y deja de reaccionar, sin reiniciar el bot. La configuración, las copias y `/estado` no se pueden desactivar.

## Configuración completa desde cero

Esta guía deja el bot con **todas** sus funciones activas en un servidor recién creado. Da por hecho que el bot ya está invitado y en marcha (pasos 1 a 3 de "Puesta en marcha"). Los nombres de canales y roles son sugerencias: lo que cuenta es asignarlos con `/config`.

Si solo quieres una parte, crea únicamente lo que necesites: cada función sin su canal o rol simplemente no actúa, y `/config revisar` te dice qué falta.

### Paso 1: crear los roles

En **Ajustes del servidor > Roles**:

| Rol | Para qué | Se asigna al bot con |
|---|---|---|
| `Staff` | Quien modera y atiende tickets, eventos, sorteos y tareas | `/config rol` > Rol de staff |
| `Supervisor` | Ve los reportes confidenciales y recibe las escaladas | `/config rol` > Rol de supervisor |
| `Miembro` | Se da al aceptar las normas; es el que permite ver el servidor | `/config rol` > Rol de miembro verificado |
| `Pagos` (opcional) | Atiende los tickets de pago y reembolso; si no existe, van a los supervisores | `/config rol` > Rol que atiende pagos y reembolsos |
| `Graduado` (opcional) | Se da al graduarse de un curso | `/config rol` > Rol de graduado |
| Rol automático (opcional) | Se da a todo el que entra, antes de verificarse | `/config rol` > Rol automático al entrar |
| Roles de nivel (opcional) | Recompensa al alcanzar un nivel | `/config nivel-rol nivel:5 rol:@...` |

Después **arrastra el rol del bot por encima de todos ellos**. Si queda por debajo de un rol, no puede darlo ni sancionar a quien lo tenga.

Los roles de cada grupo de alumnos, los de interés y el de Embajador no hay que crearlos: los crea el bot cuando hacen falta.

### Paso 2: crear los canales

**Canales para todos**

| Canal | Para qué lo usa el bot | Cómo se conecta |
|---|---|---|
| `#normas` | Botón **Acepto las normas** | Ejecutar ahí `/verificacion panel` |
| `#bienvenida` | Mensaje de bienvenida a quien entra | `/config canal` > Canal de bienvenida |
| `#general` | Recordatorio periódico con el botón a la web | `/config canal` > Canal general |
| `#niveles` | Anuncios de subida de nivel (si no existe, se anuncian donde se escriba) | `/config canal` > Canal de niveles |
| `#eventos` | Anuncios de eventos y talleres, con inscripción y aviso previo | `/config canal` > Canal de eventos |
| `#retos` | Retos de programación (si no existe, se publican donde se use el comando) | `/config canal` > Canal de retos |
| `#proyectos` | Escaparate de proyectos aprobados | `/config canal` > Canal de proyectos |
| `#novedades` | Vídeos anunciados con `/tiktok` | `/config canal` > Canal de novedades |
| `#soporte` | Botones para abrir tickets | Ejecutar ahí `/tickets panel` |
| `#únete-al-equipo` | Botón **Postularme** | Ejecutar ahí `/postulaciones panel` |

Los sorteos se publican en el canal donde se escriba `/sorteo crear`, y cada aviso semanal en el canal que se elija al programarlo, así que no necesitan canal propio.

**Canales privados del staff**

| Canal | Para qué lo usa el bot | Cómo se conecta |
|---|---|---|
| `#moderación` | Alertas del filtro, cuentas nuevas en revisión, modo raid, sanciones, tickets escalados, proyectos pendientes de aprobar y los informes de los lunes | `/config canal` > Canal de moderación |
| `#logs` | "Bot iniciado", errores inesperados y transcripciones de tickets | `/config canal` > Canal de logs |
| `#tareas` | Tareas del staff y avisos de vencimiento | `/config canal` > Canal de tareas |
| `#postulaciones` | Postulaciones recibidas, con los votos del staff (si no existe, llegan a moderación) | `/config canal` > Canal de postulaciones |

**Una categoría**

| Categoría | Para qué | Cómo se conecta |
|---|---|---|
| `Tickets` | El bot crea dentro un canal privado por cada ticket | `/config canal` > Categoría de tickets |

Si el bot no tiene el permiso Administrador (lo recomendado), en cada canal privado y en la categoría `Tickets` hay que añadir su rol con permiso para ver el canal y enviar mensajes. Sin eso no puede escribir ahí.

Las categorías de cada grupo de alumnos, con sus canales `avisos`, `dudas` y `entregas`, las crea el bot con `/grupo crear`.

### Paso 3: conectar roles y canales

Con el bot en marcha, un administrador ejecuta un `/config rol` por cada rol del paso 1 y un `/config canal` por cada canal del paso 2. Después:

| Comando | Para qué |
|---|---|
| `/config web url:https://tu-web.com` | Activa el recordatorio periódico |
| `/config texto` | Personaliza la bienvenida y el recordatorio (opcional) |
| `/config zona zona:America/Bogota` | Zona horaria de eventos y avisos, si no es la de España |
| `/config revisar` | Debe responder "Todo en orden" |

### Paso 4: activar la verificación sin dejar a nadie fuera

El orden importa si el servidor ya tiene gente:

1. `/verificacion existentes` da el rol `Miembro` a todos los miembros actuales.
2. `/verificacion panel` en `#normas`.
3. En **Ajustes del servidor > Roles**, quita a `@everyone` el permiso **Ver canales** y dáselo a `Miembro`.
4. En `#normas`, permite a `@everyone` ver el canal pero no escribir.

### Paso 5: publicar los paneles

| Dónde | Comando |
|---|---|
| `#soporte` | `/tickets panel` |
| `#únete-al-equipo` | `/postulaciones panel` |

### Paso 6: organizar al staff

- `/guardia asignar` para cada día de la semana: esa persona recibe la mención en las alertas.
- Da el rol `Staff` y `Supervisor` a quien corresponda.

### Paso 7: poner en marcha los cursos

Por cada grupo de alumnos:

1. `/grupo crear curso:Python nombre:"Octubre 2026" profesor:@...` crea el rol y la categoría del grupo.
2. `/aviso-semanal programar` con el día y la hora de cada clase, el canal `avisos` del grupo, el **rol del grupo** y el enlace de Meet. Hay que programar uno por cada clase de la semana.
3. `/codigo crear grupo:@...` genera los códigos de matrícula; cada alumno entra con `/canjear`.

### Paso 8: avisar a la comunidad

- Publica en `#normas` el aviso de privacidad (ver "Registro de mensajes y privacidad").
- Explica a los miembros que `/avisos activar` les permite recibir por privado los recordatorios de clase y de eventos.

### Comprobación final

`/config ver` muestra todo lo asignado y `/config revisar` lo que falte. A partir de ahí, el bot hace solo el resto: bienvenida, filtro, niveles, registro, avisos programados, copias diarias e informes de los lunes.

## Seguridad

### Canal de moderación

Crea un canal privado para el staff y asígnalo con `/config canal` > **Canal de moderación**. Ahí llegan las alertas del filtro, las cuentas nuevas en revisión, el aviso de modo raid, las sanciones y los resúmenes semanales.

### Filtro de estafas y spam

Activo de serie; no afecta al staff. `/automod desactivar` lo apaga.

| Qué detecta | Qué hace |
|---|---|
| Enlaces que imitan a Discord o Steam, "Nitro/Robux gratis" con enlace, `@everyone` con enlace | Borra el mensaje, silencia 24 h y avisa al staff con botones **Banear** / **Liberar** |
| Más de 5 menciones en un mensaje | Igual |
| El mismo mensaje en 3 canales en menos de 30 s | Igual, y borra todas las copias |
| Enlace de un sitio no permitido por alguien con menos de 7 días en el servidor | Borra el mensaje y se lo explica; sin sanción |

Solo cuenta como enlace lo que lleva `http://`, `https://`, `www.` o es una invitación de Discord: `main.py` o `app.get` no se bloquean. Los sitios permitidos de serie se ven con `/automod dominios`; añade los de tu comunidad con `/automod permitir`.

Conviene activar también el AutoMod propio de Discord (Ajustes del servidor > AutoMod) para palabras malsonantes y spam genérico.

### Verificación de entrada

Quien entra solo ve las normas hasta que pulsa **Acepto las normas**. Para activarla **sin dejar fuera a quienes ya están**, sigue este orden:

1. Crea un rol, por ejemplo `Miembro`, y asígnalo con `/config rol` > **Rol de miembro verificado**.
2. Ejecuta `/verificacion existentes` para dárselo a todos los miembros actuales. En servidores grandes tarda unos minutos.
3. En el canal de normas, ejecuta `/verificacion panel`.
4. En **Ajustes del servidor > Roles**, quita a `@everyone` el permiso **Ver canales** y dáselo al rol `Miembro`. En el canal de normas, permite a `@everyone` ver el canal pero no escribir.

Las cuentas de Discord con menos de 7 días no entran directamente: el staff recibe un aviso con botones **Aprobar** / **Expulsar**.

### Modo raid

Si entran más de 10 cuentas en 60 segundos, el bot pausa la verificación y avisa al staff. Se reanuda con el botón del aviso o con `/raid desactivar`. También se puede activar a mano con `/raid activar`.

### Sanciones

| Comando | Qué hace |
|---|---|
| `/advertir` | Advertencia con motivo. Tres en 30 días silencian 24 h automáticamente |
| `/silenciar` | Silencio temporal (`10m`, `2h`, `1d`, máximo 28 días) |
| `/desilenciar` | Retira el silencio |
| `/expulsar` | Expulsa; la persona puede volver a entrar |
| `/banear` | Banea; opcionalmente borra sus mensajes de los últimos días |
| `/historial` | Sanciones de un miembro |

Solo las usa el staff, nunca contra otro miembro del staff. La persona sancionada recibe el motivo por mensaje privado y todo queda en el historial y en el canal de moderación.

## Comunidad

| Comando | Quién | Qué hace |
|---|---|---|
| `/nivel [usuario]`, `/top` | Todos | Nivel, puesto y clasificación. Escribir da XP (15–25 por mensaje, con 60 s de espera) |
| `/evento crear`, `lista`, `cancelar` | Staff (lista: todos) | Evento en la pestaña Eventos de Discord + anuncio con botón de inscripción, enlace y mención opcional a un rol; avisa a los inscritos 15 min antes |
| `/sorteo crear`, `repetir` | Staff | Sorteo con botón en el canal actual; duración tipo `30m`, `2h`, `1d` |
| `/aviso-semanal programar`, `lista`, `borrar` | Staff (lista: todos) | Aviso que se repite cada semana (clases, reuniones, directos), con rol y enlace opcionales |
| `/reto crear`, `/reto cerrar` | Staff | Reto con botón **Enviar solución**. Las soluciones se publican en un hilo al cerrar; participar da XP y mantiene la racha, visible en `/nivel` |
| `/invitar` | Todos | Enlace personal de invitación. Cada invitado que sigue en el servidor (y verificado) a los 7 días da 200 XP; con 3, rol Embajador |
| `/proyecto` | Todos | Formulario para enseñar un proyecto; se publica en el canal de proyectos cuando el staff pulsa **Publicar**, y da 50 XP |
| `/avisos activar`, `desactivar` | Todos | Recibir por privado los avisos que te afectan. El bot no escribe por privado sobre estas cosas a quien no lo ha pedido |

**Recordatorio periódico:** cada N mensajes en el canal general (100 por defecto) el bot publica un mensaje con un botón a tu web. No se envía hasta que configures `/config web`.

Las fechas se escriben `DD/MM/AAAA HH:MM`, por ejemplo `25/10/2026 18:30`.

## Soporte y staff

### Tickets

`/tickets panel` publica un botón por tipo. Cada uno abre un canal privado que solo ven quien lo abre y el equipo que lo atiende:

| Tipo | Lo atiende | Transcripción en logs |
|---|---|---|
| Reportar bug | Staff | Sí |
| Pedir ayuda | Staff | Sí |
| Reportar a un usuario | Supervisores | No |

Los administradores ven todos. **Reportar a un usuario** es confidencial: fuera de su canal nunca se nombra a la persona reportada.

**Plazo de respuesta:** si nadie del equipo responde ni reclama un ticket, a las 12 horas el bot avisa dentro del ticket, y a las 20 horas lo escala al canal de moderación mencionando a los supervisores. Los mensajes de quien abrió el ticket no cuentan como respuesta.

### Herramientas del staff

| Comando | Quién | Qué hace |
|---|---|---|
| `/tarea crear`, `lista`, `hecha`, `borrar` | Staff | Tareas asignadas a un rol o persona, con fecha límite opcional y aviso al vencer |
| `/guardia asignar`, `quitar`, `ver` | Admin (ver: staff) | Quién está de guardia cada día de la semana. Esa persona recibe la mención en las alertas y en los tickets sin responder |
| `/carga [dias]` | Staff | Tickets cerrados y sanciones por persona, tiempo medio de primera respuesta y tickets sin respuesta en 24 h. Resumen cada lunes |
| `/stats [dias]` | Staff | Altas, bajas, verificados, actividad y retención a 7 días. Resumen cada lunes |
| `/postulaciones panel` | Admin | Botón **Postularme**. El formulario llega al canal de postulaciones, el staff vota 👍 / 👎 y un administrador acepta o rechaza; la respuesta va por privado |
| `/estado` | Staff | Desde cuándo está encendido el bot, memoria, tamaño de la base de datos y última copia |

## Registro de mensajes y privacidad

El bot guarda todos los mensajes del servidor (autor, canal, texto, enlaces de adjuntos, ediciones y borrados) en `data/bot.db`. Por defecto se borran a los 30 días (`/config retencion`). Los enlaces de adjuntos de Discord caducan en torno a un día, así que sirven como referencia, no como copia del archivo. Si no quieres este registro, desactiva el módulo `messageLog`; ten en cuenta que las transcripciones de los tickets y la detección de respuestas a tiempo salen de él.

- `/registro buscar` (admin) busca por usuario, canal o texto. Cada consulta queda anotada; `/registro auditoria` muestra quién buscó qué y cuándo.
- Cualquier miembro puede ver qué se guarda sobre él con `/mis-datos` y borrar sus mensajes del registro con `/borrar-mis-datos`.

Hay que avisarlo en las normas del servidor. Un texto de partida, que conviene revisar con quien lleve lo legal en tu comunidad:

> Para moderar el servidor, nuestro bot guarda los mensajes que se escriben aquí (texto, autor, canal, ediciones y borrados) durante 30 días. Solo los administradores pueden consultarlos y cada consulta queda registrada. Puedes ver qué guardamos sobre ti con `/mis-datos` y borrar tus mensajes del registro con `/borrar-mis-datos`. Para cualquier otra petición sobre tus datos, abre un ticket.

## Datos

Todo vive en `data/bot.db`. El bot hace una copia cada día en `data/backups/` y conserva las 7 últimas; antes de actualizar la base de datos a una versión nueva guarda además una copia `antes-de-actualizar-*.db`. Esas copias contienen los mensajes del servidor: no las compartas ni las subas a Discord. Para recuperar una, para el bot y sustituye `data/bot.db` por la copia.

Para mover el bot a otro ordenador o a un servidor, copia la carpeta del proyecto con `data/` y `.env`.

## Cómo está hecho

- `src/modules/`: un archivo por módulo. Cada uno exporta `{ id, name, commands, register, onCommand, onComponent, tick }`.
- `src/lib/`: lógica sin Discord (XP, fechas, filtro, sorteos), fácil de probar.
- `src/registry.js`: puntos de extensión.
- `src/extensions/`: extensiones opcionales; se cargan solas si existen. Ver [docs/extensiones.md](docs/extensiones.md).
- `tests/`: pruebas con dobles de Discord.

## Pruebas

```bash
npm test
```

Las pruebas automáticas usan dobles de Discord. Lo que sigue hay que comprobarlo una vez en un servidor real, mejor uno de pruebas:

- [ ] `/config revisar` responde "Todo en orden".
- [ ] Entra una cuenta nueva: mensaje de bienvenida y rol automático.
- [ ] El botón **Acepto las normas** da el rol de verificado; una cuenta de menos de 7 días genera el aviso al staff y **Aprobar** le da el rol.
- [ ] Con una cuenta sin rol de staff, pega `nitro gratis https://premios.xyz`: se borra, queda silenciada y llega la alerta; **Liberar** quita el silencio.
- [ ] Con una cuenta recién entrada, pega un enlace de un sitio no permitido: se borra con la explicación; un enlace de GitHub pasa.
- [ ] `/advertir` tres veces a una cuenta de prueba: recibe los privados y al tercero queda silenciada. `/historial` lo muestra.
- [ ] `/raid activar` bloquea el botón de verificación; `/raid desactivar` lo reanuda.
- [ ] Escribir da XP; `/nivel` y `/top` responden; al subir de nivel hay anuncio y rol.
- [ ] Tras N mensajes en el canal general aparece el recordatorio con el botón a la web.
- [ ] `/evento crear`: aparece en la pestaña Eventos y en el canal; el botón apunta y borra; llega el aviso previo.
- [ ] `/sorteo crear` con `1m`: el botón funciona y al minuto se anuncia el ganador.
- [ ] `/aviso-semanal programar` para dentro de unos minutos: llega el aviso con la mención.
- [ ] `/reto crear` con 1 día y `/reto cerrar`: aparece el hilo de soluciones y se reparte la XP.
- [ ] `/invitar` (con el permiso Gestionar servidor): da el enlace; al entrar una cuenta con él, sube "en espera".
- [ ] `/proyecto`: llega al canal de moderación y **Publicar** lo pasa al canal de proyectos.
- [ ] `/tarea crear` con fecha límite cercana: mensaje, aviso de vencimiento y botón "Marcar como hecha".
- [ ] `/tickets panel`: cada formulario crea un canal privado; "Reclamar" y "Cerrar" funcionan y la transcripción llega al canal de logs. Un reporte a un usuario no lo ve el staff normal.
- [ ] `/guardia asignar` para hoy: la siguiente alerta del filtro menciona a esa persona. `/carga` y `/stats` responden.
- [ ] `/postulaciones panel`: el formulario llega al canal del staff, los votos cuentan una vez por persona y **Aceptar** envía el privado.
- [ ] Editar y borrar un mensaje: `/registro buscar` lo muestra como editado o borrado, y `/registro auditoria` lista la consulta.
- [ ] `/mis-datos` muestra tus cifras; `/borrar-mis-datos` borra tus mensajes del registro tras confirmar.
- [ ] `/config modulo` desactiva un módulo: sus comandos desaparecen; al activarlo vuelven.
- [ ] Con `iniciar.bat`: al cerrar el proceso del bot, vuelve a arrancar solo; al día siguiente hay una copia en `data/backups/`.
- [ ] Con el canal de logs configurado, al arrancar aparece "Bot iniciado"; `/estado` responde.
