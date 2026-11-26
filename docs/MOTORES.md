# Motores de IA

Cada conversación corre con un motor (una CLI de agente). Hoy hay tres:

| Motor | Qué es | Cómo se paga | Qué hay que cargar |
|---|---|---|---|
| `claude` | Claude Code con tu suscripción | Pro / Max, sin costo extra | Panel → Claude → Conectar |
| `claude-api` | Claude Code con clave de API | Por uso, en dólares | `ANTHROPIC_API_KEY` |
| `opencode` | [OpenCode](https://opencode.ai) 1.19.6, con el modelo que elijas | Por uso, con la clave de cada proveedor | La clave del proveedor (ver abajo) |

Con cualquier motor el gateway es el mismo:

- los mismos roles;
- las mismas herramientas del gateway por MCP;
- el mismo aislamiento por usuario de Linux;
- las mismas aprobaciones y la misma bitácora.

## Elegir el motor, conversando

Se elige uno por tipo de conversación:

| Tipo | Qué cubre |
|---|---|
| `propietario` | Tu charla con el agente (modo completo) |
| `equipo` | Las demás charlas internas y los grupos |
| `terceros` | Clientes y personas externas |
| `trabajos` | Trabajos y sesiones de proyecto |
| `rutinas` | Rutinas programadas |
| `defecto` | Lo que no tenga uno propio (si no se elige nada: `claude`) |

Decíselo al agente, por ejemplo "usá DeepSeek para atender a los clientes":

1. Te muestra la ficha: cómo quedaría, qué cuesta y qué falta cargar.
2. Lo aplica recién cuando lo confirmás en otro mensaje.
3. Si falta una clave, te manda el link del panel para cargarla. Las claves nunca pasan por el chat.

Al cambiar de motor, esa charla arranca una conversación nueva con la misma memoria. Las sesiones no se pasan de
un motor a otro.

## Claves de OpenCode

El modelo va como `proveedor/modelo`. Cada proveedor usa su propia clave, que se carga en
*Panel → Variables de entorno*:

| Proveedor | Ejemplo de modelo | Clave |
|---|---|---|
| DeepSeek | `deepseek/deepseek-chat` | `DEEPSEEK_API_KEY` |
| MiniMax | `minimax/MiniMax-M2` | `MINIMAX_API_KEY` |
| Kimi (Moonshot) | `moonshotai/kimi-k2` | `MOONSHOT_API_KEY` |
| Qwen (Alibaba) | `alibaba/qwen3-coder-plus` | `DASHSCOPE_API_KEY` |
| OpenRouter | `openrouter/<modelo>` | `OPENROUTER_API_KEY` |
| Gratis de OpenCode | `opencode/<modelo>-free` | ninguna |

Los nombres exactos de los modelos están en [models.dev](https://models.dev). Los gratis de OpenCode sirven para
probar, pero tienen un tope diario. Cuando se llega, esas charlas esperan y te llega un aviso.

## Seguridad

- **Si un motor no puede sacar una herramienta que el rol no tiene, no corre para ese rol: corre Claude.** Lo decide
  el gateway, no el modelo. OpenCode sí puede sacar todas: terminal, edición, lectura, web y subagentes.
- OpenCode no lee nada que el agente pueda escribir:
  - la config va armada por el gateway en cada corrida;
  - la config del proyecto se ignora;
  - la carpeta de config global es del gateway y está vacía.
- Nada se comparte públicamente: `share` está apagado.
- No se le pregunta nada a una persona en el medio de una corrida: sin la herramienta de preguntas, y con los
  permisos de "preguntar" en negado.
- `ANTHROPIC_API_KEY` llega solo a las corridas de `claude-api`. Con la suscripción se saca del entorno, porque si
  no le gana al token.
- La clave de cada proveedor llega solo a las corridas que usan ese proveedor. Un rol con terminal puede leer las
  variables de su propio entorno: lo mismo pasa hoy con el token de Claude.

## Si un motor falla

| Pasa | Qué hace el gateway |
|---|---|
| Claude con la suscripción llega al límite | Pausa todo y avisa, como siempre |
| Otro motor se queda sin crédito, sin clave o llega a su tope | No frena a Claude. Esas charlas se reintentan cada 15 minutos y te avisa una vez cada 6 horas |
| No hay suscripción conectada pero sí `ANTHROPIC_API_KEY` | Usa la clave, sin configurar nada |

La tarjeta de consumo del panel muestra aparte el gasto real de los motores por uso de los últimos 30 días.

## Próximo

Codex, Gemini, el respaldo automático entre motores y los topes de gasto. El diseño está en
[diseno/motores.md](diseno/motores.md).
