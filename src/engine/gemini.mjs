// Adaptador de Gemini CLI (@google/gemini-cli, versión fija), con GEMINI_API_KEY (Google AI Studio: tiene capa
// gratis). Corre `gemini -p … -o stream-json` con el usuario y la carpeta de la conversación.
//
// Seguridad (verificado en Linux contra un modelo falso que registra lo que Gemini le ofrece):
// - Lo que importa va en el archivo de "sistema" (GEMINI_CLI_SYSTEM_SETTINGS_PATH), que le gana a todo lo demás y
//   que Gemini solo acepta en una carpeta de root: herramientas excluidas, servidores MCP permitidos, sin hooks.
// - La config del proyecto (<carpeta>/.gemini) se borra antes de cada corrida; aunque el agente la vuelva a
//   escribir, no suma herramientas, servidores ni hooks.
// - Sin preguntas a una persona: ask_user excluida y aprobación automática (--approval-mode yolo) de lo que el rol sí
//   tiene. La carpeta se trata como de confianza (--skip-trust); si no, Gemini no corre sin terminal interactiva.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ErrorMotor } from './ejecutor.mjs';

const TODAS = ['update_topic', 'list_directory', 'read_file', 'read_many_files', 'grep_search', 'glob', 'replace', 'write_file', 'web_fetch', 'run_shell_command', 'list_background_processes', 'read_background_output', 'google_web_search', 'write_todos', 'enter_plan_mode', 'exit_plan_mode', 'invoke_agent', 'activate_skill', 'save_memory', 'ask_user'];
const EQUIVALENTES = {
  Read: ['read_file', 'read_many_files', 'list_directory'], Glob: ['glob'], Grep: ['grep_search'],
  Edit: ['replace'], Write: ['write_file'], Bash: ['run_shell_command', 'list_background_processes', 'read_background_output'],
  WebFetch: ['web_fetch'], WebSearch: ['google_web_search'], Task: ['invoke_agent'],
};
const SIEMPRE_FUERA = ['ask_user', 'save_memory', 'activate_skill', 'enter_plan_mode', 'exit_plan_mode', 'update_topic'];
const MAX_ARG = 100_000;

/** Herramientas propias de Gemini que quedan afuera para este rol. */
export function excluidasGemini(spec) {
  if (spec.completo) return [...SIEMPRE_FUERA];
  const permitidas = new Set();
  for (const h of spec.herramientasClaude ?? []) for (const t of EQUIVALENTES[h] ?? []) permitidas.add(t);
  if (permitidas.size) permitidas.add('write_todos');
  return TODAS.filter((t) => !permitidas.has(t) || SIEMPRE_FUERA.includes(t));
}

/** Settings de "sistema" de una corrida (sin secretos: el token del MCP se toma del entorno). */
export function configGemini(spec) {
  const mcpServers = { superagent: { httpUrl: spec.mcp.url, headers: { Authorization: 'Bearer $SUPERAGENT_MCP_TOKEN' }, trust: true } };
  for (const [nombre, s] of Object.entries(spec.mcpExtra ?? {})) {
    if (s.command) mcpServers[nombre] = { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}), trust: true };
    else if (s.url) mcpServers[nombre] = { httpUrl: s.url, ...(s.headers ? { headers: s.headers } : {}), trust: true };
  }
  return {
    tools: { exclude: excluidasGemini(spec) },
    mcp: { allowed: Object.keys(mcpServers) },
    mcpServers,
    hooksConfig: { enabled: false },
    security: { auth: { selectedType: 'gemini-api-key' }, folderTrust: { enabled: false } },
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
  };
}

export function clasificarErrorGemini(texto = '') {
  const t = String(texto);
  if (/invalid session identifier|error resuming session/i.test(t)) return 'sesion_perdida';
  if (/\b429\b|resource.?exhausted|quota|rate.?limit|too many requests/i.test(t)) return 'limite';
  if (/api key not valid|api_key_invalid|\b401\b|\b403\b|permission.?denied|unauthenticated|no api key|GEMINI_API_KEY/i.test(t)) return 'sin_sesion';
  return 'otro';
}

/** `dirSistema`: carpeta de root (0755) para los settings de sistema de cada corrida. */
/** `entornoPruebas`: variables extra (para las pruebas: GOOGLE_GEMINI_BASE_URL de un modelo falso). */
export function crearAdaptadorGemini({ bin = 'gemini', clave = () => null, dirSistema, entornoPruebas = {} }) {
  const comando = (args) => {
    if (process.platform === 'win32') return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args] };
    return { file: '/bin/sh', args: ['-c', 'umask 077 && exec "$0" "$@"', bin, ...args] };
  };
  return {
    id: 'gemini',
    nombre: 'Gemini',
    familia: 'gemini',
    puedeNegar: new Set(Object.keys(EQUIVALENTES)),
    clasificarError: clasificarErrorGemini,
    falta() { return clave('GEMINI_API_KEY') ? null : 'la clave GEMINI_API_KEY (Google AI Studio)'; },
    preparar({ spec, lugar, aislamiento, sesion, nueva }) {
      const falta = this.falta();
      if (falta) throw new ErrorMotor('sin_sesion', `Gemini no puede correr: falta ${falta}. Se carga en el panel → Variables de entorno.`);
      fs.mkdirSync(dirSistema, { recursive: true, mode: 0o755 });
      const sistema = path.join(dirSistema, `${crypto.randomUUID()}.json`);
      fs.writeFileSync(sistema, JSON.stringify(configGemini(spec)), { mode: 0o644 });
      // Lo que el agente haya dejado como config del proyecto no se usa.
      fs.rmSync(path.join(lugar.trabajo, '.gemini'), { recursive: true, force: true });
      const home = path.join(lugar.config, 'gemini');
      if (!fs.existsSync(home)) aislamiento.asegurarDir?.(home, lugar.usuario) ?? fs.mkdirSync(home, { recursive: true });
      const dotGemini = path.join(home, '.gemini');
      if (!fs.existsSync(dotGemini)) aislamiento.asegurarDir?.(dotGemini, lugar.usuario) ?? fs.mkdirSync(dotGemini, { recursive: true });
      // Las instrucciones van como contexto global (GEMINI.md de su home): se suman al prompt de Gemini.
      const nota = '\n\n(Corrés en Gemini CLI. Las herramientas del gateway se llaman mcp_superagent_<nombre>: por ejemplo mcp_superagent_responder.)';
      aislamiento.escribirArchivo(path.join(dotGemini, 'GEMINI.md'), `${spec.sistema ?? ''}${nota}`, lugar.usuario);
      aislamiento.escribirArchivo(path.join(dotGemini, 'settings.json'), '{}', lugar.usuario);
      const env = {
        ...(spec.completo ? spec.entornoExtra ?? {} : {}),
        PATH: process.env.PATH, LANG: 'C.UTF-8', TERM: 'xterm-256color',
        HOME: lugar.base, TMPDIR: lugar.tmp,
        GEMINI_CLI_HOME: home, GEMINI_CLI_SYSTEM_SETTINGS_PATH: sistema,
        GEMINI_API_KEY: clave('GEMINI_API_KEY'),
        SUPERAGENT_MCP_TOKEN: spec.mcp.token,
        BROWSER: '/bin/false', NO_COLOR: '1',
        ...entornoPruebas,
      };
      delete env.GOOGLE_API_KEY;
      if (process.platform === 'win32') Object.assign(env, { SystemRoot: process.env.SystemRoot, USERPROFILE: lugar.base, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: lugar.tmp });
      const args = ['-o', 'stream-json', '--approval-mode', 'yolo', '--skip-trust', '--allowed-mcp-server-names', ...Object.keys(configGemini(spec).mcpServers)];
      if (spec.modelo) args.push('-m', spec.modelo);
      if (sesion) args.push(nueva ? '--session-id' : '--resume', sesion);
      const largo = Buffer.byteLength(spec.prompt ?? '') > MAX_ARG;
      args.push('-p', largo ? '' : spec.prompt ?? '');
      const c = comando(args);
      return { file: c.file, args: c.args, env, stdin: largo ? spec.prompt : '', alTerminar: () => fs.rmSync(sistema, { force: true }) };
    },
    lector() {
      let texto = '';
      return {
        linea(linea, r) {
          let m;
          try { m = JSON.parse(linea); } catch { return; }
          if (m.session_id) r.sessionId = m.session_id;
          if (m.type === 'tool_use' && m.tool_name) r.herramientas.push(m.tool_name.startsWith('mcp_superagent_') ? `mcp__superagent__${m.tool_name.slice(15)}` : m.tool_name);
          if (m.type === 'message' && m.role === 'assistant') texto = m.delta ? texto + String(m.content ?? '') : String(m.content ?? '');
          if (m.type === 'message' && m.role === 'user') texto = '';
          if (m.type === 'error') r.error = String(m.message ?? m.error?.message ?? 'error de Gemini');
          if (m.type === 'result') {
            const s = m.stats ?? {};
            r.uso = { entrada: Math.max(0, (s.input_tokens ?? 0) - (s.cached ?? 0)), cache: s.cached ?? 0, salida: s.output_tokens ?? 0, costo: null, turnos: s.tool_calls ?? null, contexto: s.input_tokens ?? null };
            if (m.status && m.status !== 'success') r.error = r.error || String(m.error?.message ?? m.status);
          }
        },
        // Una cuota agotada o una clave mala se reintentan con espera: se corta apenas aparece en el log.
        stderr(linea, r) {
          // Sin el archivo de sistema no hay restricciones: la corrida no sigue.
          if (/skipping system settings/i.test(linea)) { r.error = 'Gemini ignoró la config de seguridad (la carpeta de sistema no es de root): no se corre.'; return 'otro'; }
          const tipo = /error|status|quota|429|401|403/i.test(linea) ? clasificarErrorGemini(linea) : 'otro';
          if (tipo === 'limite' || tipo === 'sin_sesion') { r.error = `Gemini: ${linea.trim().slice(0, 500)}`; return tipo; }
          return null;
        },
        cerrar(r, { codigo }) {
          r.resultado = texto;
          r.ok = codigo === 0 && !r.error;
        },
      };
    },
  };
}
