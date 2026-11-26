# Motores de IA

Cada conversación corre con un motor (una CLI de agente). Hay cinco:

| Motor | Qué es | Cómo se paga | Qué hay que cargar |
|---|---|---|---|
| `claude` | Claude Code con tu suscripción | Pro / Max, sin costo extra | Panel → Inicio → Claude → Conectar |
| `claude-api` | Claude Code con clave de API | Por uso, en dólares | `ANTHROPIC_API_KEY` |
| `codex` | Codex CLI 0.172.0 | Tu plan de ChatGPT, o por uso con clave | Cuenta de ChatGPT (Panel → Motores de IA → Conectar ChatGPT) o `CODEX_API_KEY` |
| `gemini` | Gemini CLI 0.71.1 | Capa gratis de Google AI Studio, después por uso | `GEMINI_API_KEY` |
| `opencode` | [OpenCode](https://opencode.ai) 1.19.6, con el modelo que elijas | Por uso, con la clave de cada proveedor | La clave del proveedor (ver abajo) |

Con cualquier motor el gateway es el mismo:

- los mismos roles;
- las mismas herramientas del gateway por MCP;
- el mismo aislamiento por usuario de Linux;
- las mismas aprobaciones y la misma bitácora.

## Dónde se configura

**Conversando con el agente**, por ejemplo:

- "usá DeepSeek para atender a los clientes";
- "si se acaba Claude, seguí con Gemini";
- "ponele un tope de 5 dólares por día a OpenCode";
- "conectá mi ChatGPT para usar Codex".

El agente te muestra la ficha (cómo quedaría, qué cuesta, qué falta) y lo aplica recién cuando lo confirmás en otro
mensaje. Si falta una clave, te manda el link del panel para cargarla: las claves nunca pasan por el chat.

**En el panel → Motores de IA**, todo en tablas:

- qué motor y modelo atiende cada tipo de conversación, con su estado;
- cada motor con su credencial, lo gastado (hoy y en el mes) y su tope;
- el respaldo automático, en orden;
- las claves de cada motor y proveedor, para cargarlas ahí mismo.

Los cambios se juntan en una barra y se guardan después de confirmarlos.

## Tipos de conversación

| Tipo | Qué cubre |
|---|---|
| `propietario` | Tu charla con el agente (modo completo) |
| `equipo` | Las demás charlas internas y los grupos |
| `terceros` | Clientes y personas externas |
| `trabajos` | Trabajos y sesiones de proyecto |
| `rutinas` | Rutinas programadas |

Al cambiar de motor, esa charla arranca una conversación nueva con la misma memoria. Las sesiones no se pasan de
un motor a otro.

## Respaldo automático

Es una lista ordenada de hasta 4 motores. Si el motor de turno se queda sin plan, sin crédito o sin credencial:

1. La charla sigue con el primero de la lista que pueda correr: tiene su credencial, no pasó su tope y el rol lo
   permite.
2. Te llega un aviso.
3. El motor que falló queda en pausa un rato (15 minutos por límite, 5 por credencial) y después se vuelve a probar
   solo.

Sin respaldo, como antes: esas charlas esperan en cola.

## Topes de gasto

Por motor, en dólares por día y por mes. Se pueden poner a los motores que informan el precio de cada corrida:
`claude-api` y `opencode`. Codex con clave y Gemini no lo informan; su gasto se ve en la cuenta del proveedor.

Con el tope alcanzado:

- esas charlas no corren y esperan;
- te llega un aviso;
- si hay respaldo, siguen con el respaldo.

## Claves de OpenCode

El modelo va como `proveedor/modelo`. Cada proveedor usa su propia clave:

| Proveedor | Ejemplo de modelo | Clave |
|---|---|---|
| DeepSeek | `deepseek/deepseek-chat` | `DEEPSEEK_API_KEY` |
| MiniMax | `minimax/MiniMax-M2` | `MINIMAX_API_KEY` |
| Kimi (Moonshot) | `moonshotai/kimi-k2` | `MOONSHOT_API_KEY` |
| Qwen (Alibaba) | `alibaba/qwen3-coder-plus` | `DASHSCOPE_API_KEY` |
| OpenRouter | `openrouter/<modelo>` | `OPENROUTER_API_KEY` |
| Gratis de OpenCode | `opencode/<modelo>-free` | ninguna |

Los nombres exactos de los modelos están en [models.dev](https://models.dev). Los gratis de OpenCode sirven para
probar, pero tienen un tope diario.

## Seguridad

**Si un motor no puede sacar una herramienta que el rol no tiene, no corre para ese rol: corre Claude.** Lo decide
el gateway, no el modelo. Cada adaptador tiene un test que verifica que la config que arma niega lo que el rol no
tiene. Las restricciones de Codex y Gemini se probaron contra un modelo falso que registra qué herramientas le
ofrece cada CLI (`scripts/verificar-motores.mjs`).

Ningún motor lee una config que el agente pueda escribir:

| Motor | Cómo |
|---|---|
| OpenCode | Config inline, sin config del proyecto, carpeta global vacía de root |
| Codex | La config se reescribe en cada corrida y la del proyecto no se usa |
| Gemini | Lo que importa va en un archivo de "sistema" que le gana a todo y está en una carpeta de root. Si Gemini lo ignorara, la corrida no sigue. La config del proyecto se borra antes de cada corrida |

Nada espera a una persona en el medio de una corrida: las herramientas de preguntas están apagadas y los permisos
de "preguntar" están negados. Ningún motor comparte sesiones públicamente, y en Codex y Gemini quedan apagados los
plugins, los hooks, el navegador propio y la generación de imágenes.

Las credenciales:

- Cada credencial llega solo a las corridas de su motor. `ANTHROPIC_API_KEY` se saca del entorno de Claude con
  suscripción, porque si no le gana al token.
- La cuenta de ChatGPT queda cifrada en la base. Cada corrida de Codex recibe una copia que se borra al terminar, y
  si Codex renueva el token, se guarda el nuevo.
- Un rol con terminal puede leer las credenciales de su propio entorno. Lo mismo pasa con el token de Claude.

## Si un motor falla

| Pasa | Qué hace el gateway |
|---|---|
| Claude con la suscripción llega al límite, sin respaldo | Pausa todo y avisa, como siempre |
| Cualquier motor falla y hay respaldo | Sigue con el respaldo y avisa |
| Otro motor se queda sin crédito o sin clave, sin respaldo | No frena a Claude. Esas charlas se reintentan cada 15 minutos y te avisa una vez cada 6 horas |
| No hay suscripción conectada pero sí `ANTHROPIC_API_KEY` | Usa la clave, sin configurar nada |

El diseño completo está en [diseno/motores.md](diseno/motores.md).
