// Aislamiento entre conversaciones: cada chat (y cada trabajo) corre con su propio usuario de Linux y
// su propia carpeta 0700 (sesiones de Claude, espacio de trabajo, tmp). Una corrida no puede leer
// lo de otra conversación, ni sus procesos, ni el token MCP de otra corrida.
//
// Los usuarios se crean al vuelo (useradd) y su uid queda en la base, así la carpeta del volumen
// sigue siendo suya después de reiniciar el contenedor (se recrean al arrancar).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';


export function crearAislamiento({ db, config, log = console, so = execFileSync }) {
  const UID_BASE = config.uidBase ?? 20000;
  const activo = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
  const raiz = path.join(config.dataDir, 'aislados');

  function existeUsuario(nombre) {
    try { so('id', ['-u', nombre], { stdio: 'ignore' }); return true; } catch { return false; }
  }

  function crearUsuarioSO(uid) {
    const nombre = `sa${uid}`;
    if (!existeUsuario(nombre)) {
      so('useradd', ['--no-create-home', '--user-group', '--uid', String(uid), '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', nombre], { stdio: 'ignore' });
    }
    return nombre;
  }

  /** Usuario (uid estable) de una clave: "chat:<id>" o "trabajo:T-n". */
  function usuarioDe(clave) {
    let fila = db.prepare('SELECT uid FROM usuarios_so WHERE clave = ?').get(clave);
    if (!fila) {
      const max = db.prepare('SELECT MAX(uid) AS m FROM usuarios_so').get().m ?? UID_BASE;
      db.prepare('INSERT INTO usuarios_so (clave, uid, creado) VALUES (?, ?, ?)').run(clave, max + 1, Date.now());
      fila = { uid: max + 1 };
    }
    const nombre = activo ? crearUsuarioSO(fila.uid) : `sa${fila.uid}`;
    return { uid: fila.uid, gid: fila.uid, nombre };
  }

  /** Al arrancar: los usuarios del contenedor no persisten, la base sí. */
  function recrearUsuarios() {
    if (!activo) return 0;
    const filas = db.prepare('SELECT uid FROM usuarios_so').all();
    for (const f of filas) {
      try { crearUsuarioSO(f.uid); } catch (e) { log.warn('[aislamiento] no se pudo recrear', f.uid, e.message); }
    }
    return filas.length;
  }

  /** Mata todo lo que haya quedado corriendo con ese usuario (antes y después de cada corrida). */
  function matarProcesos(u) {
    if (!activo) return;
    try { so('pkill', ['-KILL', '-u', String(u.uid)], { stdio: 'ignore' }); } catch { /* sin procesos: pkill sale con 1 */ }
  }

  /**
   * Carpeta del usuario: si el agente dejó un enlace simbólico o algo raro en lugar de la carpeta,
   * se reemplaza (root nunca sigue enlaces dentro de una carpeta aislada).
   */
  function asegurarDir(dir, u, modo = 0o700) {
    let st = null;
    try { st = fs.lstatSync(dir); } catch {}
    if (st && !st.isDirectory()) { fs.rmSync(dir, { force: true }); st = null; }
    if (!st) fs.mkdirSync(dir, { mode: modo });
    if (activo) {
      fs.lchownSync(dir, u.uid, u.gid);
      fs.chmodSync(dir, modo);
    }
  }

  /** Escribe un archivo dentro de la carpeta aislada sin seguir enlaces (se borra y se crea de cero). */
  function escribirArchivo(ruta, contenido, u, modo = 0o600) {
    fs.rmSync(ruta, { force: true });
    const fd = fs.openSync(ruta, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), modo);
    try {
      fs.writeSync(fd, contenido);
      if (activo) fs.fchownSync(fd, u.uid, u.gid);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Copia un archivo del gateway (por ejemplo un adjunto) adentro de la carpeta aislada. */
  function copiarAdentro(origen, destino, u) {
    escribirArchivo(destino, fs.readFileSync(origen), u, 0o600);
  }

  /**
   * Prepara el lugar de una corrida: usuario, procesos viejos muertos, y carpetas
   * base/{config,trabajo,tmp,adjuntos,salida} de ese usuario.
   */
  const SUBDIRS = ['config', 'trabajo', 'tmp', 'adjuntos', 'salida', 'avisos'];

  /** Rutas de una clave, sin tocar nada (las usa el armado del prompt). */
  function rutas(clave) {
    const base = path.join(raiz, crypto.createHash('sha256').update(clave).digest('hex').slice(0, 20));
    return { base, ...Object.fromEntries(SUBDIRS.map((d) => [d, path.join(base, d)])) };
  }

  // Corridas en curso por clave: el entorno del Propietario lo pueden usar dos chats a la vez (panel y WhatsApp),
  // y una no tiene que matar los procesos de la otra.
  const enCurso = new Map();
  // El entorno del Propietario es como su PC: lo que deja corriendo (un login que espera la autorización, un
  // servidor de desarrollo) sigue vivo entre respuestas. "Pausá todo" lo corta igual.
  const PERSISTENTES = new Set(['propietario']);

  function preparar(clave) {
    const u = usuarioDe(clave);
    if (!enCurso.get(clave) && !PERSISTENTES.has(clave)) matarProcesos(u);
    enCurso.set(clave, (enCurso.get(clave) ?? 0) + 1);
    fs.mkdirSync(raiz, { recursive: true, mode: 0o711 });
    if (activo) fs.chmodSync(raiz, 0o711);
    const r = rutas(clave);
    asegurarDir(r.base, u);
    for (const d of SUBDIRS) asegurarDir(r[d], u);
    return { clave, usuario: u, ...r };
  }

  /**
   * Lee un archivo con el usuario de la corrida (no como root): así un enlace simbólico solo llega
   * a lo que esa corrida ya podía leer. Devuelve un Buffer o lanza si no existe o es muy grande.
   */
  function leerComo(u, ruta, max = 50 * 1024 * 1024) {
    if (!activo) {
      const st = fs.lstatSync(ruta);
      if (!st.isFile()) throw new Error('No es un archivo.');
      if (st.size > max) throw new Error('El archivo es demasiado grande.');
      return fs.readFileSync(ruta);
    }
    let datos;
    try {
      datos = so('head', ['-c', String(max + 1), '--', ruta], { uid: u.uid, gid: u.gid, maxBuffer: max + 2, env: { PATH: process.env.PATH } });
    } catch {
      throw new Error('No se pudo leer el archivo (¿existe?).');
    }
    if (datos.length > max) throw new Error('El archivo es demasiado grande.');
    return datos;
  }

  function terminar(lugar, { archivoMcp = null } = {}) {
    const n = Math.max(0, (enCurso.get(lugar.clave) ?? 1) - 1);
    if (n) enCurso.set(lugar.clave, n); else enCurso.delete(lugar.clave);
    if (!n && !PERSISTENTES.has(lugar.clave)) matarProcesos(lugar.usuario);
    try { fs.rmSync(archivoMcp ?? path.join(lugar.base, 'mcp.json'), { force: true }); } catch {}
  }

  return { activo, rutas, usuarioDe, recrearUsuarios, preparar, leerComo, terminar, escribirArchivo, copiarAdentro, asegurarDir, matarProcesos };
}
