// Variables de entorno del Propietario (tokens, claves de API): se cargan desde el panel, nunca por el chat,
// quedan cifradas en la base y entran como variables de entorno en las corridas del Propietario, como en una PC.
// Los pedidos (link de un solo uso que manda el agente) duran 30 minutos.
import crypto from 'node:crypto';
import { cifrar, descifrar } from '../auth/cripto.mjs';

const NOMBRE = /^[A-Z][A-Z0-9_]{1,63}$/;
// Lo que arma el gateway para cada corrida: no se puede pisar desde acá.
const RESERVADAS = new Set(['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'BROWSER', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH']);
const PEDIDO_MS = 30 * 60_000;

export function validarNombre(nombre) {
  const n = String(nombre ?? '').trim().toUpperCase();
  if (!NOMBRE.test(n)) throw new Error('El nombre va en mayúsculas, con letras, números y guion bajo (por ejemplo VERCEL_TOKEN).');
  if (RESERVADAS.has(n)) throw new Error(`${n} la maneja el sistema.`);
  return n;
}

export function crearEntorno({ db, config, reloj = () => Date.now() }) {
  const secreto = () => config.sessionSecret;
  const clave = (n) => `entorno:${n}`;

  function guardar(nombre, valor, { descripcion = null, quien = null } = {}) {
    const n = validarNombre(nombre);
    const v = String(valor ?? '').trim();
    if (!v) throw new Error('Falta el valor.');
    if (v.length > 20_000) throw new Error('El valor es demasiado largo.');
    const sobre = cifrar(secreto(), JSON.stringify({ valor: v, descripcion: descripcion ? String(descripcion).slice(0, 200) : null, guardada: reloj(), quien }), 'entorno');
    db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(clave(n), sobre);
    return n;
  }

  function leerUna(n) {
    const f = db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave(n));
    if (!f?.valor) return null;
    try { return JSON.parse(descifrar(secreto(), f.valor, 'entorno')); } catch { return null; }
  }

  function nombres() {
    return db.prepare("SELECT clave FROM ajustes WHERE clave LIKE 'entorno:%' ORDER BY clave").all().map((f) => f.clave.slice(8));
  }

  /** Para el panel: nombres, descripción y fecha. Nunca el valor. */
  function listar() {
    return nombres().map((n) => {
      const d = leerUna(n);
      return { nombre: n, descripcion: d?.descripcion ?? null, guardada: d?.guardada ?? null, legible: !!d };
    });
  }

  /** Para las corridas del Propietario. */
  function variables() {
    const out = {};
    for (const n of nombres()) {
      const d = leerUna(n);
      if (d?.valor) out[n] = d.valor;
    }
    return out;
  }

  function borrar(nombre) {
    return db.prepare('DELETE FROM ajustes WHERE clave = ?').run(clave(validarNombre(nombre))).changes > 0;
  }

  // --- Pedidos: el agente pide una variable; el Propietario la carga en el panel.
  function pedir({ nombre, para = null, chatId = null }) {
    const n = validarNombre(nombre);
    const id = crypto.randomBytes(9).toString('base64url');
    const datos = { nombre: n, para: para ? String(para).slice(0, 300) : null, chatId, vence: reloj() + PEDIDO_MS };
    db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?)').run(`pedido_entorno:${id}`, JSON.stringify(datos));
    return { id, ...datos };
  }

  function pedido(id) {
    const f = db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(`pedido_entorno:${String(id)}`);
    if (!f) return null;
    const d = JSON.parse(f.valor);
    if (d.vence < reloj()) { db.prepare('DELETE FROM ajustes WHERE clave = ?').run(`pedido_entorno:${id}`); return null; }
    return { id, ...d };
  }

  function cerrarPedido(id) {
    db.prepare('DELETE FROM ajustes WHERE clave = ?').run(`pedido_entorno:${String(id)}`);
  }

  const link = (id) => `${config.publicUrl ?? ''}/#entorno?pedido=${encodeURIComponent(id)}`;

  /** El valor de una variable (para las credenciales de los motores), o null. */
  function valor(nombre) {
    try { return leerUna(validarNombre(nombre))?.valor ?? null; } catch { return null; }
  }

  return { guardar, listar, variables, valor, borrar, nombres, pedir, pedido, cerrarPedido, link };
}
