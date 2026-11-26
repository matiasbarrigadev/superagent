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
   grupos, el chat real sale de `_data.Info.Chat`), guarda el mensaje y analiza menciones/apodos.
2. `src/engine/motor.mjs` encola, espera un silencio (debounce por tipo de chat), decide si despertar (en grupos
   atentos, una triage barata con Haiku) y arma la corrida.
3. `src/engine/contexto.mjs` arma instrucciones, herramientas y modelo según el rol (`src/roles/politica.mjs`).
   El Propietario en su chat directo o en el panel corre en **modo completo** (`bypassPermissions`, entorno
   persistente `propietario`); nunca cuando el origen es una entrada por webhook.
4. `src/engine/claude.mjs` lanza `claude -p` stream-json con el usuario aislado (`src/claude/aislamiento.mjs`) y
   el MCP del gateway (`src/mcp/servidor.mjs` + `herramientas.mjs`, un token por corrida).
5. El agente habla solo con la herramienta `responder`; la salida pasa por `src/wa/salida.mjs`.

## Recetas

**Agregar una herramienta del MCP**: definila en `src/mcp/herramientas.mjs` (nombre, descripción, esquema,
handler). Si requiere permiso, agregalo en `src/roles/permisos.mjs` y su regla en `politica.mjs`; exponela por rol en
`contexto.mjs`. Lo que escribe afuera pasa por `exigir` (con el Propietario en modo completo se aprueba y se anota
en la bitácora; con otros roles se le consulta al Propietario). Test en `test/` con `claudeFalso` y un guion que
la llame.

**Agregar un permiso**: actualizá también el test de la matriz de roles (`test/roles.test.mjs`, cuenta del catálogo).

**Cambiar la base**: nueva migración `src/db/migraciones/NNN_nombre.sql` (siguiente número, nunca edites una ya
publicada). Se aplica sola al arrancar; `test/esquema.test.mjs` la verifica.

**Cambiar lo que sabe el agente**: `agente/instrucciones.*.md` (base, onboarding, trabajo, sesión, tercero). El
texto que depende del estado (nombre, zona horaria, consumo, modo completo) se arma en `contexto.mjs`.

**Un ajuste configurable**: tabla `ajustes` (clave/valor). Leé con `ajustes.get/bool`, con un valor por defecto en
el código o en la migración. Lo ideal es que el agente lo cambie en diálogo (herramienta), no un formulario.

**Panel**: `web/src/pages/*.jsx` (React + Tailwind). Las rutas de la API están en `src/rutas/panel.mjs` y
`src/app.mjs`; todo lo del Propietario va protegido por sesión.

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
```
