// Propuestas P-n (onboarding y "agregá a Juan como…"): el agente propone, el Propietario confirma.
// Hasta que se confirma, una propuesta no cambia ningún permiso.
import { normalizar, enPalabras } from '../roles/permisos.mjs';
import { json } from '../util.mjs';
import { auditar } from '../db/index.mjs';

export class ErrorPropuesta extends Error {
  constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
}

export function crearPropuestas({ db, bitacora = null, roles, aplicadores = {}, alDecidir = () => {} }) {
  function crear({ tipo, datos, personaOrigen = null, chatOrigen = null }) {
    const d = tipo === 'rol' ? { ...datos, permisos: normalizar(datos.permisos) } : datos;
    const id = Number(db.prepare(`INSERT INTO propuestas (tipo, datos, estado, propuesta_por, creada, chat_origen, persona_origen)
      VALUES (?, ?, 'pendiente', 'agente', ?, ?, ?)`).run(tipo, JSON.stringify(d), Date.now(), chatOrigen, personaOrigen).lastInsertRowid);
    return `P-${id}`;
  }

  const numero = (id) => Number(String(id).replace(/^P-?/i, ''));

  function obtener(id) {
    const p = db.prepare('SELECT * FROM propuestas WHERE id = ?').get(numero(id));
    if (!p) throw new ErrorPropuesta(`No existe ${id}.`, 404);
    return describir(p);
  }

  /** Una línea para la bitácora. */
  function resumenDe(p) {
    const d = p.datos ?? {};
    return { rol: `rol "${d.nombre}"`, persona: `alta de ${d.nombre ?? ''} (+${d.telefono ?? ''}) como ${d.rol}`, cliente: `cliente "${d.nombre}"`, sesion: `sesión de proyecto "${d.nombre}"` }[p.tipo] ?? `${p.tipo} ${d.nombre ?? ''}`;
  }

  function describir(p) {
    const datos = json(p.datos, {});
    return {
      id: `P-${p.id}`, tipo: p.tipo, estado: p.estado, creada: p.creada, chat_origen: p.chat_origen, datos,
      permisos: p.tipo === 'rol' ? enPalabras(datos.permisos) : null,
    };
  }

  /** actor: { personaId, permisos }. Aplica la propuesta con las reglas fijas de roles. */
  function confirmar(id, actor, { avisar = true, donde = 'panel' } = {}) {
    const p = obtener(id);
    if (p.estado !== 'pendiente') throw new ErrorPropuesta(`${p.id} ya está ${p.estado}.`, 409);
    let creado;
    if (p.tipo === 'rol') {
      creado = roles.crearRol(actor, p.datos);
    } else if (aplicadores[p.tipo]) {
      // Clientes y sesiones de proyecto: los aplica quien los conoce (núcleo).
      creado = aplicadores[p.tipo](p.datos, actor, p);
    } else {
      const rol = db.prepare('SELECT id FROM roles WHERE nombre = ?').get(String(p.datos.rol ?? ''));
      if (!rol) throw new ErrorPropuesta(`El rol "${p.datos.rol}" no existe todavía: confirmá primero la propuesta del rol.`, 409);
      creado = roles.altaPersona(actor, { nombre: p.datos.nombre, telefono: p.datos.telefono, rolId: rol.id });
    }
    db.prepare("UPDATE propuestas SET estado = 'confirmada', decidida_por = ? WHERE id = ?").run(actor.personaId ?? null, numero(id));
    auditar(db, 'propuesta.confirmar', { actor: String(actor.personaId ?? ''), detalle: { id: p.id, tipo: p.tipo } });
    const final = { ...p, estado: 'confirmada', creado };
    bitacora?.anotar({ personaId: actor.personaId, pedidaPor: db.prepare('SELECT persona_origen FROM propuestas WHERE id = ?').get(numero(id))?.persona_origen ?? null, chatId: p.chat_origen ?? null, donde, resultado: 'aprobado', que: resumenDe(p), ref: p.id });
    if (avisar) try { alDecidir(final); } catch {}
    return final;
  }

  function descartar(id, actor, { donde = 'panel' } = {}) {
    const p = obtener(id);
    if (p.estado !== 'pendiente') throw new ErrorPropuesta(`${p.id} ya está ${p.estado}.`, 409);
    db.prepare("UPDATE propuestas SET estado = 'descartada', decidida_por = ? WHERE id = ?").run(actor.personaId ?? null, numero(id));
    const final = { ...p, estado: 'descartada' };
    bitacora?.anotar({ personaId: actor.personaId, pedidaPor: db.prepare('SELECT persona_origen FROM propuestas WHERE id = ?').get(numero(id))?.persona_origen ?? null, chatId: p.chat_origen ?? null, donde, resultado: 'rechazado', que: resumenDe(p), ref: p.id });
    try { alDecidir(final); } catch {}
    return final;
  }

  function listar({ estado = null } = {}) {
    const filas = estado
      ? db.prepare('SELECT * FROM propuestas WHERE estado = ? ORDER BY id DESC LIMIT 100').all(estado)
      : db.prepare('SELECT * FROM propuestas ORDER BY id DESC LIMIT 100').all();
    return filas.map(describir);
  }

  return { crear, obtener, confirmar, descartar, listar };
}
