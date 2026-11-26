# Guía para agentes

Este archivo es para agentes de código (Claude Code, Codex, Cursor, etc.) que trabajan con este repo. Las personas
pueden empezar por el [README](README.md).

## ¿Qué te pidieron?

| Pedido | Qué seguir |
|---|---|
| "Instalá / levantá / deployá un Superagent" (Railway o Docker) | [.claude/skills/instalar-superagent/SKILL.md](.claude/skills/instalar-superagent/SKILL.md). En Railway: el template <https://railway.com/deploy/superagente-en-whatsapp>. En Docker: la imagen `ghcr.io/matiasbarrigadev/superagent:<versión>`. Nunca desde el repo, salvo para desarrollar. |
| "Cambiá / arreglá / agregá algo en el código" | [.claude/skills/desarrollar-superagent/SKILL.md](.claude/skills/desarrollar-superagent/SKILL.md) |
| "Actualizá mi instalación" | Instalar → sección *Actualizar* |
| "Traé lo que tengo de otro asistente" / "mudá la instalación" | [docs/IMPORTAR.md](docs/IMPORTAR.md) (paquete con ensayo, sin secretos) |

Claude Code carga esas skills solo (están en `.claude/skills/`). Otros agentes: leé el `SKILL.md` que corresponda.

Al instalar, **lo primero que se entrega es la URL del panel** (link clickeable). Cómo obtenerla en cada caso está
en la skill de instalación, sección *La URL del panel*.

## El principio

Superagent es el harness del harness: pone a Claude Code detrás de un gateway que controla quién habla, con qué
accesos y con qué seguridad, y todo pasa por WhatsApp.

- **Conversando se hace todo.** El Propietario, hablando con el agente, puede hacer todo lo que hace el panel.
- **El panel queda solo para lo que exige credenciales u OAuth**: conectar cuentas, cargar secretos, vincular
  WhatsApp, conectar Claude.
- **Todo cambio es genérico.** Lo que se aprende con una instalación en particular se lleva al gateway:
  instrucciones base, herramientas, defaults y docs. Nada de un negocio concreto en el núcleo: eso va en la
  configuración de la instalación (roles, memoria, instrucciones extra), que se arma conversando.

### Prompt primero, código como soporte

El harness no hardcodea comportamiento. Primero la inteligencia del modelo, después el soporte en código.

- **Comportamiento → prompt.** Va como instrucciones claras más el contexto que el modelo necesita, y el agente
  razona, detecta y pregunta. Por ejemplo:
  - interpretar lo que pide el Propietario;
  - detectar conflictos (entre números, entre pedidos);
  - decidir cuándo responder;
  - qué conviene proponer.

  Nada de reglas fijas en código para eso.
- **Código → soporte.** Herramientas que le dan datos al modelo (listar números, qué chats ve cada uno), guardar y
  leer configuración, bitácora y auditoría.
- **La excepción, siempre en código: roles, autoridad, seguridad y privacidad.**
  - Quién puede cambiar la configuración, aprobar o tener autoridad sobre el agente.
  - La confirmación del Propietario en otro mensaje para cambios de configuración (roles, conectores, números,
    paquetes).
  - Qué puede hacer de verdad el agente: permisos del rol, conectores, si un número puede enviar.
  - Qué datos entran y se guardan.

  Eso no puede depender de que el modelo se acuerde.

## Reglas que no se negocian

- **Nunca escribas credenciales** (tokens, claves, contraseñas, códigos de setup) en archivos del repo, commits,
  issues ni mensajes. Los secretos del sistema se generan solos; los de servicios se conectan desde el panel o por
  WhatsApp y quedan cifrados en `/data`.
- **Las acciones que necesitan a la persona son de la persona**: crear la cuenta del Propietario, el TOTP,
  `claude setup-token`, escanear el QR de WhatsApp. Vos dejás todo listo y le decís exactamente qué tocar.
- **No borres volúmenes** (`docker compose down -v`, borrar el volumen en Railway) sin confirmación explícita: ahí
  está la sesión de WhatsApp, la base y los tokens cifrados.
- **No uses nombres de clientes o personas reales** en código, tests, instrucciones del agente ni ejemplos. Usá
  nombres genéricos.
- **No modifiques el binario de Claude Code** ni lo reemplaces: el sistema usa el oficial (`@anthropic-ai/claude-code`).

## Mapa del repo

```
src/
  server.mjs, app.mjs, nucleo.mjs   arranque, rutas HTTP, cableado de todos los servicios
  config.mjs, secretos.mjs          configuración (ninguna variable es obligatoria) y secretos generados
  wa/                               WhatsApp: webhook de WAHA, salida, grupos, unificación @lid/@c.us
  engine/                           motor (cola, debounce, despertar), contexto (instrucciones y herramientas
                                    por rol), ejecutor común y un adaptador por motor (claude, codex, gemini, opencode);
                                    motores.mjs elige el motor de cada corrida
  claude/                           aislamiento por usuario de Linux, cuenta de Claude (token, uso del plan),
                                    logins de CLIs del entorno del Propietario
  mcp/                              MCP del gateway (127.0.0.1) y sus herramientas
  roles/                            permisos y política (qué puede cada rol)
  servicios/                        aprobaciones, bitácora, consumo, entorno (variables cifradas), memoria…
  conectores/                       cliente OAuth para MCPs remotos (DCR + PKCE)
  codigo/                           repos, ramas, publicación por procedimiento
  db/migraciones/                   SQL numerado (NNN_nombre.sql), se aplica solo al arrancar
agente/                             instrucciones del agente (base, onboarding, trabajo, sesión, tercero)
web/                                panel (React + Vite + Tailwind)
test/                               node --test; `ayuda.mjs` arma un núcleo falso; `payloads/` webhooks reales
scripts/                            verificaciones dentro del contenedor y generador de secretos
railway/TEMPLATE.md                 receta del template de Railway
.github/workflows/imagen.yml        publica la imagen (tests → amd64 + arm64 → ghcr.io) en cada tag vX.Y.Z y :edge en main
docker-compose.yml                  instalación con la imagen publicada (docker-compose.desarrollo.yml: construir desde el repo)
docs/IMPORTAR.md                    formato de paquetes para traer trabajo previo o mudar una instalación
docs/NUMEROS.md                     varios números de WhatsApp y la política de cada uno
docs/MOTORES.md                     motores de IA (Claude, Codex, Gemini, OpenCode), respaldo, topes y cómo se elige cada uno
```
