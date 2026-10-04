# Extensión de Innovate Academy

Esta rama (`innovate-academy`) es el bot de `main` más la extensión de [Innovate Academy](https://innovateacademy.site/), que vive en `src/extensions/academy/`. Todo lo del README sigue valiendo; aquí está solo lo que añade.

Para traer mejoras del bot genérico: `git merge main` desde esta rama. La extensión no toca archivos del núcleo, así que no debería haber conflictos.

## Qué añade

| Bloque | Qué hace |
|---|---|
| Matrícula | Grupos por curso con rol y canales privados, matrícula a mano y códigos de un solo uso |
| Aprendizaje | Dudas con "Resuelto", asistencia, ejercicios y entregas, radar de abandono, graduación con certificado |
| Captación | Intereses y recomendación de curso, `/cursos`, talleres abiertos, `/tiktok`, `/hosting` |
| Soporte | Tickets de duda de curso, problema con un pago y reembolso |
| Avisos | Privado 1 hora y 10 minutos antes de cada clase, para quien lo ha pedido |

Además cambia los textos por defecto del recordatorio periódico, permite de serie los enlaces a `innovateacademy.site` y añade sus cifras a `/stats`, `/carga` y `/mis-datos`.

## Configuración propia

| Comando | Para qué |
|---|---|
| `/config rol` > Rol de graduado | Se da al graduarse |
| `/config rol` > Rol que atiende pagos y reembolsos | Ve los tickets de pago y reembolso; si no se asigna, pasan a los supervisores |
| `/config canal` > Canal de novedades | Donde publica `/tiktok` |
| `/config texto` > Texto del patrocinador | Lo que muestra `/hosting` |

Tras instalar la extensión, vuelve a publicar el panel de tickets con `/tickets panel` para que aparezcan los tipos nuevos.

## Matrícula por curso y grupo

Cada grupo (por ejemplo "Python · Octubre 2026") tiene su rol y su categoría privada con tres canales: `avisos` (solo escriben profesor y staff), `dudas` y `entregas`.

| Comando | Quién | Qué hace |
|---|---|---|
| `/grupo crear` | Admin | Crea el rol, la categoría y los canales del grupo; opcionalmente con su profesor |
| `/grupo lista`, `/grupo alumnos` | Staff | Grupos con su número de alumnos; alumnos de un grupo |
| `/grupo cerrar` | Admin | Al terminar el curso: los canales quedan de solo lectura |
| `/matricular`, `/desmatricular` | Staff | Mete o saca a un alumno de un grupo a mano |
| `/codigo crear`, `/codigo lista` | Staff | Genera códigos de un solo uso (`IA-XXXX-XXXX`) para un grupo; muestra los que quedan |
| `/canjear` | Todos | El alumno introduce su código y entra en su grupo |

El grupo se elige por su rol. El flujo habitual: el alumno paga en la web, el staff le envía un código y el alumno lo canjea en Discord. Tras 5 intentos fallidos seguidos, `/canjear` se bloquea 10 minutos para esa persona.

## Aprendizaje

Los comandos del profesor se usan **dentro de un canal del grupo**: así el bot sabe de qué grupo se trata. "Profesor" es quien se indicó en `/grupo crear`, o cualquier miembro del staff.

### Dudas de código

| Comando | Quién | Qué hace |
|---|---|---|
| `/duda` | Alumno | Formulario (qué intentas, código, error). Se publica en `dudas` con un hilo y el código ya formateado |
| Botón **Marcar como resuelta** | Quien preguntó o el profesor | Pregunta quién ayudó; esa persona gana un punto de ayudante |
| `/ayudantes` | Todos | Clasificación de quien más dudas ha resuelto |

Si una duda lleva 12 horas sin que nadie más escriba en su hilo, el bot avisa al profesor. Cuando alguien pega código suelto en un canal del grupo, le sugiere el bloque de código (como mucho una vez al día por persona).

### Clases y avisos por privado

Una clase se programa como un aviso semanal del núcleo, con el **rol del grupo** y el enlace:

`/aviso-semanal programar nombre:Python dia:lunes hora:18:00 canal:#avisos rol:@Python · Octubre enlace:https://meet.google.com/...`

Los alumnos de ese grupo que hayan hecho `/avisos activar` reciben además un privado 1 hora y 10 minutos antes, con el enlace y la hora en su zona.

### Asistencia

| Comando | Quién | Qué hace |
|---|---|---|
| `/sesion abrir palabra:` | Profesor | Empieza a pasar lista con una palabra clave que dice en clase |
| `/asistencia palabra:` | Alumno | Registra su asistencia |
| `/sesion cerrar [grabacion] [recursos]` | Profesor | Publica el resumen en `avisos` y dice quién faltó. Quien faltó y tiene los avisos activados lo recibe por privado |

### Ejercicios y entregas

| Comando | Quién | Qué hace |
|---|---|---|
| `/ejercicio crear` | Profesor | Publica el ejercicio en `avisos` con el botón **Entregar**; `proyecto_final` lo marca como proyecto final |
| Botón **Entregar** | Alumno | Abre un hilo privado en `entregas` entre el alumno y su profesor |
| Botones **Aprobado** / **Rehacer** | Profesor | Corrige; "Rehacer" pide un comentario y el alumno vuelve a entregar en el mismo hilo |
| `/mi-progreso [alumno]` | Alumno (profesor para ver a otro) | Estado de cada ejercicio y asistencia |
| `/ejercicio lista` | Todos | Ejercicios del grupo |

### Radar de abandono

Cada lunes a las 9:00 llega al canal de moderación la lista de alumnos con señales de abandono: faltar a las 2 últimas clases, o tener 2 o más ejercicios vencidos sin entregar. `/radar` la muestra en cualquier momento. Quien tiene los avisos activados recibe además un privado ofreciéndole ayuda.

### Graduación

`/graduar alumno:` exige el proyecto final aprobado y al menos un 70 % de asistencia (si el grupo tiene proyecto final y clases registradas); `forzar` se salta los requisitos. Emite un certificado con código `CERT-XXXX-XXXX`, da el rol de graduado si está configurado y lo anuncia en `avisos` con el siguiente curso recomendado. Cualquiera puede comprobar un código con `/certificado verificar`; `/certificado mios` lista los propios.

## Captación

| Comando | Quién | Qué hace |
|---|---|---|
| `/intereses` | Todos | "¿Qué quieres aprender?": da un rol de interés y recomienda un curso o pack en privado. También se ofrece justo al verificarse |
| `/cursos` | Todos | Catálogo con duración, precio y botón a la web |
| `/taller crear` | Staff | Taller abierto: un evento con inscripción que avisa solo al rol del interés del curso y, hora y media después de empezar, deja un único mensaje con el curso |
| `/tiktok enlace:` | Staff | Anuncia un vídeo en el canal de novedades |
| `/hosting` | Todos | Mensaje del patrocinador (SolarCloud) |

Los cursos, precios y packs están en `src/extensions/academy/courses.js`, copiados de la web a 03/10/2026. Si cambian en la web, hay que actualizarlos ahí.

## Tickets propios

| Tipo | Lo atiende | Transcripción en logs |
|---|---|---|
| Duda de un curso | Staff | Sí |
| Problema con un pago | Rol de pagos; si no hay, supervisores | No |
| Reembolso | Rol de pagos; si no hay, supervisores | No |

## Hosting

SolarCloud, el patrocinador de la academia, ofrece hosting de bots con panel Pterodactyl, que es justo lo que cubre la opción A de [hosting.md](hosting.md). Soporte: su Discord o `support@solarcloud.lat`.

## Comprobaciones en un servidor real

Además de la lista del README:

- [ ] `/grupo crear`: aparecen el rol y la categoría con `avisos`, `dudas` y `entregas`; un alumno no puede escribir en `avisos`.
- [ ] `/codigo crear` y, con otra cuenta, `/canjear`: entra en el grupo; el mismo código no sirve dos veces.
- [ ] `/duda`: se crea el hilo con el código formateado; **Marcar como resuelta** muestra el menú de personas y da el punto.
- [ ] Un aviso semanal con el rol del grupo avisa por privado 1 h y 10 min antes a quien hizo `/avisos activar`.
- [ ] `/sesion abrir`, `/asistencia` y `/sesion cerrar`: el resumen aparece en `avisos` con la cuenta correcta.
- [ ] `/ejercicio crear` y **Entregar**: el hilo privado solo lo ven el alumno, el profesor y el staff; **Rehacer** y **Aprobado** funcionan.
- [ ] `/mi-progreso` y `/radar` muestran datos coherentes con lo anterior.
- [ ] `/graduar` emite el certificado y `/certificado verificar` lo reconoce.
- [ ] Al verificarse aparece el menú de intereses; elegir uno da el rol y la recomendación. `/cursos` muestra el catálogo.
- [ ] `/taller crear` menciona solo al rol de ese interés y deja el mensaje posterior.
- [ ] El panel de tickets muestra los seis botones; un ticket de pago solo lo ve el rol de pagos.
- [ ] `/grupo cerrar`: los alumnos pueden leer pero no escribir.

## Pendiente

- Probarlo todo en un servidor real: hasta ahora solo hay pruebas automáticas.
- Publicar en las normas el aviso de privacidad (texto de partida en el README).
- Que la web genere sola el código de matrícula al pagar. Hoy lo crea el staff con `/codigo crear`.
- Certificado descargable o página de verificación en la web. Hoy el certificado es un código verificable dentro de Discord.
