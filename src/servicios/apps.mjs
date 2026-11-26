// Apps del agente: cualquier cosa que levante en su entorno persistente (un CRM, un panel a medida, una
// calculadora, un simulador, un informe estático) queda en vivo en <url pública>/apps/<nombre>/.
// El gateway solo hace de proxy al puerto local; qué es la app, cómo se protege y cómo se ve lo decide el agente.
//
// Si la app tiene comando, el gateway la vuelve a levantar sola cuando no responde (reinicio del servidor,
// un proceso que se cayó), con el usuario del entorno del Propietario y sin el token de Claude en su entorno.
import path from 'node:path';
import net from 'node:net';
import { spawn as spawnNode } from 'node:child_process';

export const NOMBRE_APP = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function puertoResponde(puerto, timeout = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: 'localhost', port: puerto, autoSelectFamily: true });
    const fin = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}

export function crearApps({ db, config, aislamiento = null, entorno = null, pausada = () => false, lanzar = spawnNode, probar = puertoResponde, reloj = () => Date.now(), log = console }) {
  const reservados = new Set([Number(config.port), Number(config.mcpPort)]);
  const procesos = new Map();   // nombre → pid del grupo que lanzó el gateway
  const intentos = new Map();   // nombre → último intento de levantarla

  const url = (nombre) => `${config.publicUrl ?? ''}/apps/${nombre}/`;
  const obtener = (nombre) => db.prepare('SELECT * FROM apps WHERE nombre = ?').get(nombre) ?? null;
  const listar = () => db.prepare('SELECT * FROM apps ORDER BY nombre').all();

  function entornoPropietario() {
    if (!aislamiento?.rutas) return null;
    const r = aislamiento.rutas('propietario');
    return { base: r.base, tmp: r.tmp, usuario: aislamiento.activo ? aislamiento.usuarioDe('propietario') : null };
  }

  function validar({ nombre, puerto }) {
    if (!NOMBRE_APP.test(String(nombre ?? ''))) throw new Error('El nombre va en minúsculas, números y guiones (máx. 40), por ejemplo "crm" o "calculadora-fletes".');
    const p = Number(puerto);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('El puerto tiene que ser un número entre 1024 y 65535.');
    if (reservados.has(p)) throw new Error(`El puerto ${p} lo usa el sistema: elegí otro (por ejemplo 3000-3999).`);
    const otra = db.prepare('SELECT nombre FROM apps WHERE puerto = ? AND nombre != ?').get(p, nombre);
    if (otra) throw new Error(`El puerto ${p} ya es de la app "${otra.nombre}".`);
    return p;
  }

  function publicar({ nombre, puerto, comando = null, dir = null, quitarPrefijo = false, descripcion = null }) {
    const p = validar({ nombre, puerto });
    const ahora = reloj();
    db.prepare(`INSERT INTO apps (nombre, puerto, comando, dir, quitar_prefijo, descripcion, creado, actualizado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(nombre) DO UPDATE SET puerto = excluded.puerto, comando = excluded.comando, dir = excluded.dir,
        quitar_prefijo = excluded.quitar_prefijo, descripcion = excluded.descripcion, actualizado = excluded.actualizado`)
      .run(nombre, p, comando || null, dir || null, quitarPrefijo ? 1 : 0, descripcion || null, ahora, ahora);
    intentos.delete(nombre);
    return obtener(nombre);
  }

  function detener(nombre) {
    const pid = procesos.get(nombre);
    if (!pid) return false;
    try { process.kill(-pid, 'SIGTERM'); } catch {}
    procesos.delete(nombre);
    return true;
  }

  function quitar(nombre) {
    const a = obtener(nombre);
    if (!a) return false;
    detener(nombre);
    db.prepare('DELETE FROM apps WHERE nombre = ?').run(nombre);
    return true;
  }

  /** Lanza el comando de la app con el usuario del entorno del Propietario. Su salida va a ~/registros/<nombre>.log. */
  function levantar(a) {
    if (!a.comando) return false;
    const e = entornoPropietario();
    if (!e) return false;
    const dir = path.resolve(e.base, a.dir || '.');
    const env = {
      ...(entorno?.variables?.() ?? {}),
      PATH: process.env.PATH, HOME: e.base, TMPDIR: e.tmp, LANG: 'C.UTF-8',
      PORT: String(a.puerto), BASE_PATH: `/apps/${a.nombre}`, PUBLIC_URL: url(a.nombre).replace(/\/$/, ''),
    };
    const guion = 'mkdir -p "$HOME/registros"; cd "$1" || exit 1; exec bash -lc "$2" >>"$HOME/registros/$3.log" 2>&1';
    const opciones = { env, cwd: e.base, detached: true, stdio: 'ignore', windowsHide: true, ...(e.usuario ? { uid: e.usuario.uid, gid: e.usuario.gid } : {}) };
    try {
      const hijo = lanzar('bash', ['-c', guion, 'app', dir, a.comando, a.nombre], opciones);
      hijo.on?.('error', (err) => log.warn?.(`[apps] ${a.nombre}: ${err.message}`));
      hijo.unref?.();
      if (hijo.pid) procesos.set(a.nombre, hijo.pid);
      log.log?.(`[apps] ${a.nombre}: levantada en el puerto ${a.puerto}`);
      return true;
    } catch (err) {
      log.warn?.(`[apps] ${a.nombre}: no se pudo levantar (${err.message})`);
      return false;
    }
  }

  async function reiniciar(nombre) {
    const a = obtener(nombre);
    if (!a) throw new Error('No hay una app con ese nombre.');
    if (!a.comando) throw new Error('Esa app no tiene comando: levantala vos y el link sigue igual.');
    detener(nombre);
    await new Promise((r) => setTimeout(r, 500));
    intentos.set(nombre, reloj());
    return levantar(a);
  }

  /** Vuelta del vigía: las apps con comando que no responden se levantan (como mucho una vez cada 2 min). */
  async function vigilar() {
    if (pausada()) return [];
    const levantadas = [];
    for (const a of listar()) {
      if (!a.comando) continue;
      if (await probar(a.puerto)) { intentos.delete(a.nombre); continue; }
      if (intentos.has(a.nombre) && reloj() - intentos.get(a.nombre) < 120_000) continue;
      intentos.set(a.nombre, reloj());
      if (levantar(a)) levantadas.push(a.nombre);
    }
    return levantadas;
  }

  async function estado() {
    return Promise.all(listar().map(async (a) => ({ ...a, url: url(a.nombre), viva: await probar(a.puerto) })));
  }

  let t = null;
  return {
    url, obtener, listar, publicar, quitar, reiniciar, vigilar, estado, detener,
    iniciar(intervalo = 60_000) {
      if (t) return;
      setTimeout(() => vigilar().catch(() => {}), 10_000).unref?.();
      t = setInterval(() => vigilar().catch(() => {}), intervalo);
      t.unref?.();
    },
  };
}
