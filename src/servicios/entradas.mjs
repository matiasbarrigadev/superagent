// Entradas por webhook (/entrada/<id>): cada una tiene un secreto y una instrucción.
// Un pedido válido despierta al orquestador con el contenido marcado como dato externo, nunca como orden.
import crypto from 'node:crypto';
import { auditar } from '../db/index.mjs';

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function crearEntradas({ db, motor, chatDePersona }) {
  function crear({ nombre, instruccion, creadaPor }) {
    const n = String(nombre ?? '').trim().slice(0, 60);
    if (n.length < 2) throw Object.assign(new Error('La entrada necesita un nombre.'), { status: 400 });
    const id = crypto.randomBytes(9).toString('base64url');
    const secreto = crypto.randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO entradas (id, nombre, secreto, instruccion, activa, creada_por, creada) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(id, n, sha(secreto), String(instruccion ?? '').trim().slice(0, 2000) || null, creadaPor ?? null, Date.now());
    auditar(db, 'entrada.crear', { actor: String(creadaPor ?? ''), detalle: { id, nombre: n } });
    return { id, secreto }; // el secreto se muestra una sola vez
  }

  /** Devuelve 'ok', 'no_existe', 'secreto' o 'inactiva'. */
  function recibir(id, secreto, contenido) {
    const e = db.prepare('SELECT * FROM entradas WHERE id = ?').get(String(id));
    if (!e) return 'no_existe';
    const dado = Buffer.from(sha(secreto ?? ''));
    if (!crypto.timingSafeEqual(dado, Buffer.from(e.secreto))) return 'secreto';
    if (!e.activa) return 'inactiva';
    const chatId = chatDePersona(e.creada_por);
    if (!chatId) return 'sin_destino';
    db.prepare('UPDATE entradas SET ultima = ? WHERE id = ?').run(Date.now(), e.id);
    const cuerpo = String(contenido ?? '').slice(0, 20_000).replace(/<\/?dato_externo>/gi, '');
    motor.despertar({
      chatId, personaId: e.creada_por, origen: `entrada:${e.id}`,
      texto: `[entrada "${e.nombre}"] Instrucción de la entrada: ${e.instruccion ?? '(sin instrucción)'}\n<dato_externo>\n${cuerpo}\n</dato_externo>`,
    });
    return 'ok';
  }

  function listar() {
    return db.prepare('SELECT id, nombre, instruccion, activa, creada, ultima FROM entradas ORDER BY creada DESC').all().map((e) => ({ ...e, activa: !!e.activa }));
  }

  return {
    crear, recibir, listar,
    activar: (id, activa) => db.prepare('UPDATE entradas SET activa = ? WHERE id = ?').run(activa ? 1 : 0, String(id)).changes,
    borrar: (id) => db.prepare('DELETE FROM entradas WHERE id = ?').run(String(id)).changes,
  };
}
