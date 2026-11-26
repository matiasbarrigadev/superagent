// Adaptador de OpenCode (opencode-ai, versión 1, fija): abre DeepSeek, MiniMax, Kimi, Qwen, OpenRouter y otros
// proveedores con la clave de cada uno. Corre `opencode run --format json` con el usuario y la carpeta de la
// conversación, como Claude.
//
// Seguridad (verificado con corridas reales):
// - La config va inline (OPENCODE_CONFIG_CONTENT, la de mayor precedencia) y la del proyecto se ignora
//   (OPENCODE_DISABLE_PROJECT_CONFIG): lo que el agente escriba en su carpeta no cambia corridas futuras.
// - La config global (XDG_CONFIG_HOME) apunta a una carpeta vacía del gateway, que la corrida no puede escribir.
// - Herramientas y permisos en listas explícitas: el comodín "*" cuelga la versión 1 al arrancar.
// - Sin preguntas: "question" apagada y external_directory/doom_loop en deny (si no, esperan a una persona).
// - Si el proveedor corta por límite, OpenCode reintenta para siempre sin decir nada por stdout: se lee el log de
//   errores y se corta la corrida.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ErrorMotor } from './ejecutor.mjs';

/** Variable de la clave de cada proveedor (models.dev). Los modelos "opencode/*-free" no necesitan clave. */
export const CLAVES_PROVEEDOR = {
  deepseek: 'DEEPSEEK_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  alibaba: 'DASHSCOPE_API_KEY',
  zai: 'ZHIPU_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  togetherai: 'TOGETHER_AI_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  opencode: 'OPENCODE_API_KEY',
};
export const claveDeProveedor = (proveedor) => CLAVES_PROVEEDOR[proveedor] ?? `${String(proveedor).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
export const MODELO_VALIDO = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][\w.:/@-]*$/;

// Todas las herramientas propias de OpenCode 1.x, para nombrarlas una por una.
const TODAS = ['bash', 'read', 'glob', 'grep', 'list', 'edit', 'write', 'patch', 'apply_patch', 'multiedit', 'task', 'webfetch', 'websearch', 'codesearch', 'todowrite', 'todoread', 'skill', 'lsp', 'batch', 'question'];
// De herramientas de Claude Code (lo que da cada rol) a las de OpenCode.
const EQUIVALENTES = {
  Read: ['read', 'list'], Glob: ['glob'], Grep: ['grep'],
  Edit: ['edit', 'patch', 'apply_patch', 'multiedit'], Write: ['write'], Bash: ['bash'],
  WebFetch: ['webfetch'], WebSearch: ['websearch'], Task: ['task'],
};
// Un argumento de proceso tiene tope (128 KB en Linux): un prompt más largo va como archivo adjunto.
const MAX_ARG = 100_000;

/** Config de OpenCode para una corrida (sin secretos: el token del MCP va por variable de entorno). */
export function configOpenCode(spec, { instrucciones = null } = {}) {
  const tools = Object.fromEntries(TODAS.map((t) => [t, false]));
  if (spec.completo) {
    for (const t of TODAS) tools[t] = true;
  } else {
    for (const h of spec.herramientasClaude ?? []) for (const t of EQUIVALENTES[h] ?? []) tools[t] = true;
    if (Object.values(tools).some(Boolean)) tools.todowrite = tools.todoread = true;
  }
  tools.question = false;
  const tiene = (t) => tools[t] === true;
  const mcp = {
    superagent: { type: 'remote', url: spec.mcp.url, enabled: true, headers: { Authorization: 'Bearer {env:SUPERAGENT_MCP_TOKEN}' } },
  };
  for (const [nombre, s] of Object.entries(spec.mcpExtra ?? {})) {
    if (s.type === 'stdio' || s.command) mcp[nombre] = { type: 'local', command: [s.command, ...(s.args ?? [])], enabled: true, ...(s.env ? { environment: s.env } : {}) };
    else if (s.url) mcp[nombre] = { type: 'remote', url: s.url, enabled: true, ...(s.headers ? { headers: s.headers } : {}) };
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    ...(instrucciones ? { instructions: [instrucciones] } : {}),
    share: 'disabled',
    autoupdate: false,
    mcp,
    tools,
    permission: {
      bash: tiene('bash') ? 'allow' : 'deny',
      edit: tiene('edit') || tiene('write') ? 'allow' : 'deny',
      webfetch: tiene('webfetch') ? 'allow' : 'deny',
      external_directory: spec.completo ? 'allow' : 'deny',
      doom_loop: 'deny',
    },
  };
}

export function clasificarErrorOpenCode(texto = '') {
  const t = String(texto);
  if (/session not found/i.test(t)) return 'sesion_perdida';
  if (/usage limit|limit reached|rate.?limit|quota|insufficient (balance|credit|funds)|payment required|\b402\b|\b429\b|exceeded/i.test(t)) return 'limite';
  if (/api.?key|unauthori[sz]ed|\b401\b|\b403\b|authenticat|invalid.*(key|token)|no credentials/i.test(t)) return 'sin_sesion';
  return 'otro';
}

/**
 * `clave(nombre)`: valor de una variable cifrada del entorno (las claves de los proveedores se cargan en el panel).
 * `dirConfigVacio`: carpeta del gateway, vacía y de solo lectura para las corridas.
 */
export function crearAdaptadorOpenCode({ bin = 'opencode', clave = () => null, dirConfigVacio }) {
  const comando = (args) => {
    if (process.platform === 'win32') return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args] };
    return { file: '/bin/sh', args: ['-c', 'umask 077 && exec "$0" "$@"', bin, ...args] };
  };
  return {
    id: 'opencode',
    nombre: 'OpenCode',
    familia: 'opencode',
    puedeNegar: new Set(Object.keys(EQUIVALENTES)),
    clasificarError: clasificarErrorOpenCode,
    /** Qué falta para correr un modelo (null si nada). */
    falta(modelo) {
      if (!modelo || !MODELO_VALIDO.test(modelo)) return 'un modelo con la forma proveedor/modelo (por ejemplo deepseek/deepseek-chat)';
      const prov = modelo.split('/')[0];
      if (prov === 'opencode' && /-free$/.test(modelo)) return null;
      const v = claveDeProveedor(prov);
      return clave(v) ? null : `la clave ${v}`;
    },
    preparar({ spec, lugar, aislamiento, sesion, nueva }) {
      const modelo = spec.modelo;
      const falta = this.falta(modelo);
      if (falta) throw new ErrorMotor('sin_sesion', `OpenCode no puede correr ${modelo ?? '(sin modelo)'}: falta ${falta}. Se carga en el panel → Variables de entorno (el agente la pide con pedir_variable).`);
      const prov = modelo.split('/')[0];
      // OpenCode crea <XDG_CONFIG_HOME>/opencode si no está: va creada por el gateway, vacía y de solo lectura.
      fs.mkdirSync(path.join(dirConfigVacio, 'opencode'), { recursive: true, mode: 0o755 });
      const instr = path.join(lugar.base, spec.completo ? `opencode-sistema-${crypto.randomUUID()}.md` : 'opencode-sistema.md');
      const nota = `\n\n(Corrés en OpenCode con el modelo ${modelo}. Las herramientas del gateway se llaman superagent_<nombre>: por ejemplo superagent_responder.)`;
      aislamiento.escribirArchivo(instr, `${spec.sistema ?? ''}${nota}`, lugar.usuario);
      const datos = path.join(lugar.config, 'opencode');
      const env = {
        ...(spec.completo ? spec.entornoExtra ?? {} : {}),
        PATH: process.env.PATH, LANG: 'C.UTF-8', TERM: 'xterm-256color',
        HOME: lugar.base, TMPDIR: lugar.tmp,
        XDG_CONFIG_HOME: dirConfigVacio,
        XDG_DATA_HOME: path.join(datos, 'datos'), XDG_STATE_HOME: path.join(datos, 'estado'), XDG_CACHE_HOME: path.join(datos, 'cache'),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(configOpenCode(spec, { instrucciones: instr })),
        OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_PURE: '1',
        ...(spec.completo ? {} : { OPENCODE_DISABLE_CLAUDE_CODE: '1' }),
        SUPERAGENT_MCP_TOKEN: spec.mcp.token,
        BROWSER: '/bin/false',
      };
      const k = clave(claveDeProveedor(prov));
      if (k) env[claveDeProveedor(prov)] = k;
      if (process.platform === 'win32') Object.assign(env, { SystemRoot: process.env.SystemRoot, USERPROFILE: lugar.base, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: lugar.tmp });
      const args = ['run', '--format', 'json', '--print-logs', '--log-level', 'ERROR', '-m', modelo];
      if (!nueva && sesion) args.push('--session', sesion);
      let archivoPrompt = null;
      if (Buffer.byteLength(spec.prompt ?? '') > MAX_ARG) {
        archivoPrompt = path.join(lugar.base, 'opencode-pedido.md');
        aislamiento.escribirArchivo(archivoPrompt, spec.prompt, lugar.usuario);
        args.push('-f', archivoPrompt, '--', 'El pedido completo está en el archivo adjunto: respondé a eso.');
      } else {
        args.push('--', spec.prompt ?? '');
      }
      const c = comando(args);
      // archivoMcp: lo que el ejecutor borra al terminar (acá, el archivo de instrucciones de esta corrida).
      return { file: c.file, args: c.args, env, stdin: '', archivoMcp: spec.completo ? instr : null };
    },
    lector() {
      let textoPaso = [];
      let ultimoTexto = '';
      return {
        linea(linea, r) {
          let m;
          try { m = JSON.parse(linea); } catch { return; }
          if (m.sessionID) r.sessionId = m.sessionID;
          const p = m.part ?? {};
          if (m.type === 'step_start') textoPaso = [];
          if (m.type === 'text' && p.text) { textoPaso.push(p.text); ultimoTexto = textoPaso.join('\n'); }
          if (m.type === 'tool_use' && p.tool) r.herramientas.push(p.tool.startsWith('superagent_') ? `mcp__superagent__${p.tool.slice(11)}` : p.tool);
          if (m.type === 'step_finish') {
            const t = p.tokens ?? {};
            const u = r.uso ?? { entrada: 0, cache: 0, salida: 0, costo: 0, turnos: 0, contexto: null };
            u.entrada += (t.input ?? 0) + (t.cache?.write ?? 0);
            u.cache += t.cache?.read ?? 0;
            u.salida += (t.output ?? 0) + (t.reasoning ?? 0);
            u.costo += Number(p.cost ?? 0);
            u.turnos += 1;
            u.contexto = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
            r.uso = u;
          }
          if (m.type === 'error') {
            const e = m.error ?? {};
            r.error = String(e.data?.message ?? e.message ?? e.name ?? 'error de OpenCode');
            r.codigoError = e.name ?? null;
          }
        },
        // Los errores del proveedor solo aparecen en el log: un límite o una clave mala se reintentan para siempre.
        stderr(linea, r) {
          if (!/level=ERROR/.test(linea)) return null;
          const m = /error\.error="([^"]*)"/.exec(linea) ?? /message="([^"]*)"/.exec(linea);
          const texto = m?.[1] ?? linea;
          const tipo = clasificarErrorOpenCode(texto);
          if (tipo === 'limite' || tipo === 'sin_sesion') { r.error = `OpenCode: ${texto.slice(0, 500)}`; return tipo; }
          return null;
        },
        cerrar(r, { codigo }) {
          r.resultado = ultimoTexto;
          r.ok = codigo === 0 && !r.error;
        },
      };
    },
  };
}
