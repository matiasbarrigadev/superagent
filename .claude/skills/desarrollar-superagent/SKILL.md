---
name: desarrollar-superagent
description: Cambiar, arreglar o extender el código de Superagent (gateway Node, panel React, instrucciones del agente, roles, herramientas MCP, WhatsApp/WAHA). Usar al tocar src/, web/, agente/, test/ o las migraciones, o al agregar una herramienta, un permiso o un conector.
---

# Desarrollar Superagent

Leé primero [AGENTS.md](../../../AGENTS.md) (reglas y mapa del repo).

## Puesta a punto

```sh
npm install && npm --prefix web install      # Node >= 24.7
npm test                                     # todos los tests (node --test, sin red, sin WAHA, sin Claude)
node --test test/roles.test.mjs              # un archivo
npm run web:build                            # el panel compila sin errores
```

Para probar con WhatsApp real usá Docker construyendo desde el repo (`docker compose -f docker-compose.yml -f docker-compose.desarrollo.yml up -d --build`) o una instalación de prueba; no hace
falta para la mayoría de los cambios: los tests cubren el flujo completo con dobles.

## Cómo fluye un mensaje

1. `src/wa/webhook.mjs` recibe el evento de WAHA (firmado), normaliza el chat (`<tel>@c.us` para directos; en
   grupos, el chat real sale de `_data.Info.Chat`), guarda el mensaje y analiza menciones/apodos. También registra
   reacciones, ediciones, borrados y votos de encuestas (`message.reaction`, `message.edited`, `message.revoked`,
   `poll.vote`): los votos se guardan en `encuesta_votos` y despiertan al agente en esa charla.
2. `src/engine/motor.mjs` encola, espera un silencio (debounce por tipo de chat), decide si despertar (en grupos
   atentos, una triage barata con Haiku) y arma la corrida.
3. `src/engine/contexto.mjs` arma instrucciones, herramientas y modelo según el rol (`src/roles/politica.mjs`).
   El Propietario en su chat directo o en el panel corre en **modo completo** (`bypassPermissions`, entorno
   persistente `propietario`); nunca cuando el origen es una entrada por webhook. Cada mensaje de WhatsApp lleva su
   marca `M-n` (seq) para citar o reaccionar.
4. `src/engine/motores.mjs` elige el motor (por tipo de conversación, con respaldo y topes de gasto) y
   `src/engine/ejecutor.mjs` lo corre con el usuario aislado (`src/claude/aislamiento.mjs`) y el MCP del gateway
   (`src/mcp/servidor.mjs` + `herramientas.mjs`, un token por corrida). Cada motor es un adaptador:
   `claude.mjs` (suscripción o clave de API), `codex.mjs`, `gemini.mjs` y `opencode.mjs`.
5. El agente habla solo con las herramientas del gateway (`responder`, `reaccionar`, `enviar_archivo`,
   `enviar_encuesta`…); todo pasa por la cola de `src/wa/salida.mjs`, que aplica la política de cada número y guarda
   el id de WhatsApp de lo enviado (`S-n`, para editar o borrar).

## Recetas

**Agregar una herramienta del MCP**: definila en `src/mcp/herramientas.mjs` (nombre, descripción, esquema,
handler). Si requiere permiso, agregalo en `src/roles/permisos.mjs` y su regla en `politica.mjs`; exponela por rol en
`contexto.mjs`. Lo que escribe afuera pasa por `exigir` (con el Propietario en modo completo se aprueba y se anota
en la bitácora; con otros roles se le consulta al Propietario). Test en `test/` con `claudeFalso` y un guion que
la llame.

**Agregar un motor de IA**: un adaptador en `src/engine/<motor>.mjs` con `preparar` (config, entorno y comando),
`lector` (eventos → sesión, herramientas, texto, uso), `clasificarError` y `puedeNegar` (qué herramientas de rol
sabe sacar de verdad: si no puede sacar una que el rol no tiene, ese motor no corre para ese rol). Registralo en
`nucleo.mjs`, sumalo a `INFO_MOTOR` en `motores.mjs`, fijá su versión en el `Dockerfile` y probalo contra un
modelo falso que registre qué herramientas ofrece la CLI (ver `scripts/verificar-motores.mjs`). La config que lee
la CLI no puede ser escribible por el agente. Docs: [docs/MOTORES.md](../../../docs/MOTORES.md).

**Una acción nueva de WhatsApp**: el método en `src/wa/waha.mjs` (formato de la API de WAHA para GOWS: ver la
tabla de soporte en la doc de WAHA), el tipo en la cola (`src/wa/salida.mjs` y el CHECK de la tabla `salida` con
una migración) y la herramienta en `herramientas.mjs`, que solo acepta marcas `M-n`/`S-n` de la conversación en
curso. Docs: [docs/WHATSAPP.md](../../../docs/WHATSAPP.md).

**Algo que guarda archivos en `/data`**: que tenga dueño y fecha, y que `src/servicios/disco.mjs` sepa limpiarlo o
mostrarlo en el desglose. La limpieza solo borra lo que ya cumplió su función; nunca la base, los secretos, las
charlas en curso ni el entorno del Propietario. Docs: [docs/DISCO.md](../../../docs/DISCO.md).

**Herramientas de conectores**: lectura o escritura sale de lo que declara cada herramienta (`readOnlyHint`) o de
que el conector sea de solo lectura (`src/conectores/lectura.mjs`). Nada específico de un servicio en el código.
Docs: [docs/RUTINAS.md](../../../docs/RUTINAS.md).

**Agregar un permiso**: actualizá también el test de la matriz de roles (`test/roles.test.mjs`, cuenta del catálogo).

**Cambiar la base**: nueva migración `src/db/migraciones/NNN_nombre.sql` (siguiente número, nunca edites una ya
publicada). Se aplica sola al arrancar; `test/esquema.test.mjs` la verifica.

**Cambiar lo que sabe el agente**: `agente/instrucciones.*.md` (base, onboarding, trabajo, sesión, tercero). El
texto que depende del estado (nombre, zona horaria, consumo, modo completo) se arma en `contexto.mjs`.

**Un ajuste configurable**: tabla `ajustes` (clave/valor). Leé con `ajustes.get/bool`, con un valor por defecto en
el código o en la migración. Lo ideal es que el agente lo cambie en diálogo (herramienta), no un formulario.

**Panel**: `web/src/pages/*.jsx` (React + Tailwind). Las listas van con `Tabla` de `components/ui.jsx` (tabla en
pantallas anchas, tarjetas en el teléfono); las grillas de página llevan `grid-cols-1 [&>*]:min-w-0` para que una
tabla ancha se desplace dentro de su tarjeta y no estire la página. Las rutas de la API están en
`src/rutas/panel.mjs` y `src/app.mjs`. **Toda ruta nueva tiene que estar en `PREFIJOS_PANEL`** (o en otro prefijo
con sesión): `test/rutas-protegidas.test.mjs` falla si alguna ruta no pública responde sin sesión. Los archivos
ajenos (adjuntos de la bandeja) se muestran en la página solo si el navegador no los puede ejecutar (fotos sin SVG,
audio, video, PDF), con CSP propia; lo demás se descarga.

**Webhooks de prueba reales**: `SUPERAGENT_GRABAR_WEBHOOKS=1` los guarda en `/data/grabaciones/webhooks.jsonl`;
pasalos a `test/payloads/` quitando teléfonos y nombres reales.

## Convenciones

- Código, comentarios, mensajes y UI en **español** (rioplatense neutro). Nombres de funciones en español.
- ES modules `.mjs`, sin TypeScript, sin dependencias nuevas salvo que no haya alternativa razonable.
- El repo guarda LF (`.gitattributes`), pero un checkout en Windows puede tener CRLF: editá con una herramienta de edición, no con reemplazos que asuman `\n`.
- No metas saltos de línea literales dentro de strings JS generados; usá `\n` o `String.fromCharCode(10)`.
- Secretos: nunca en logs, respuestas de la API ni en el contexto del agente. Se guardan cifrados (`src/auth/cripto.mjs`).
- Nada de nombres reales de clientes o personas en código, tests o instrucciones.
- Roles y conectores: todo cambio que el agente haga por el Propietario pasa por la ficha de
  `src/roles/ficha.mjs`. La ficha separa lo que el gateway hace cumplir de lo que queda solo como instrucción, y
  el cambio se aplica recién con la confirmación en otro mensaje: `panel` con `confirmado`, o `decidir` para
  `proponer_rol`. Una herramienta nueva que cree o cambie roles tiene que pasar por la misma ficha.
- Antes de cerrar: `npm test` en verde y, si tocaste `web/`, `npm run web:build`.

## Verificaciones dentro del contenedor

Con usuarios y programas reales (corren en la imagen, no en Windows/Mac):

```sh
docker compose exec superagent node scripts/verificar-aislamiento.mjs
docker compose exec superagent node scripts/verificar-medios.mjs
docker compose exec superagent node scripts/verificar-navegador.mjs
docker compose exec superagent node scripts/verificar-codigo.mjs
docker compose exec superagent node scripts/verificar-publicacion.mjs
docker compose exec superagent node scripts/verificar-motores.mjs   # Codex y Gemini contra un modelo falso; --opencode suma OpenCode real
```
