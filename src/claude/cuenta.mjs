// Cuenta de Claude del Propietario. Se conecta con el comando oficial `claude setup-token` en la terminal web:
// el gateway captura el token de larga duración que imprime, lo guarda cifrado y no lo muestra en pantalla.
// Cada corrida lo recibe por entorno (CLAUDE_CODE_OAUTH_TOKEN), con su propia carpeta y su propio usuario,
// así no hay una carpeta de credenciales compartida entre conversaciones.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { cifrar, descifrar } from '../auth/cripto.mjs';

const RE_TOKEN = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

export function usuarioSO(nombre) {
  if (process.platform === 'win32') return null;
  try {
    const uid = Number(execFileSync('id', ['-u', nombre], { encoding: 'utf8' }).trim());
    const gid = Number(execFileSync('id', ['-g', nombre], { encoding: 'utf8' }).trim());
    const home = execFileSync('sh', ['-c', `getent passwd ${nombre} | cut -d: -f6`], { encoding: 'utf8' }).trim() || `/home/${nombre}`;
    return { nombre, uid, gid, home };
  } catch {
    return null;
  }
}

/** Saca de un texto cualquier token de Claude (para lo que se muestra en la terminal y en los logs). */
export const tacharToken = (t) => String(t).replace(new RegExp(RE_TOKEN.source, 'g'), '[token guardado]');

export function crearCuentaClaude({ config, log = console, pty = null, ajustes = null }) {
  const usuario = usuarioSO(config.claude.usuarioSO);
  const esRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (process.platform !== 'win32' && !(usuario && esRoot)) {
    log.warn(`[claude] Aviso: el gateway no corre como root o no existe el usuario "${config.claude.usuarioSO}". Las corridas usan el mismo usuario del gateway (solo aceptable en desarrollo).`);
  }
  const comoAgente = usuario && esRoot ? { uid: usuario.uid, gid: usuario.gid } : {};
  const dirLogin = path.join(config.dataDir ?? '.', 'claude', 'login');

  // --- Token guardado (cifrado con el secreto de sesión del gateway).
  function tokenActual() {
    const sobre = ajustes?.get('claude_token');
    if (!sobre) return null;
    try { return descifrar(config.sessionSecret, sobre, 'claude-token'); } catch { return null; }
  }
  function guardarToken(token) {
    ajustes.set('claude_token', cifrar(config.sessionSecret, token, 'claude-token'));
    ajustes.set('claude_token_guardado', String(Date.now()));
  }

  /** Entorno limpio de una corrida: nada del gateway, solo lo que Claude Code necesita. */
  function entorno({ home, configDir, tmp }) {
    const base = {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      TERM: 'xterm-256color',
      HOME: home,
      CLAUDE_CONFIG_DIR: configDir,
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
    };
    if (tmp) base.TMPDIR = tmp;
    const token = tokenActual();
    if (token) base.CLAUDE_CODE_OAUTH_TOKEN = token;
    if (process.platform === 'win32') {
      return { ...base, SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: tmp ?? process.env.TEMP };
    }
    return { ...base, BROWSER: '/bin/false' };
  }

  // En Linux, todo arranca con umask 077 (lo que crea la corrida no lo lee nadie más).
  // En Windows (desarrollo) "claude" puede ser un .cmd: se resuelve por la shell.
  const comando = (args) => {
    if (process.platform === 'win32') return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', config.claude.bin, ...args] };
    return { file: '/bin/sh', args: ['-c', 'umask 077 && exec "$0" "$@"', config.claude.bin, ...args] };
  };

  function prepararLogin() {
    fs.rmSync(dirLogin, { recursive: true, force: true });
    fs.mkdirSync(dirLogin, { recursive: true, mode: 0o700 });
    if (comoAgente.uid != null) {
      fs.chmodSync(path.dirname(dirLogin), 0o711);
      fs.chownSync(dirLogin, comoAgente.uid, comoAgente.gid);
    }
  }

  let terminal = null;
  let loginGuiado = null;
  // Verificación del token: una corrida mínima de Claude con ese token (la inyecta el servidor).
  let validar = null;
  let verificacion = null; // { ok, salida, en }: última verificación del token guardado
  let verificando = null;
  const VERIFICAR_CADA = 15 * 60_000;
  // Últimas líneas útiles de la salida del CLI, para explicar un error en el panel (el token ya viene tachado).
  const ultimas = (texto) => {
    const limpio = tacharToken(texto).replace(/[✶✻✽✢✳✘·*●⎿…]/g, ' ');
    const error = /(?:OAuth error|error)[:\s]+([^\n]+(?:\r?\n[^\n╭╰│]+)?)/i.exec(limpio);
    const linea = error ? error[1] : limpio.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-2).join(' ');
    return linea.replace(/\s+/g, ' ').trim().slice(0, 300);
  };

  /**
   * Porcentaje usado del plan (ventana de 5 h y semana), si la cuenta lo informa. Primero el endpoint de uso de la
   * cuenta; si el token no tiene ese alcance, los encabezados de límite de un pedido mínimo al modelo.
   * Devuelve { cincoHoras: { pct, reinicia }, semana: { pct, reinicia }, fuente } o null.
   */
  async function usoPlan({ fetch: f = globalThis.fetch } = {}) {
    const token = tokenActual();
    if (!token) return null;
    const base = { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' };
    const fecha = (v) => (v == null ? null : typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || null);
    try {
      const r = await f('https://api.anthropic.com/api/oauth/usage', { headers: base, signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const d = await r.json();
        const v = (x) => (x ? { pct: Number(x.utilization), reinicia: fecha(x.resets_at) } : null);
        if (d.five_hour || d.seven_day) return { cincoHoras: v(d.five_hour), semana: v(d.seven_day), fuente: 'cuenta' };
      }
    } catch { /* seguimos con los encabezados */ }
    try {
      const r = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { ...base, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, system: 'You are Claude Code, Anthropic\'s official CLI for Claude.', messages: [{ role: 'user', content: '.' }] }),
        signal: AbortSignal.timeout(15_000),
      });
      const h = (n) => r.headers.get(n);
      const pct = (v) => (v == null ? null : Number(v) <= 1.5 ? Number(v) * 100 : Number(v));
      const cinco = h('anthropic-ratelimit-unified-5h-utilization'), semana = h('anthropic-ratelimit-unified-7d-utilization');
      if (cinco != null || semana != null) {
        return {
          cincoHoras: cinco != null ? { pct: pct(cinco), reinicia: fecha(Number(h('anthropic-ratelimit-unified-5h-reset')) || h('anthropic-ratelimit-unified-5h-reset')) } : null,
          semana: semana != null ? { pct: pct(semana), reinicia: fecha(Number(h('anthropic-ratelimit-unified-7d-reset')) || h('anthropic-ratelimit-unified-7d-reset')) } : null,
          fuente: 'encabezados',
        };
      }
      log.info?.(`[claude] el plan no informa uso (HTTP ${r.status}); se usa solo lo medido por corrida`);
    } catch (e) { log.warn?.('[claude] uso del plan:', e.message); }
    return null;
  }

  /**
   * Pregunta corta al modelo más barato, sin herramientas (por ejemplo: "¿este mensaje del grupo es para el
   * agente?"). Devuelve el texto de la respuesta, o null si no se pudo.
   */
  async function preguntar({ sistema, texto, maxTokens = 5, modelo = 'claude-haiku-4-5', fetch: f = globalThis.fetch }) {
    const token = tokenActual();
    if (!token) return null;
    try {
      const r = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelo, max_tokens: maxTokens,
          system: [{ type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' }, { type: 'text', text: sistema }],
          messages: [{ role: 'user', content: texto }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) { log.warn?.(`[claude] pregunta corta: HTTP ${r.status}`); return null; }
      const d = await r.json();
      return (d.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    } catch (e) { log.warn?.('[claude] pregunta corta:', e.message); return null; }
  }

  return {
    tokenActual,
    entorno,
    comando,
    usoPlan,
    preguntar,

    /** El servidor pasa cómo probar un token (corrida mínima de Claude Code con el token en el entorno). */
    usarValidador(fn) { validar = fn; },

    estado() {
      const token = tokenActual();
      const guardado = Number(ajustes?.get('claude_token_guardado')) || null;
      // El token guardado se verifica solo, en segundo plano, cada tanto: no hace falta ningún botón.
      if (token && validar && !verificando && (!verificacion || Date.now() - verificacion.en > VERIFICAR_CADA)) {
        verificando = validar(token)
          .then((r) => { verificacion = { ok: r.ok, salida: r.salida, en: Date.now() }; })
          .catch((e) => { verificacion = { ok: false, salida: e.message, en: Date.now() }; })
          .finally(() => { verificando = null; });
      }
      return Promise.resolve({
        conectado: !!token,
        // null mientras se verifica; true si respondió; false si el token no funciona.
        funciona: token ? (verificacion ? verificacion.ok : null) : null,
        detalle: token && verificacion && !verificacion.ok ? verificacion.salida : null,
        instalado: true,
        metodo: token ? 'token' : null,
        guardado,
        // setup-token emite tokens de un año.
        vence: guardado ? guardado + 365 * 86_400_000 : null,
      });
    },

    async desconectar() {
      ajustes.set('claude_token', null);
      ajustes.set('claude_token_guardado', null);
      verificacion = null;
      return { ok: true };
    },

    /**
     * Terminal para `claude setup-token`. Una sola a la vez. La salida pasa a la pantalla con el token tachado;
     * se retienen los últimos caracteres por si el token llega partido entre dos pedazos.
     */
    abrirTerminal({ cols = 100, rows = 30, alDatos, alSalir, alToken = () => {}, alTokenInvalido = () => {} }) {
      if (!pty) throw new Error('node-pty no está disponible en este servidor.');
      this.cerrarTerminal();
      prepararLogin();
      const c = comando(['setup-token']);
      const p = pty.spawn(c.file, c.args, {
        // Ancha, para que el token no se corte en dos líneas.
        name: 'xterm-256color', cols: Math.max(cols, 220), rows,
        cwd: dirLogin,
        env: entorno({ home: dirLogin, configDir: dirLogin, tmp: null }),
        ...comoAgente,
      });
      terminal = p;
      let pendiente = '', visto = '', capturado = false;
      const RETENER = 160;
      const soltar = (todo) => {
        // Si aparece el comienzo de un token, se quitan los colores para que ninguna secuencia lo parta.
        const texto = tacharToken(/sk-ant/.test(pendiente.replace(ANSI, '')) ? pendiente.replace(ANSI, '') : pendiente);
        const corte = todo ? texto.length : Math.max(0, texto.length - RETENER);
        // No cortar en medio de un token ni de una secuencia ANSI: se suelta hasta el último salto o espacio.
        let fin = corte;
        if (!todo) { const s = Math.max(texto.lastIndexOf('\n', corte), texto.lastIndexOf(' ', corte)); fin = s > 0 ? s + 1 : 0; }
        if (fin > 0) { alDatos(texto.slice(0, fin)); pendiente = texto.slice(fin); }
      };
      // El token se toma recién cuando llegó entero (terminó su línea o el proceso). Si el CLI lo partió en varias
      // líneas, se prueban también las uniones con las líneas siguientes que son puro token. Antes de guardarlo se
      // prueba con una corrida real: se guarda el primero que funciona, y si ninguno funciona no se guarda nada.
      let guardando = null;
      const candidatos = (alFinal) => {
        const lineas = visto.split(/\r?\n|\r/).map((l) => l.trim());
        const i = lineas.findIndex((l) => RE_TOKEN.test(l));
        if (i < 0 || (i >= lineas.length - 1 && !alFinal)) return null;
        const base = RE_TOKEN.exec(lineas[i])[0];
        const lista = [base];
        if (lineas[i].endsWith(base)) {
          let t = base;
          for (let j = i + 1; j < lineas.length && /^[A-Za-z0-9_-]+$/.test(lineas[j]); j++) {
            if (j >= lineas.length - 1 && !alFinal) return null;
            t += lineas[j];
            lista.push(t);
          }
        }
        return lista;
      };
      const capturar = (alFinal) => {
        if (capturado) return;
        const lista = candidatos(alFinal);
        if (!lista) return;
        capturado = true;
        guardando = (async () => {
          let error = '';
          for (const t of lista) {
            const r = validar ? await validar(t).catch((e) => ({ ok: false, salida: e.message })) : { ok: true };
            if (r.ok) {
              guardarToken(t);
              verificacion = { ok: true, salida: '', en: Date.now() };
              alToken();
              log.log('[claude] token de larga duración probado y guardado');
              return true;
            }
            error = r.salida;
          }
          log.warn('[claude] el token generado no funcionó al probarlo: no se guardó');
          alTokenInvalido(error);
          return false;
        })();
      };
      p.onData((d) => {
        pendiente += d;
        // Las secuencias de control pasan a espacio: así no pegan el token con el texto que viene después.
        visto = (visto + d.replace(ANSI, ' ')).slice(-4000);
        capturar(false);
        soltar(false);
      });
      p.onExit(async ({ exitCode }) => {
        capturar(true);
        soltar(true);
        if (terminal === p) terminal = null;
        if (guardando) alDatos('\r\n\r\nProbando el token…\r\n');
        const ok = guardando ? await guardando : null;
        fs.rmSync(dirLogin, { recursive: true, force: true });
        if (ok === true) alDatos('\r\nListo: probé el token, funciona y quedó guardado cifrado. Ya podés cerrar esta terminal.\r\n');
        if (ok === false) alDatos('\r\nEl token que generó Claude no funcionó al probarlo, así que no se guardó. Probá conectar de nuevo.\r\n');
        alSalir(exitCode);
      });
      return {
        escribir: (d) => p.write(d),
        redimensionar: (c2, r2) => { try { p.resize(Math.max(c2, 220), r2); } catch {} },
        cerrar: () => { if (terminal === p) this.cerrarTerminal(); },
      };
    },

    /**
     * Login guiado, sin terminal: corre el mismo `claude setup-token` por detrás, devuelve el link de autorización
     * y después recibe el código que la persona pega en el panel. El token se captura igual que en la terminal.
     */
    iniciarLogin({ alToken = () => {}, esperaMs = 45_000 } = {}) {
      const sesion = { salida: '', url: null, token: false, fin: null, avisar: () => {} };
      const cambio = () => { const a = sesion.avisar; sesion.avisar = () => {}; a(); };
      sesion.t = this.abrirTerminal({
        cols: 4000, rows: 50,
        alDatos: (d) => {
          sesion.salida = (sesion.salida + d.replace(/\x1b\[\d*G/g, ' ').replace(ANSI, '').replace(/\x1b\]8;[^\x1b\x07]*(\x1b\\|\x07)/g, '')).slice(-8000);
          if (!sesion.url) {
            const m = /https:\/\/[^\s"'<>]*(oauth|authorize)[^\s"'<>]*/.exec(sesion.salida);
            if (m) { sesion.url = m[0]; cambio(); }
          }
          cambio();
        },
        alSalir: (codigo) => { sesion.fin = codigo; cambio(); },
        alToken: () => { sesion.token = true; alToken(); cambio(); },
        alTokenInvalido: (salida) => { sesion.invalido = salida || 'sin detalle'; cambio(); },
      });
      loginGuiado = sesion;
      const esperar = (listo, ms) => new Promise((resolve) => {
        const fin = setTimeout(() => resolve(false), ms);
        const mirar = () => { if (listo()) { clearTimeout(fin); resolve(true); } else sesion.avisar = mirar; };
        mirar();
      });
      return esperar(() => sesion.url || sesion.fin != null, esperaMs).then(() => {
        if (sesion.url) return { url: sesion.url };
        this.cerrarTerminal();
        throw new Error(`No se pudo iniciar el login de Claude. ${ultimas(sesion.salida)}`.trim());
      });
    },

    /** Le pasa al login guiado el código que devolvió claude.ai y espera el token. */
    async enviarCodigoLogin(codigo, { esperaMs = 180_000 } = {}) {
      const s = loginGuiado;
      if (!s || s.fin != null) throw new Error('El login venció. Tocá "Conectar Claude" de nuevo.');
      const limpio = String(codigo ?? '').trim();
      if (!limpio) throw new Error('Pegá el código que te mostró Claude.');
      const desde = s.salida.length;
      s.t.escribir(limpio);
      await new Promise((r) => setTimeout(r, 300));
      s.t.escribir('\r');
      const listo = await new Promise((resolve) => {
        const fin = setTimeout(() => resolve(false), esperaMs);
        const mirar = () => {
          if (s.token || s.fin != null) { clearTimeout(fin); resolve(true); } else s.avisar = mirar;
        };
        mirar();
      });
      if (s.token) { loginGuiado = null; return { ok: true }; }
      if (s.invalido) {
        loginGuiado = null;
        throw new Error('Claude aceptó el código, pero el token que generó no funcionó al probarlo y no se guardó. Tocá "Conectar Claude" para intentar de nuevo.');
      }
      const detalle = ultimas(s.salida.slice(desde));
      if (!listo) this.cerrarTerminal();
      loginGuiado = null;
      if (/accepted|invalid|incomplete|expired/i.test(detalle)) {
        throw new Error('Claude no aceptó el código: puede estar incompleto o vencido. Tocá "Conectar Claude" de nuevo y copiá el código completo.');
      }
      throw new Error(`Claude no aceptó el código. ${detalle || 'Probá de nuevo desde "Conectar Claude".'}`.trim());
    },

    cancelarLogin() {
      loginGuiado = null;
      this.cerrarTerminal();
    },

    cerrarTerminal() {
      if (terminal) {
        try { terminal.kill(); } catch {}
        terminal = null;
      }
    },
  };
}

/** Prueba de la cuenta: una corrida mínima, aislada, sin herramientas. */
export function crearPruebaClaude({ cuenta, aislamiento, lanzar = spawn }) {
  /** Prueba una corrida mínima. Sin token, usa el guardado; con token, prueba ese (antes de guardarlo). */
  return function probar(token = null) {
    const lugar = aislamiento.preparar('prueba');
    const c = cuenta.comando(['-p', 'Respondé solamente con la palabra: hola', '--output-format', 'text', '--tools', '', '--setting-sources', '', '--model', 'haiku']);
    return new Promise((resolve) => {
      const hijo = lanzar(c.file, c.args, {
        env: { ...cuenta.entorno({ home: lugar.base, configDir: lugar.config, tmp: lugar.tmp }), ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) }, cwd: lugar.trabajo,
        ...(aislamiento.activo ? { uid: lugar.usuario.uid, gid: lugar.usuario.gid } : {}), windowsHide: true, timeout: 120_000,
      });
      let out = '', err = '';
      hijo.stdout.on('data', (d) => { out += d; });
      hijo.stderr.on('data', (d) => { err += d; });
      hijo.stdin.end();
      hijo.on('error', (e) => resolve({ ok: false, salida: e.message }));
      hijo.on('close', (codigo) => { aislamiento.terminar(lugar); resolve({ ok: codigo === 0, salida: tacharToken((out || err).trim().slice(0, 2000)) }); });
    });
  };
}
