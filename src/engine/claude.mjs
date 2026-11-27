// Adaptador de Claude Code: `claude -p` (binario oficial, sin modificar) con el usuario de Linux de su
// conversación, entorno limpio y su propia carpeta, leyendo el stream-json. El prompt va por stdin; los permisos van como flags que arma el gateway.
import path from 'node:path';
import crypto from 'node:crypto';
import { crearEjecutorComun } from './ejecutor.mjs';

/** Flags de una corrida a partir de su especificación (ver engine/contexto.mjs). */
export function argumentos(spec, { sesion, nueva }) {
  const a = ['-p', '--output-format', 'stream-json', '--verbose'];
  a.push('--model', spec.modelo);
  if (spec.respaldo && spec.respaldo !== spec.modelo) a.push('--fallback-model', spec.respaldo);
  if (spec.esfuerzo) a.push('--effort', spec.esfuerzo);
  if (spec.completo) {
    // Propietario en su chat: Claude Code completo, con su configuración persistente (MCPs propios, plugins,
    // skills, hooks, CLAUDE.md). El MCP del gateway se suma a los suyos.
    a.push('--permission-mode', 'bypassPermissions');
    a.push('--mcp-config', spec.mcp.archivo);
    if (spec.agentes && Object.keys(spec.agentes).length) a.push('--agents', JSON.stringify(spec.agentes));
    if (spec.sistema) a.push('--append-system-prompt', spec.sistema);
    if (nueva) a.push('--session-id', sesion);
    else a.push('--resume', sesion);
    return a;
  }
  // Herramientas propias de Claude Code: solo las que da el rol ("" = ninguna).
  a.push('--tools', spec.herramientasClaude.join(','));
  const permitidas = [...spec.herramientasClaude, ...spec.herramientasGateway.map((h) => `mcp__superagent__${h}`), ...(spec.herramientasExtra ?? [])];
  if (permitidas.length) a.push('--allowedTools', permitidas.join(','));
  // Lo que no está permitido se niega sin preguntar.
  a.push('--permission-mode', 'dontAsk');
  // El MCP va en un archivo de la corrida (0600 de su usuario): el token no queda a la vista en /proc.
  a.push('--mcp-config', spec.mcp.archivo);
  a.push('--strict-mcp-config');
  // Sin settings de usuario ni de proyecto: lo que el agente escriba en su carpeta no cambia corridas futuras.
  a.push('--setting-sources', '');
  a.push('--settings', JSON.stringify({ disableAllHooks: true }));
  a.push('--disable-slash-commands', '--no-chrome');
  if (spec.agentes && Object.keys(spec.agentes).length) a.push('--agents', JSON.stringify(spec.agentes));
  if (spec.sistema) a.push('--append-system-prompt', spec.sistema);
  if (nueva) a.push('--session-id', sesion);
  else a.push('--resume', sesion);
  return a;
}

/** Contenido del archivo de MCP de una corrida: el del gateway y, si los hay, otros servidores (navegador, conectores). */
export function configMcp(spec) {
  return JSON.stringify({
    mcpServers: {
      superagent: { type: 'http', url: spec.mcp.url, headers: { Authorization: `Bearer ${spec.mcp.token}` } },
      ...(spec.mcpExtra ?? {}),
    },
  });
}

export function clasificarError(texto = '', codigoError = null) {
  const t = String(texto);
  if (codigoError === 'authentication_failed' || /not logged in|please run \/login|oauth (access )?token|token (has )?expired|invalid api key|authenticat/i.test(t)) return 'sin_sesion';
  if (codigoError === 'rate_limit' || /usage limit|limit reached|hit your (usage )?limit|rate.?limit|out of (extra )?usage|session limit|weekly limit/i.test(t)) return 'limite';
  if (/no conversation found|session .*not found|no session found/i.test(t)) return 'sesion_perdida';
  return 'otro';
}

// Variables que no pueden llegar a una corrida de Claude desde el entorno del Propietario: una clave de API en el
// entorno le gana al token de la suscripción. La credencial la pone cada adaptador.
const CREDENCIALES_CLAUDE = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Adaptador de Claude Code. `credencial`: "suscripcion" (token de `claude setup-token`) o "api"
 * (ANTHROPIC_API_KEY, cobro por uso en dólares reales). Misma CLI y mismas sesiones en disco.
 */
export function crearAdaptadorClaude({ cuenta, credencial = 'suscripcion' }) {
  const id = credencial === 'api' ? 'claude-api' : 'claude';
  return {
    id,
    nombre: credencial === 'api' ? 'Claude (clave de API)' : 'Claude (suscripción)',
    familia: 'claude',
    // Claude Code saca de verdad cualquier herramienta propia con --tools.
    puedeNegar: new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'Task']),
    clasificarError,
    preparar({ spec, lugar, aislamiento, sesion, nueva }) {
      // Un archivo por corrida: el entorno del Propietario puede tener dos corridas a la vez.
      const archivoMcp = path.join(lugar.base, spec.completo ? `mcp-${crypto.randomUUID()}.json` : 'mcp.json');
      aislamiento.escribirArchivo(archivoMcp, configMcp(spec), lugar.usuario);
      const c = cuenta.comando(argumentos({ ...spec, mcp: { ...spec.mcp, archivo: archivoMcp } }, { sesion, nueva }));
      const extra = { ...(spec.entornoExtra ?? {}) };
      for (const n of CREDENCIALES_CLAUDE) delete extra[n];
      const env = {
        ...extra,
        ...(spec.compactarPct ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(spec.compactarPct) } : {}),
        ...cuenta.entorno({ home: lugar.base, configDir: lugar.config, tmp: lugar.tmp, credencial }),
      };
      return { file: c.file, args: c.args, env, stdin: spec.prompt, archivoMcp };
    },
    lector() {
      return {
        pasosPropios: true,
        linea(linea, r, emitir = () => {}) {
          let m;
          try { m = JSON.parse(linea); } catch { return; }
          if (m.type === 'system' && m.subtype === 'init') r.sessionId = m.session_id ?? r.sessionId;
          if (m.type === 'assistant') {
            if (m.error) r.codigoError = m.error;
            // Tamaño del contexto: lo que entró en el último pedido al modelo (con lo cacheado).
            const u = m.message?.usage;
            if (u) r.contexto = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            for (const b of m.message?.content ?? []) {
              if (b.type === 'tool_use') { r.herramientas.push(b.name); emitir({ tipo: 'herramienta', nombre: b.name, entrada: b.input, ref: b.id }); }
              if (b.type === 'text') emitir({ tipo: 'texto', texto: b.text });
            }
          }
          if (m.type === 'user') {
            for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
              if (b.type !== 'tool_result') continue;
              const salida = Array.isArray(b.content) ? b.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n') : String(b.content ?? '');
              emitir({ tipo: 'resultado', ref: b.tool_use_id, salida, error: !!b.is_error });
            }
          }
          if (m.type === 'result') {
            r.sessionId = m.session_id ?? r.sessionId;
            r.resultado = String(m.result ?? '');
            const u = m.usage ?? {};
            r.uso = {
              entrada: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cache: u.cache_read_input_tokens ?? 0,
              salida: u.output_tokens ?? 0, costo: Number(m.total_cost_usd ?? 0), turnos: m.num_turns ?? null, contexto: r.contexto ?? null,
            };
            r.ok = !m.is_error;
            if (m.is_error) r.error = r.resultado || m.subtype;
          }
        },
      };
    },
  };
}

/**
 * Ejecutor de Claude solo (compatibilidad): `cuenta` da el entorno limpio y el comando (claude/cuenta.mjs),
 * `aislamiento` el usuario y la carpeta de la conversación. `lanzar` permite reemplazar spawn en los tests.
 */
export function crearEjecutor({ cuenta, aislamiento, lanzar, log = console }) {
  return crearEjecutorComun({ adaptadores: { claude: crearAdaptadorClaude({ cuenta }), 'claude-api': crearAdaptadorClaude({ cuenta, credencial: 'api' }) }, aislamiento, lanzar, log });
}
