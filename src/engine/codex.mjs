// Adaptador de Codex (@openai/codex, versión fija): con la cuenta de ChatGPT del Propietario (login por dispositivo,
// como `claude setup-token`) o con una clave de API (CODEX_API_KEY). Corre `codex exec --json` con el usuario y la
// carpeta de la conversación.
//
// Seguridad (verificado contra un modelo falso que registra lo que Codex le ofrece):
// - La config va en CODEX_HOME de la corrida y se reescribe en cada corrida; la del proyecto (.codex/) no se usa
//   porque la carpeta no es de confianza.
// - Sin terminal: features shell_tool y unified_exec apagadas. Codex no tiene herramienta propia de leer archivos:
//   lee con la terminal, así que un rol sin terminal tampoco lee (nunca tiene más de lo que da el rol).
// - Apagado lo que no se puede limitar por rol: apps, plugins, navegador, computer use, imágenes, hooks, memorias,
//   objetivos, daemon. Subagentes solo con permiso de delegar.
// - Las herramientas del gateway (MCP) se aprueban solas: con approval_policy "never" fallarían.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cifrar, descifrar } from '../auth/cripto.mjs';
import { ErrorMotor } from './ejecutor.mjs';

const toml = (v) => JSON.stringify(String(v));
const APAGADAS = ['apps', 'plugins', 'browser_use', 'computer_use', 'image_generation', 'hooks', 'memories', 'goals', 'in_app_browser', 'skill_search', 'tool_suggest', 'sleep_tool', 'daemon_auto_start', 'remote_plugin', 'skill_mcp_dependency_install'];

/** config.toml de una corrida (sin secretos: el token del MCP va por variable de entorno). */
export function configCodex(spec, { modelo = null } = {}) {
  const tiene = new Set(spec.herramientasClaude ?? []);
  const terminal = spec.completo || tiene.has('Bash');
  const l = [
    'cli_auth_credentials_store = "file"',
    'approval_policy = "never"',
    `sandbox_mode = ${toml(terminal ? 'danger-full-access' : 'read-only')}`,
    `web_search = ${toml(spec.completo || tiene.has('WebSearch') ? 'live' : 'disabled')}`,
    'check_for_update_on_startup = false',
    ...(modelo ? [`model = ${toml(modelo)}`] : []),
    ...(spec.sistema ? [`developer_instructions = ${toml(spec.sistema)}`] : []),
    '',
    '[features]',
    `shell_tool = ${terminal}`,
    `unified_exec = ${terminal}`,
    `view_image = ${spec.completo || tiene.has('Read')}`,
    ...(spec.completo ? ['daemon_auto_start = false'] : APAGADAS.map((f) => `${f} = false`)),
    '',
    '[agents]',
    `enabled = ${!!(spec.completo || tiene.has('Task'))}`,
    '',
    '[mcp_servers.superagent]',
    `url = ${toml(spec.mcp.url)}`,
    'bearer_token_env_var = "SUPERAGENT_MCP_TOKEN"',
    'default_tools_approval_mode = "approve"',
  ];
  for (const [nombre, s] of Object.entries(spec.mcpExtra ?? {})) {
    l.push('', `[mcp_servers.${nombre}]`);
    if (s.command) { l.push(`command = ${toml(s.command)}`, `args = [${(s.args ?? []).map(toml).join(', ')}]`); }
    else if (s.url) l.push(`url = ${toml(s.url)}`);
    l.push('default_tools_approval_mode = "approve"');
  }
  return `${l.join('\n')}\n`;
}

export function clasificarErrorCodex(texto = '') {
  const t = String(texto);
  if (/no rollout found|thread\/resume failed|session .*not found/i.test(t)) return 'sesion_perdida';
  if (/usage limit|rate.?limit|\b429\b|quota|insufficient_quota|limit reached|try again (in|at)/i.test(t)) return 'limite';
  if (/\b401\b|unauthori[sz]ed|not logged in|missing bearer|invalid api key|authenticat|refresh token|log ?in again/i.test(t)) return 'sin_sesion';
  return 'otro';
}

/**
 * Cuenta de ChatGPT para Codex: `codex login --device-auth` corre en una carpeta del gateway; el link y el código
 * se muestran en el panel (o el agente los manda por WhatsApp). El auth.json queda cifrado en la base y cada
 * corrida recibe una copia; si Codex lo renueva, se guarda la versión nueva.
 */
export function crearCuentaCodex({ config, ajustes, bin = 'codex', lanzar = spawn, log = console }) {
  const dir = path.join(config.dataDir ?? '.', 'codex-login');
  let login = null;
  const leer = () => { const s = ajustes.get('codex_auth'); if (!s) return null; try { return descifrar(config.sessionSecret, s, 'codex-auth'); } catch { return null; } };
  const guardar = (json) => { ajustes.set('codex_auth', cifrar(config.sessionSecret, json, 'codex-auth')); ajustes.set('codex_auth_guardado', String(Date.now())); };
  return {
    authJson: leer,
    conectada: () => !!leer(),
    /** Después de una corrida: si Codex renovó el token, se guarda. */
    actualizar(json) { if (json && json !== leer()) { try { JSON.parse(json); guardar(json); } catch {} } },
    desconectar() { ajustes.set('codex_auth', null); ajustes.set('codex_auth_guardado', null); },
    estado() {
      return { conectada: !!leer(), guardada: Number(ajustes.get('codex_auth_guardado')) || null, login: login ? { url: login.url, codigo: login.codigo, vence: login.vence } : null };
    },
    /** Arranca el login por dispositivo y devuelve { url, codigo } apenas Codex los muestra. */
    iniciarLogin({ alTerminar = () => {}, esperaMs = 30_000 } = {}) {
      if (login?.hijo) try { login.hijo.kill(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const env = { PATH: process.env.PATH, HOME: dir, CODEX_HOME: dir, LANG: 'C.UTF-8', NO_COLOR: '1', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, USERPROFILE: dir, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA } : {}) };
      fs.writeFileSync(path.join(dir, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
      const c = process.platform === 'win32' ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', bin, 'login', '--device-auth'] } : { file: bin, args: ['login', '--device-auth'] };
      const hijo = lanzar(c.file, c.args, { env, cwd: dir, windowsHide: true });
      const l = { hijo, salida: '', url: null, codigo: null, vence: Date.now() + 15 * 60_000 };
      login = l;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { if (!l.url) { try { hijo.kill(); } catch {} reject(new Error('Codex no mostró el link de login a tiempo.')); } }, esperaMs);
        const ver = (d) => {
          l.salida = (l.salida + String(d).replace(/\x1b\[[0-9;]*m/g, '')).slice(-8000);
          if (!l.url) {
            const u = /https:\/\/auth\.openai\.com\/[^\s]+/.exec(l.salida)?.[0];
            const k = /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/.exec(l.salida)?.[1];
            if (u && k) { l.url = u; l.codigo = k; clearTimeout(t); resolve({ url: u, codigo: k }); }
          }
        };
        hijo.stdout?.on('data', ver);
        hijo.stderr?.on('data', ver);
        hijo.on('error', (e) => { clearTimeout(t); reject(e); });
        hijo.on('close', (codigo) => {
          clearTimeout(t);
          let ok = false;
          try { const a = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'); JSON.parse(a); guardar(a); ok = true; } catch {}
          fs.rmSync(dir, { recursive: true, force: true });
          if (login === l) login = null;
          if (!l.url) reject(new Error(`No se pudo iniciar el login de Codex (código ${codigo}).`));
          log.log?.(`[codex] login ${ok ? 'listo: cuenta de ChatGPT guardada' : 'terminó sin cuenta'}`);
          alTerminar(ok);
        });
      });
    },
    cancelarLogin() { if (login?.hijo) try { login.hijo.kill(); } catch {} login = null; },
  };
}

/** `clave(nombre)`: variable cifrada del entorno. `cuenta`: la de ChatGPT (crearCuentaCodex), opcional. */
/** `argsPruebas`: overrides -c (para las pruebas: un proveedor falso). */
export function crearAdaptadorCodex({ bin = 'codex', clave = () => null, cuenta = null, argsPruebas = [] }) {
  const comando = (args) => {
    if (process.platform === 'win32') return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args] };
    return { file: '/bin/sh', args: ['-c', 'umask 077 && exec "$0" "$@"', bin, ...args] };
  };
  return {
    id: 'codex',
    nombre: 'Codex',
    familia: 'codex',
    // Saca de verdad la terminal (y con ella la lectura), la web, la edición y los subagentes. WebFetch no existe.
    puedeNegar: new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'Task']),
    clasificarError: clasificarErrorCodex,
    falta() {
      return cuenta?.conectada() || clave('CODEX_API_KEY') ? null : 'conectar la cuenta de ChatGPT (panel → Motores) o la clave CODEX_API_KEY';
    },
    preparar({ spec, lugar, aislamiento, sesion, nueva }) {
      const falta = this.falta();
      if (falta) throw new ErrorMotor('sin_sesion', `Codex no está conectado: falta ${falta}.`);
      const home = path.join(lugar.config, 'codex');
      if (!fs.existsSync(home)) aislamiento.asegurarDir?.(home, lugar.usuario) ?? fs.mkdirSync(home, { recursive: true });
      const nota = `\n\n(Corrés en Codex. Las herramientas del gateway están en el servidor MCP "superagent": por ejemplo responder.)`;
      aislamiento.escribirArchivo(path.join(home, 'config.toml'), configCodex({ ...spec, sistema: `${spec.sistema ?? ''}${nota}` }, { modelo: spec.modelo }), lugar.usuario);
      const auth = cuenta?.authJson();
      const archivoAuth = path.join(home, 'auth.json');
      if (auth) aislamiento.escribirArchivo(archivoAuth, auth, lugar.usuario);
      else fs.rmSync(archivoAuth, { force: true });
      const env = {
        ...(spec.completo ? spec.entornoExtra ?? {} : {}),
        PATH: process.env.PATH, LANG: 'C.UTF-8', TERM: 'xterm-256color',
        HOME: lugar.base, TMPDIR: lugar.tmp, CODEX_HOME: home,
        SUPERAGENT_MCP_TOKEN: spec.mcp.token,
        BROWSER: '/bin/false', NO_COLOR: '1',
      };
      delete env.OPENAI_API_KEY;
      if (!auth && clave('CODEX_API_KEY')) env.CODEX_API_KEY = clave('CODEX_API_KEY');
      if (process.platform === 'win32') Object.assign(env, { SystemRoot: process.env.SystemRoot, USERPROFILE: lugar.base, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: lugar.tmp });
      // El prompt va por stdin ("-"): no tiene el tope de largo de un argumento.
      const args = ['exec', '--json', '--skip-git-repo-check', ...argsPruebas, ...(nueva || !sesion ? ['-'] : ['resume', sesion, '-'])];
      const c = comando(args);
      // Al terminar, el ejecutor llama a alTerminar: si Codex renovó la cuenta, se guarda.
      // Con la cuenta de ChatGPT no hay costo aparte; con clave de API, Codex no informa el precio.
      return { file: c.file, args: c.args, env, stdin: spec.prompt ?? '', sinCosto: !auth, alTerminar: () => { if (auth) { try { cuenta.actualizar(fs.readFileSync(archivoAuth, 'utf8')); } catch {} fs.rmSync(archivoAuth, { force: true }); } } };
    },
    lector() {
      let ultimo = '';
      return {
        linea(linea, r) {
          let m;
          try { m = JSON.parse(linea); } catch { return; }
          if (m.type === 'thread.started') r.sessionId = m.thread_id ?? r.sessionId;
          const it = m.item ?? {};
          if (m.type === 'item.completed' && it.type === 'agent_message') ultimo = String(it.text ?? '');
          if (m.type === 'item.started' && it.type === 'mcp_tool_call') r.herramientas.push(`mcp__${it.server}__${it.tool}`);
          if (m.type === 'item.started' && it.type === 'command_execution') r.herramientas.push('Bash');
          if (m.type === 'turn.completed') {
            const u = m.usage ?? {};
            const prev = r.uso ?? { entrada: 0, cache: 0, salida: 0, costo: 0, turnos: 0, contexto: null };
            prev.entrada += Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0));
            prev.cache += u.cached_input_tokens ?? 0;
            prev.salida += (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
            prev.turnos += 1;
            prev.contexto = u.input_tokens ?? null;
            r.uso = prev;
          }
          if (m.type === 'turn.failed') { r.error = String(m.error?.message ?? 'Codex falló'); }
          if (m.type === 'error' && !r.error) r.ultimoAviso = String(m.message ?? '');
        },
        cerrar(r, { codigo }) {
          r.resultado = ultimo;
          if (!r.error && codigo !== 0) r.error = r.ultimoAviso || null;
          r.ok = codigo === 0 && !r.error;
        },
      };
    },
  };
}
