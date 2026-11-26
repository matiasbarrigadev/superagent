// Corre `claude -p` (binario oficial, sin modificar) con el usuario de Linux de su conversación, entorno limpio
// y su propia carpeta, y lee el stream-json. El prompt va por stdin; los permisos van como flags que arma el gateway.
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as spawnNode } from 'node:child_process';

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

/**
 * Ejecutor real. `cuenta`: entorno limpio y comando (claude/cuenta.mjs). `aislamiento`: usuario y carpeta
 * de la conversación (claude/aislamiento.mjs). `lanzar` permite reemplazar spawn en los tests.
 */
export function crearEjecutor({ cuenta, aislamiento, lanzar = spawnNode, log = console }) {
  return async function ejecutar(spec, { sesion, nueva, timeoutMs = 15 * 60_000 } = {}) {
    const lugar = aislamiento.preparar(spec.claveAislamiento);
    // Preparación propia de la corrida (por ejemplo, el clon del repo de un trabajo), con la carpeta ya lista.
    if (spec.preparar) {
      try { await spec.preparar(lugar); } catch (e) {
        aislamiento.terminar(lugar);
        return { ok: false, tipoError: 'otro', error: `No se pudo preparar la corrida: ${e.message}`, herramientas: [], lugar };
      }
    }
    // Adjuntos de esta tanda: se copian adentro, así solo los ve esta conversación.
    for (const a of spec.adjuntos ?? []) {
      try { aislamiento.copiarAdentro(a.origen, path.join(lugar.adjuntos, a.nombre), lugar.usuario); } catch (e) { log.warn('[corrida] adjunto', a.nombre, e.message); }
    }
    for (const f of spec.archivosExtra ?? []) aislamiento.escribirArchivo(path.join(lugar.base, f.nombre), f.contenido, lugar.usuario);
    // Un archivo por corrida: el entorno del Propietario puede tener dos corridas a la vez.
    const archivoMcp = path.join(lugar.base, spec.completo ? `mcp-${crypto.randomUUID()}.json` : 'mcp.json');
    aislamiento.escribirArchivo(archivoMcp, configMcp(spec), lugar.usuario);
    const c = cuenta.comando(argumentos({ ...spec, mcp: { ...spec.mcp, archivo: archivoMcp } }, { sesion, nueva }));
    const comoUsuario = aislamiento.activo ? { uid: lugar.usuario.uid, gid: lugar.usuario.gid } : {};
    return new Promise((resolve) => {
      const fin = (r) => { aislamiento.terminar(lugar, { archivoMcp }); resolve({ ...r, lugar }); };
      let hijo;
      try {
        hijo = lanzar(c.file, c.args, { env: { ...(spec.entornoExtra ?? {}), ...(spec.compactarPct ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(spec.compactarPct) } : {}), ...cuenta.entorno({ home: lugar.base, configDir: lugar.config, tmp: lugar.tmp }) }, cwd: lugar.trabajo, ...comoUsuario, windowsHide: true });
      } catch (e) {
        fin({ ok: false, tipoError: 'sin_binario', error: e.message, herramientas: [] });
        return;
      }
      const r = { ok: false, sessionId: null, resultado: '', error: null, tipoError: null, herramientas: [], codigoError: null };
      let buf = '', err = '', vencida = false;
      const alLinea = (linea) => {
        if (!linea.trim()) return;
        let m;
        try { m = JSON.parse(linea); } catch { return; }
        if (m.type === 'system' && m.subtype === 'init') r.sessionId = m.session_id ?? r.sessionId;
        if (m.type === 'assistant') {
          if (m.error) r.codigoError = m.error;
          // Tamaño del contexto: lo que entró en el último pedido al modelo (con lo cacheado).
          const u = m.message?.usage;
          if (u) r.contexto = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          for (const b of m.message?.content ?? []) if (b.type === 'tool_use') r.herramientas.push(b.name);
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
      };
      const reloj = setTimeout(() => { vencida = true; try { hijo.kill('SIGKILL'); } catch {} }, timeoutMs);
      hijo.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { alLinea(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      hijo.stderr.on('data', (d) => { if (err.length < 20_000) err += d; });
      hijo.on('error', (e) => {
        clearTimeout(reloj);
        fin({ ...r, ok: false, tipoError: e.code === 'ENOENT' ? 'sin_binario' : 'otro', error: e.message });
      });
      hijo.on('close', (codigo) => {
        clearTimeout(reloj);
        if (buf) alLinea(buf);
        if (vencida) { fin({ ...r, ok: false, tipoError: 'tiempo', error: 'La corrida tardó demasiado y se cortó.' }); return; }
        if (codigo !== 0 && r.ok) r.ok = false;
        if (!r.ok) {
          r.error = r.error || err.trim().slice(0, 2000) || `claude terminó con código ${codigo}`;
          r.tipoError = clasificarError(`${r.error}\n${err}`, r.codigoError);
        }
        fin(r);
      });
      hijo.stdin.on('error', () => {});
      hijo.stdin.end(spec.prompt);
    });
  };
}
