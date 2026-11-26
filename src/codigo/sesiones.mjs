// Sesiones de proyecto persistentes (etapa 8d): una conversación de Claude larga por proyecto (S-n), con su
// clon, su rama y su --resume. El orquestador le reenvía pedidos y consultas por el buzón; la sesión contesta
// al orquestador, nunca a una persona. Cada mensaje del buzón la despierta (si no está pausada).
import { auditar } from '../db/index.mjs';

export class ErrorSesion extends Error {
  constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
}

export function crearSesiones({ db, reloj = () => Date.now() }) {
  const numero = (id) => Number(String(id).replace(/^S-?/i, ''));
  function obtener(id) {
    const s = db.prepare('SELECT s.*, p.nombre AS proyecto FROM sesiones_proyecto s JOIN proyectos p ON p.id = s.proyecto_id WHERE s.id = ?').get(numero(id));
    if (!s) throw new ErrorSesion(`No existe la sesión ${id}.`, 404);
    return s;
  }

  /** La crea el gateway al confirmar la propuesta (la sesión la confirma el Propietario). */
  function crear({ nombre, proyecto_id, persona_origen = null, chat_origen = null }) {
    const p = db.prepare('SELECT id, repo FROM proyectos WHERE id = ?').get(Number(proyecto_id));
    if (!p) throw new ErrorSesion('Ese proyecto no existe.', 404);
    const id = Number(db.prepare(`INSERT INTO sesiones_proyecto (proyecto_id, nombre, estado, ultima_actividad, persona_origen, chat_origen, creada)
      VALUES (?, ?, 'activa', ?, ?, ?, ?)`).run(p.id, String(nombre).slice(0, 80), reloj(), persona_origen, chat_origen, reloj()).lastInsertRowid);
    if (p.repo) db.prepare('UPDATE sesiones_proyecto SET rama = ? WHERE id = ?').run(`superagent/S-${id}`, id);
    auditar(db, 'sesion.crear', { actor: String(persona_origen ?? ''), detalle: { id, proyecto: p.id } });
    return id;
  }

  function escribir(sesionId, { de, tipo, contenido, personaOrigen = null, chatOrigen = null, respuestaA = null }) {
    const s = obtener(sesionId);
    if (s.estado === 'archivada') throw new ErrorSesion(`La sesión S-${s.id} está archivada.`, 409);
    return Number(db.prepare(`INSERT INTO buzon (sesion_id, de, tipo, contenido, persona_origen, estado, chat_origen, creado, respuesta_a)
      VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?, ?)`).run(s.id, de, tipo, String(contenido).slice(0, 20_000), personaOrigen, chatOrigen, reloj(), respuestaA).lastInsertRowid);
  }

  /** Mensajes del orquestador que todavía no leyó una sesión activa. */
  const pendientesDe = (sesionId) => db.prepare("SELECT * FROM buzon WHERE sesion_id = ? AND de = 'orquestador' AND estado = 'pendiente' ORDER BY id").all(sesionId);
  const conPendientes = () => db.prepare(`SELECT DISTINCT s.* FROM sesiones_proyecto s JOIN buzon b ON b.sesion_id = s.id
    WHERE s.estado = 'activa' AND b.de = 'orquestador' AND b.estado = 'pendiente'`).all();

  function cambiarEstado(id, estado) {
    if (!['activa', 'pausada', 'archivada'].includes(estado)) throw new ErrorSesion('Estado inválido.');
    db.prepare('UPDATE sesiones_proyecto SET estado = ? WHERE id = ?').run(estado, numero(id));
  }

  function listar() {
    return db.prepare(`SELECT s.*, p.nombre AS proyecto,
        (SELECT COUNT(*) FROM buzon b WHERE b.sesion_id = s.id AND b.estado = 'pendiente' AND b.de = 'orquestador') AS pendientes
      FROM sesiones_proyecto s JOIN proyectos p ON p.id = s.proyecto_id ORDER BY s.id DESC`).all();
  }

  return { obtener, crear, escribir, pendientesDe, conPendientes, cambiarEstado, listar, numero };
}
