// Pantallas: terminales persistentes (tmux) en el entorno del Propietario. Sirven para lo interactivo que una corrida
// no puede esperar: un login que imprime una URL y espera que se pegue algo (claude mcp login, gh auth login…), un
// instalador que pregunta. El agente las abre, lee y escribe; el gateway las mira y lo despierta en la charla cuando
// la pantalla pide algo nuevo o el proceso termina. Nada es específico de un servicio: el modelo lee y decide.
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';

const MAX_ABIERTAS = 5;
const VENCE_MS = 60 * 60_000;      // sin uso, se cierra sola
const QUIETA_MS = 3000;            // la pantalla tiene que quedar quieta para avisar (no a mitad de una salida)
const CADA_MS = 4000;
const TECLAS = /^(C-[a-z]|M-[a-z]|Enter|Escape|Tab|BSpace|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|y|n|q)$/i;

export class ErrorPantalla extends Error {
  constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
}

/** tmux como el usuario del entorno, sin shell en el medio (los argumentos van tal cual). */
function tmuxReal({ usuario, env }) {
  return (args) => new Promise((resolve) => {
    execFile('tmux', args, { env, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, ...(usuario ? { uid: usuario.uid, gid: usuario.gid } : {}) },
      (err, stdout, stderr) => resolve({ codigo: err ? (typeof err.code === 'number' ? err.code : 1) : 0, salida: String(stdout ?? ''), error: String(stderr ?? err?.message ?? '') }));
  });
}

export function crearPantallas({ db, aislamiento = null, entornoDe = () => ({}), limpiar = (t) => t, despertar = () => {}, tmux = null, dormir = (ms) => new Promise((r) => setTimeout(r, ms)), reloj = () => Date.now(), log = console }) {
  const lugar = () => (aislamiento?.rutas ? aislamiento.rutas('propietario') : { base: process.env.HOME ?? '.', trabajo: process.cwd() });
  const socket = () => path.join(lugar().base, '.pantallas.sock');
  const correr = (args) => {
    const u = aislamiento?.activo ? aislamiento.usuarioDe('propietario') : null;
    const t = tmux ?? tmuxReal({ usuario: u, env: entornoDe() });
    return t(['-S', socket(), ...args]);
  };
  const validarNombre = (n) => {
    const s = String(n ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    if (!s) throw new ErrorPantalla('Falta el nombre de la pantalla.');
    return s;
  };
  const fila = (n) => db.prepare('SELECT * FROM pantallas WHERE nombre = ?').get(n);
  const hash = (t) => crypto.createHash('sha1').update(t).digest('hex');

  /** El texto de la pantalla (sin líneas vacías al final), tachado, y si el proceso terminó. */
  async function capturar(n) {
    const c = await correr(['capture-pane', '-p', '-J', '-t', n, '-S', '-80']);
    if (c.codigo !== 0) return null; // la sesión ya no existe
    const d = await correr(['display-message', '-p', '-t', n, '#{pane_dead}|#{pane_dead_status}']);
    const [muerta, codigo] = String(d.salida).trim().split('|');
    // Sin las filas vacías del final ni los huecos largos (tmux rellena la pantalla con líneas en blanco).
    const texto = limpiar(c.salida.replace(/\s+$/g, '').replace(/\n[ \t]*(\n[ \t]*){2,}/g, '\n\n').split('\n').slice(-60).join('\n'), 6000);
    return { texto, terminada: muerta === '1', codigo: codigo === '' ? null : Number(codigo) };
  }

  async function abrir({ nombre, comando, chatId = null, personaId = null, avisar = true }) {
    const n = validarNombre(nombre);
    const cmd = String(comando ?? '').trim();
    if (!cmd) throw new ErrorPantalla('Falta el comando que corre en la pantalla.');
    if (fila(n)) await cerrar(n).catch(() => {});
    if (db.prepare('SELECT COUNT(*) AS c FROM pantallas').get().c >= MAX_ABIERTAS) throw new ErrorPantalla(`Ya hay ${MAX_ABIERTAS} pantallas abiertas: cerrá alguna antes.`, 409);
    const r = await correr(['start-server', ';', 'set-option', '-g', 'remain-on-exit', 'on', ';', 'set-option', '-g', 'history-limit', '2000', ';',
      'new-session', '-d', '-s', n, '-x', '160', '-y', '45', '-c', lugar().trabajo ?? lugar().base, cmd]);
    if (r.codigo !== 0) throw new ErrorPantalla(`No se pudo abrir la pantalla: ${String(r.error).slice(0, 300)}`, 500);
    const ahora = reloj();
    db.prepare(`INSERT INTO pantallas (nombre, chat_id, persona_id, comando, avisar, creada, usada, cambio) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(n, chatId, personaId, cmd.slice(0, 500), avisar ? 1 : 0, ahora, ahora, ahora);
    await dormir(1500); // que el comando llegue a mostrar algo
    return ver(n);
  }

  async function ver(nombre) {
    const n = validarNombre(nombre);
    const f = fila(n);
    if (!f) throw new ErrorPantalla(`No hay una pantalla "${n}".`, 404);
    const p = await capturar(n);
    if (!p) { db.prepare('DELETE FROM pantallas WHERE nombre = ?').run(n); throw new ErrorPantalla(`La pantalla "${n}" ya no existe.`, 404); }
    // Lo que el agente ya vio no se le vuelve a avisar.
    const h = hash(p.texto);
    db.prepare('UPDATE pantallas SET usada = ?, ultimo_hash = ?, avisado_hash = ?, terminada = ? WHERE nombre = ?').run(reloj(), h, h, p.terminada ? 1 : 0, n);
    return { nombre: n, comando: f.comando, ...p };
  }

  async function escribir(nombre, { texto = null, enter = true, teclas = [] } = {}) {
    const n = validarNombre(nombre);
    if (!fila(n)) throw new ErrorPantalla(`No hay una pantalla "${n}".`, 404);
    for (const k of teclas ?? []) if (!TECLAS.test(String(k))) throw new ErrorPantalla(`Tecla no permitida: ${k}`);
    if (texto != null && String(texto) !== '') await correr(['send-keys', '-t', n, '-l', '--', String(texto).slice(0, 4000)]);
    if (teclas?.length) await correr(['send-keys', '-t', n, ...teclas]);
    if (enter) await correr(['send-keys', '-t', n, 'Enter']);
    db.prepare('UPDATE pantallas SET usada = ? WHERE nombre = ?').run(reloj(), n);
    await dormir(1500);
    return ver(n);
  }

  async function cerrar(nombre) {
    const n = validarNombre(nombre);
    await correr(['kill-session', '-t', n]);
    return db.prepare('DELETE FROM pantallas WHERE nombre = ?').run(n).changes > 0;
  }

  async function listar({ conPantalla = false } = {}) {
    const out = [];
    for (const f of db.prepare('SELECT * FROM pantallas ORDER BY creada').all()) {
      const x = { nombre: f.nombre, comando: f.comando, chat_id: f.chat_id, creada: f.creada, usada: f.usada, terminada: !!f.terminada, avisar: !!f.avisar };
      if (conPantalla) { const p = await capturar(f.nombre).catch(() => null); x.pantalla = p?.texto ?? null; x.terminada = p ? p.terminada : true; x.codigo = p?.codigo ?? null; }
      out.push(x);
    }
    return out;
  }

  // Vigía: cuando la pantalla muestra algo nuevo y queda quieta, o el proceso termina, despierta al agente.
  let ultimaRevision = 0, revisando = false;
  async function revisar(ahora = reloj()) {
    if (revisando || ahora - ultimaRevision < CADA_MS) return;
    ultimaRevision = ahora;
    revisando = true;
    try {
      for (const f of db.prepare('SELECT * FROM pantallas').all()) {
        if (ahora - f.usada > VENCE_MS) { await cerrar(f.nombre).catch(() => {}); continue; }
        if (!f.avisar || !f.chat_id) continue;
        const p = await capturar(f.nombre).catch(() => null);
        if (!p) { db.prepare('DELETE FROM pantallas WHERE nombre = ?').run(f.nombre); continue; }
        const h = hash(p.texto);
        if (h !== f.ultimo_hash) { db.prepare('UPDATE pantallas SET ultimo_hash = ?, cambio = ? WHERE nombre = ?').run(h, ahora, f.nombre); if (!p.terminada) continue; }
        const quieta = ahora - (h !== f.ultimo_hash ? ahora : f.cambio ?? ahora) >= QUIETA_MS;
        const terminoRecien = p.terminada && !f.terminada;
        if (h === f.avisado_hash && !terminoRecien) continue;
        if (!quieta && !terminoRecien) continue;
        db.prepare('UPDATE pantallas SET avisado_hash = ?, terminada = ? WHERE nombre = ?').run(h, p.terminada ? 1 : 0, f.nombre);
        const ult = p.texto.split('\n').slice(-30).join('\n');
        despertar({ chatId: f.chat_id, personaId: f.persona_id, origen: `pantalla:${f.nombre}`,
          texto: `[pantalla ${f.nombre}${p.terminada ? ` terminó${p.codigo != null ? ` (código ${p.codigo})` : ''}` : ' muestra algo nuevo'}] Comando: ${f.comando}\n<pantalla>\n${ult}\n</pantalla>\nMirala: si pide algo que tiene que hacer una persona (abrir un link, poner un código, pegar lo que le mostró el navegador), pasáselo por acá en palabras simples; si lo podés resolver vos, escribí en la pantalla. ${p.terminada ? 'Si ya no la necesitás, cerrala.' : ''}` });
      }
    } catch (e) {
      log.warn?.('[pantallas]', e.message);
    } finally {
      revisando = false;
    }
  }

  return { abrir, ver, escribir, cerrar, listar, revisar, socket };
}
