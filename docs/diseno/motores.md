# Diseño: varios motores de agente

Estado: **fases 1 y 2 implementadas en 0.5.0** (Claude con clave de API, adaptadores y OpenCode 1.19.6). Cómo se
usa: [../MOTORES.md](../MOTORES.md). Lo de abajo es el diseño completo; las fases 3 a 5 siguen pendientes.

## Objetivo

Hoy cada corrida es `claude -p` con la suscripción de Claude del Propietario. La idea es que el gateway pueda correr
otros "motores" (CLIs de agente) con el mismo control de siempre: roles, herramientas del gateway por MCP,
aislamiento por usuario de Linux, aprobaciones y bitácora. Superagent sigue siendo el harness del harness: el motor
cambia, la autoridad no.

| Motor | CLI | Cómo se paga | Para qué |
|---|---|---|---|
| Claude, suscripción | `claude` (hoy) | Pro / Max | Lo de siempre |
| Claude, API | `claude` con `ANTHROPIC_API_KEY` | Por uso | Sin suscripción; equipos con cuenta de API |
| Codex | `@openai/codex` | ChatGPT Plus/Pro o `CODEX_API_KEY` | Quien ya paga ChatGPT |
| Gemini | `@google/gemini-cli` | `GEMINI_API_KEY` (capa gratis) o Vertex | Probarlo gratis |
| OpenCode | `opencode-ai` 1.19.6 (V1, fija) | Clave de cada proveedor | DeepSeek, MiniMax, Kimi, Qwen, OpenRouter, Ollama local… |

## El modelo: un adaptador por motor

Lo que hoy está en `src/engine/claude.mjs` pasa a ser un adaptador. El resto del motor (cola, contexto, MCP del
gateway, salida, consumo) no cambia.

```
adaptador = {
  id, nombre,
  credencial(cuenta)            → variables de entorno de la corrida (solo las de ese motor; el resto se limpia)
  preparar(lugar, spec)         → escribe en la carpeta de la corrida su config: MCP del gateway, permisos, modelo
  argumentos(spec, {sesion})    → comando y flags (nueva o resume)
  leer(linea)                   → eventos normales: {sesion, herramienta, texto, uso, error}
  clasificarError(texto)        → sin_sesion | limite | sesion_perdida | otro
  capacidades                   → qué puede restringir de verdad (ver abajo)
}
```

| | Claude | Codex | Gemini | OpenCode V2 |
|---|---|---|---|---|
| Correr | `claude -p --output-format stream-json` | `codex exec --json -` | `gemini -p … -o stream-json` | `opencode run --format json` |
| Retomar | `--resume <id>` | `codex exec resume <id>` | `--resume <uuid>` (probar con `-p`) | `--session <id>` |
| MCP del gateway | `--mcp-config` archivo | `CODEX_HOME/config.toml` `[mcp_servers]` `url` + `bearer_token_env_var` | `GEMINI_CLI_HOME/.gemini/settings.json` `httpUrl` + `headers` | `opencode.json` `mcp.servers` `type: remote` + `headers` |
| Aislar config y credenciales | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` | `GEMINI_CLI_HOME` | `XDG_*` / `OPENCODE_DB` y `--standalone` |
| Sacar la terminal (shell) | `--tools` sin Bash | `features.shell_tool = false` (verificar) + `--sandbox read-only` | policy `run_shell_command` deny | permiso `shell` deny |
| Editar archivos | `--tools` | `--sandbox read-only` | policy deny | permiso `edit` deny |

Todos hablan MCP por HTTP, así que las herramientas del gateway (responder, aprobaciones, conectores, panel,
números…) funcionan igual en los cuatro.

## Roles y autoridad: en código, igual que hoy

- Cada rol hoy da herramientas de Claude por nombre (`Read`, `Edit`, `Bash`, `WebFetch`…). Pasan a ser capacidades
  abstractas: `leer`, `editar`, `terminal`, `web`. Cada adaptador las traduce a su forma de restringir.
- **Si un motor no puede garantizar una restricción, no corre para ese rol.** Por ejemplo, si en Codex no se puede
  sacar la terminal de forma confiable, un rol sin terminal no usa Codex: usa el siguiente motor permitido. El
  gateway lo decide, no el modelo.
- Un test por adaptador verifica que la config generada niega lo que el rol no tiene (como hoy con `--tools`).
- El MCP del gateway sigue recortado por rol, igual que hoy, sea cual sea el motor.

## Qué motor corre cada cosa (conversando con el Propietario)

- Hay un motor por defecto y uno por tipo de corrida: el chat del Propietario, el equipo, los terceros, los
  trabajos largos, las rutinas. Por ejemplo, Claude para el Propietario y los trabajos, y DeepSeek por OpenCode
  para atender a terceros, que es mucho más barato.
- **Respaldo:** si un motor da `limite` o `sin_sesion`, se pasa al siguiente de la lista en vez de frenar todo.
  Es el feature fuerte: "se te acabó el plan de Claude, sigue con Gemini hasta que se renueve".
- Se configura hablando con el agente (`configurar_motores`), con ficha y confirmación en otro mensaje, como los
  roles. La ficha dice qué cuesta cada uno y qué restricciones garantiza.
- Una conversación no cambia de motor en el medio sin avisar. Las sesiones no se trasladan entre motores: el
  cambio arranca una sesión nueva con el resumen de la memoria.

## Credenciales (lo único que queda en el panel)

| Motor | Cómo se conecta |
|---|---|
| Claude API | Clave en el panel (`ANTHROPIC_API_KEY`, cifrada). Ojo: si está en el entorno, le gana al token de la suscripción. Se pasa solo a las corridas de ese motor. |
| Codex | `codex login --device-auth` en una terminal del panel, como hoy `claude setup-token`, o `CODEX_API_KEY` |
| Gemini | `GEMINI_API_KEY` (Google AI Studio, gratis para empezar). El login con cuenta de Google no tiene flujo para servidor documentado. |
| OpenCode | Clave por proveedor (DeepSeek, MiniMax, OpenRouter…) cifrada en el panel, o `opencode auth login` |

El agente puede pedir cada clave con `pedir_variable` (link al panel), como cualquier secreto.

## Consumo

- Claude con suscripción: como hoy, con las ventanas del plan.
- Con API (Claude, OpenAI, Gemini, proveedores de OpenCode): tokens por precio de lista, en dólares reales, con
  tope diario o mensual opcional por motor.
- La tarjeta de consumo muestra el gasto por motor.

## Fases

1. **Claude con API key.** Chico: misma CLI, otra credencial y consumo en dólares reales. Incluye limpiar el
   entorno para que la clave no pise la suscripción.
2. **Adaptadores + OpenCode.** Mover `claude.mjs` a la interfaz y sumar OpenCode, que abre DeepSeek, MiniMax,
   OpenRouter y modelos locales de una vez. Elección por tipo de corrida.
3. **Codex** (cuenta de ChatGPT o clave).
4. **Gemini** (clave; capa gratis).
5. **Respaldo automático** entre motores y topes de gasto.

Cada fase suma unos MB a la imagen (las CLIs) y se publica como versión nueva.

## Decisiones tomadas (0.5.0)

- Si un motor no garantiza una restricción del rol, no corre para ese rol: corre Claude.
- OpenCode queda en la versión 1 (1.19.6), fija. La V2 no deja cargar claves sin terminal interactiva, guarda las
  credenciales en SQLite y suma herramientas que no se pueden limitar bien (código, automatizaciones que programan
  comandos).
- El respaldo automático y los topes de gasto quedan para la fase 5.

Lo que se aprendió con corridas reales de OpenCode 1.19.6:

- El comodín `"*"` en `tools` o `permission` lo cuelga al arrancar.
- `question`, `external_directory` y `doom_loop` esperan a una persona.
- Cuando el proveedor corta por límite, reintenta para siempre y solo lo dice en el log (`--print-logs`).
- El prompt por stdin no anda: va como argumento, o como archivo adjunto (`-f`) si es muy largo.

## Dudas que hubo (resueltas arriba)

1. ¿Arrancamos por la fase 1 + 2 (Claude API + OpenCode) como propuesta, o alguna antes?
2. Si un motor no garantiza una restricción del rol, ¿está bien "no corre para ese rol" (seguro) o preferís que
   corra igual avisando?
3. Respaldo automático: ¿encendido por defecto (con aviso al Propietario cuando salta) o solo si lo pide?
4. ¿Topes de gasto por defecto para los motores por uso (por ejemplo US$ 5/día) o sin tope hasta que lo pida?
5. OpenCode V2 cambió mucho hace poco (config, credenciales en SQLite, servidor compartido). ¿Fijamos versión y
   la actualizamos a mano?

## Lo que hay que probar antes de comprometer

- El formato exacto de eventos de `codex exec --json`, `gemini -o stream-json` y `opencode run --format json`: los
  docs no detallan todos los campos. Se capturan corridas reales y se arman los tests con eso.
- `features.shell_tool = false` en Codex: documentado como booleano, sin ejemplo apagado.
- `gemini --resume` junto con `-p`.
- OpenCode V2 sin servidor compartido entre usuarios de Linux (`--standalone`).
