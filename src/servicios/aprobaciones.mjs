// Aprobaciones A-n: lo que el rol (o la autonomía del cliente) permite solo "con aprobación".
// El Propietario aprueba desde el panel, con "dale A-n" desde su número o con un link firmado (un solo uso,
// 30 minutos, atado a la aprobación y a ese Propietario). Al aprobar, ejecuta el gateway.
import crypto from 'node:crypto';
import { auditar } from '../db/index.mjs';
import { json } from '../util.mjs';

export class ErrorAprobacion extends Error {
  constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
}

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const VIGENCIA_ENLACE = 30 * 60_000;

// `alPedir`: si está, el pedido se lo cuenta el agente a cada Propietario en su chat, con sus palabras (como lo haría
// un colaborador); devuelve cuántos Propietarios despertó. Sin él (o si no despertó a nadie), va el aviso de texto.
export function crearAprobaciones({ db, bitacora = null, avisos, salida = null, config = {}, ejecutores = {}, alDecidir = () => {}, alPedir = null, reloj = () => Date.now(), log = console }) {
  function siguienteId() {
    const r = db.prepare("SELECT MAX(CAST(substr(id, 3) AS INTEGER)) AS n FROM aprobaciones WHERE id LIKE 'A-%'").get();
    return `A-${(r.n ?? 0) + 1}`;
  }

  /** Propietarios con número verificado: a cada uno le llega su propio link firmado. */
  const propietarios = () => db.prepare(`SELECT p.id, p.telefono FROM personas p JOIN roles r ON r.id = p.rol_id
    WHERE r.nombre = 'Propietario' AND r.predefinido = 1 AND p.activa = 1 AND p.verificada = 1 AND p.telefono IS NOT NULL`).all();

  function pedir({ tipo, accion, datos = {}, detalle, pedidaPor = null, chatOrigen = null, corridaId = null, diff = null, enlace = false, avisar = true }) {
    const id = siguienteId();
    db.prepare(`INSERT INTO aprobaciones (id, tipo, pedida_por, detalle, diff, estado, accion, datos, chat_origen, corrida_id, creada, ronda)
      VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?, ?)`)
      .run(id, tipo, pedidaPor, String(detalle).slice(0, 2000), diff, accion, JSON.stringify(datos), chatOrigen, corridaId, reloj(), datos.ronda ?? 1);
    const quien = pedidaPor ? db.prepare('SELECT nombre, telefono FROM personas WHERE id = ?').get(pedidaPor) : null;
    const texto = `Pedido de aprobación ${id}${quien ? ` (de ${quien.nombre ?? quien.telefono ?? 'alguien'})` : ''}: ${detalle}`;
    const respuesta = `Respondé "dale ${id}" para aprobar o "no ${id}" para rechazar (también desde el panel).`;
    if (!avisar) {
      // Lo pregunta el agente en la charla con el Propietario: sin mensajes aparte.
    } else if (enlace && salida && config.publicUrl) {
      // Un link por Propietario: de un solo uso, vence en 30 minutos y solo sirve para esta aprobación.
      for (const p of propietarios()) {
        const token = crypto.randomBytes(24).toString('base64url');
        db.prepare('INSERT INTO enlaces (hash, aprobacion_id, persona_id, vence) VALUES (?, ?, ?, ?)').run(sha(token), id, p.id, reloj() + VIGENCIA_ENLACE);
        salida.encolar({ chatId: `${p.telefono}@c.us`, texto: [texto, `Ver el cambio y decidir (vence en 30 min): ${config.publicUrl}/aprobacion/${token}`, respuesta].join('\n\n'), origen: `aprobacion:${id}` });
      }
      salida.procesar().catch(() => {});
      avisos.alPropietario([texto, respuesta].join('\n\n'), { tipo: 'aviso', chatOrigen, whatsapp: false });
    } else {
      let despertados = 0;
      try { despertados = alPedir ? alPedir({ id, detalle: String(detalle), quien, pedidaPor, chatOrigen }) : 0; } catch (e) { log.warn('[aprobaciones] alPedir', e.message); }
      avisos.alPropietario([texto, respuesta].join('\n\n'), { tipo: 'aviso', chatOrigen, whatsapp: !despertados });
    }
    auditar(db, 'aprobacion.pedir', { actor: String(pedidaPor ?? ''), decision: 'con_aprobacion', detalle: { id, accion } });
    return id;
  }

  function obtener(id) {
    const a = db.prepare('SELECT * FROM aprobaciones WHERE id = ?').get(String(id).toUpperCase());
    if (!a) throw new ErrorAprobacion(`No existe ${id}.`, 404);
    return { ...a, datos: json(a.datos, {}) };
  }

  async function decidir(id, { personaId, aprobar, comentario = null, donde = 'panel' }) {
    const a = obtener(id);
    if (a.estado !== 'pendiente') throw new ErrorAprobacion(`${a.id} ya está ${a.estado}.`, 409);
    let resultado = null;
    if (aprobar) {
      const ej = ejecutores[a.accion];
      try {
        resultado = ej ? await ej(a.datos, a) : null;
      } catch (e) {
        log.error('[aprobaciones]', a.id, e);
        throw new ErrorAprobacion(`Se aprobó pero falló al ejecutar: ${e.message}`, 500);
      }
    }
    db.prepare('UPDATE aprobaciones SET estado = ?, decidida_por = ?, comentario = ?, decidida = ? WHERE id = ?')
      .run(aprobar ? 'aprobada' : 'rechazada', personaId ?? null, comentario, reloj(), a.id);
    auditar(db, aprobar ? 'aprobacion.aprobar' : 'aprobacion.rechazar', { actor: String(personaId ?? ''), detalle: { id: a.id } });
    const final = { ...a, estado: aprobar ? 'aprobada' : 'rechazada', comentario, resultado, decidida_por: personaId ?? null };
    bitacora?.anotar({ personaId, pedidaPor: a.pedida_por, chatId: a.chat_origen, donde, resultado: aprobar ? 'aprobado' : 'rechazado', que: `${a.detalle}${comentario ? ` — ${comentario}` : ''}`, ref: a.id });
    try { alDecidir(final); } catch (e) { log.warn('[aprobaciones] alDecidir', e.message); }
    return final;
  }

  function listar({ estado = null } = {}) {
    const filas = estado
      ? db.prepare('SELECT * FROM aprobaciones WHERE estado = ? ORDER BY creada DESC LIMIT 100').all(estado)
      : db.prepare('SELECT * FROM aprobaciones ORDER BY creada DESC LIMIT 100').all();
    return filas.map((a) => ({ ...a, datos: json(a.datos, {}) }));
  }

  /** Valida un link firmado sin usarlo. Devuelve la aprobación y a quién está atado. */
  function enlace(token) {
    const e = db.prepare('SELECT * FROM enlaces WHERE hash = ?').get(sha(token ?? ''));
    if (!e) throw new ErrorAprobacion('Este link no es válido.', 404);
    if (e.usado) throw new ErrorAprobacion('Este link ya se usó.', 410);
    if (e.vence < reloj()) throw new ErrorAprobacion('Este link venció. Podés decidir desde el panel o respondiendo por WhatsApp.', 410);
    return { aprobacion: obtener(e.aprobacion_id), personaId: e.persona_id };
  }

  /** Decide con un link firmado: se marca usado antes de ejecutar (un solo uso). */
  async function decidirConEnlace(token, { aprobar, comentario = null }) {
    const { aprobacion, personaId } = enlace(token);
    const r = db.prepare('UPDATE enlaces SET usado = ? WHERE hash = ? AND usado IS NULL').run(reloj(), sha(token));
    if (!r.changes) throw new ErrorAprobacion('Este link ya se usó.', 410);
    return decidir(aprobacion.id, { personaId, aprobar, comentario });
  }

  return {
    pedir, obtener, listar, enlace, decidirConEnlace,
    aprobar: (id, o) => decidir(id, { ...o, aprobar: true }),
    rechazar: (id, o) => decidir(id, { ...o, aprobar: false }),
  };
}
