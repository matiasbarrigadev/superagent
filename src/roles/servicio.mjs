// Personas y roles con las reglas fijas (TEORIA §2.5):
// siempre hay un Propietario, el rol Propietario no se edita y nadie da permisos que no tiene.
import { normalizar, excesos } from './permisos.mjs';
import { auditar } from '../db/index.mjs';
import { soloDigitos } from '../util.mjs';

export class ErrorRoles extends Error {
  constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
}

export function crearRoles({ db, politica }) {
  const qRol = db.prepare('SELECT * FROM roles WHERE id = ?');
  const idPropietario = () => db.prepare("SELECT id FROM roles WHERE nombre = 'Propietario' AND predefinido = 1").get().id;
  const propietariosActivos = () => db.prepare('SELECT COUNT(*) AS n FROM personas WHERE rol_id = ? AND activa = 1').get(idPropietario()).n;

  function rolOError(id) {
    const r = qRol.get(Number(id));
    if (!r) throw new ErrorRoles('Ese rol no existe.', 404);
    return r;
  }

  function validarNombre(nombre) {
    const n = String(nombre ?? '').trim();
    if (n.length < 2 || n.length > 40) throw new ErrorRoles('El nombre del rol tiene que tener entre 2 y 40 caracteres.');
    return n;
  }

  /** `actor`: { personaId, permisos } de quien hace el cambio. */
  function crearRol(actor, { nombre, descripcion, permisos }) {
    const n = validarNombre(nombre);
    const p = normalizar(permisos);
    const pasa = excesos(actor.permisos, p);
    if (pasa.length) throw new ErrorRoles(`No podés dar permisos que no tenés: ${pasa.join(', ')}.`, 403);
    if (db.prepare('SELECT 1 FROM roles WHERE nombre = ?').get(n)) throw new ErrorRoles('Ya hay un rol con ese nombre.', 409);
    const r = db.prepare('INSERT INTO roles (nombre, descripcion, permisos, predefinido, creado_por) VALUES (?, ?, ?, 0, ?)')
      .run(n, String(descripcion ?? '').slice(0, 300) || null, JSON.stringify(p), actor.personaId ?? null);
    auditar(db, 'rol.crear', { actor: String(actor.personaId ?? ''), detalle: { nombre: n, permisos: p } });
    return Number(r.lastInsertRowid);
  }

  function editarRol(actor, id, { nombre, descripcion, permisos }) {
    const r = rolOError(id);
    if (r.nombre === 'Propietario' && r.predefinido) throw new ErrorRoles('El rol Propietario no se puede editar.', 403);
    const p = permisos ? normalizar(permisos) : normalizar(r.permisos);
    const pasa = excesos(actor.permisos, p);
    if (pasa.length) throw new ErrorRoles(`No podés dar permisos que no tenés: ${pasa.join(', ')}.`, 403);
    const n = nombre != null && !r.predefinido ? validarNombre(nombre) : r.nombre;
    db.prepare('UPDATE roles SET nombre = ?, descripcion = ?, permisos = ? WHERE id = ?')
      .run(n, descripcion != null ? String(descripcion).slice(0, 300) : r.descripcion, JSON.stringify(p), r.id);
    auditar(db, 'rol.editar', { actor: String(actor.personaId ?? ''), detalle: { id: r.id, permisos: p } });
  }

  function borrarRol(actor, id) {
    const r = rolOError(id);
    if (r.predefinido) throw new ErrorRoles('Los roles predefinidos no se borran.', 403);
    const enUso = db.prepare('SELECT COUNT(*) AS n FROM personas WHERE rol_id = ?').get(r.id).n
      + db.prepare('SELECT COUNT(*) AS n FROM persona_cliente WHERE rol_id = ?').get(r.id).n;
    if (enUso) throw new ErrorRoles('Hay personas con ese rol: cambiales el rol primero.', 409);
    db.prepare('DELETE FROM roles WHERE id = ?').run(r.id);
    auditar(db, 'rol.borrar', { actor: String(actor.personaId ?? ''), detalle: { id: r.id, nombre: r.nombre } });
  }

  function listarRoles() {
    return db.prepare('SELECT id, nombre, descripcion, permisos, predefinido FROM roles ORDER BY predefinido DESC, id').all()
      .map((r) => ({ ...r, permisos: normalizar(r.permisos), predefinido: !!r.predefinido,
        personas: db.prepare('SELECT COUNT(*) AS n FROM personas WHERE rol_id = ? AND activa = 1').get(r.id).n }));
  }

  function validarRolAsignable(actor, rolId) {
    const r = rolOError(rolId);
    const pasa = excesos(actor.permisos, r.permisos);
    if (pasa.length) throw new ErrorRoles('No podés asignar un rol con más permisos que los tuyos.', 403);
    return r;
  }

  function buscarPorTelefono(tel) {
    const d = soloDigitos(tel);
    if (!d) return null;
    return db.prepare('SELECT * FROM personas WHERE telefono = ? OR (length(telefono) >= 10 AND substr(telefono, -10) = substr(?, -10)) ORDER BY alta_manual DESC, id LIMIT 1').get(d, d);
  }

  /**
   * Solo el primer Propietario verifica su número. A los Propietarios que suma un Propietario verificado los avala
   * él: quedan verificados sin pasar por el código.
   */
  function avalar(actor, personaId, rolId) {
    if (rolId !== idPropietario() || !actor?.personaId) return;
    const quien = db.prepare('SELECT verificada, rol_id FROM personas WHERE id = ?').get(actor.personaId);
    if (!quien?.verificada || quien.rol_id !== idPropietario()) return;
    db.prepare('UPDATE personas SET verificada = 1 WHERE id = ? AND telefono IS NOT NULL').run(personaId);
  }

  /** Alta por número. Si el número ya escribió (alta automática), se completa esa persona. */
  function altaPersona(actor, { nombre, telefono, rolId }) {
    const tel = soloDigitos(telefono);
    if (tel.length < 8 || tel.length > 15) throw new ErrorRoles('Número inválido: escribilo con código de país, solo dígitos.');
    const r = validarRolAsignable(actor, rolId);
    const nom = String(nombre ?? '').trim().slice(0, 80) || null;
    const previa = buscarPorTelefono(tel);
    let id;
    if (previa) {
      if (previa.rol_id === idPropietario() && r.id !== previa.rol_id && previa.activa && propietariosActivos() <= 1) {
        throw new ErrorRoles('Tiene que quedar al menos un Propietario.', 409);
      }
      db.prepare('UPDATE personas SET nombre = COALESCE(?, nombre), rol_id = ?, alta_manual = 1, activa = 1 WHERE id = ?').run(nom, r.id, previa.id);
      id = previa.id;
    } else {
      id = Number(db.prepare('INSERT INTO personas (nombre, telefono, rol_id, alta_manual, activa, creada) VALUES (?, ?, ?, 1, 1, ?)')
        .run(nom, tel, r.id, Date.now()).lastInsertRowid);
    }
    avalar(actor, id, r.id);
    auditar(db, 'persona.alta', { actor: String(actor.personaId ?? ''), detalle: { id, rol: r.nombre } });
    return id;
  }

  function cambiarRol(actor, personaId, rolId) {
    const p = db.prepare('SELECT * FROM personas WHERE id = ?').get(Number(personaId));
    if (!p) throw new ErrorRoles('Esa persona no existe.', 404);
    const r = validarRolAsignable(actor, rolId);
    if (p.rol_id === idPropietario() && r.id !== p.rol_id && propietariosActivos() <= 1) {
      throw new ErrorRoles('Tiene que quedar al menos un Propietario.', 409);
    }
    db.prepare('UPDATE personas SET rol_id = ?, alta_manual = 1 WHERE id = ?').run(r.id, p.id);
    avalar(actor, p.id, r.id);
    auditar(db, 'persona.rol', { actor: String(actor.personaId ?? ''), detalle: { id: p.id, rol: r.nombre } });
  }

  function editarPersona(actor, personaId, { nombre }) {
    db.prepare('UPDATE personas SET nombre = ? WHERE id = ?').run(String(nombre ?? '').trim().slice(0, 80) || null, Number(personaId));
    auditar(db, 'persona.editar', { actor: String(actor.personaId ?? ''), detalle: { id: Number(personaId) } });
  }

  /** Baja: la persona queda inactiva (vuelve a ser Tercero si escribe). El último Propietario no se da de baja. */
  function bajaPersona(actor, personaId) {
    const p = db.prepare('SELECT * FROM personas WHERE id = ?').get(Number(personaId));
    if (!p) throw new ErrorRoles('Esa persona no existe.', 404);
    if (p.rol_id === idPropietario() && p.activa && propietariosActivos() <= 1) {
      throw new ErrorRoles('No se puede dar de baja al último Propietario.', 409);
    }
    if (db.prepare('SELECT 1 FROM usuarios_web WHERE persona_id = ?').get(p.id)) {
      throw new ErrorRoles('Esa persona entra al panel: no se puede dar de baja desde acá.', 409);
    }
    db.prepare('UPDATE personas SET activa = 0, alta_manual = 0 WHERE id = ?').run(p.id);
    auditar(db, 'persona.baja', { actor: String(actor.personaId ?? ''), detalle: { id: p.id } });
  }

  function listarPersonas() {
    return db.prepare(`SELECT p.id, p.nombre, p.telefono, p.rol_id, r.nombre AS rol, p.alta_manual, p.verificada, p.activa,
        EXISTS (SELECT 1 FROM usuarios_web u WHERE u.persona_id = p.id) AS panel
      FROM personas p LEFT JOIN roles r ON r.id = p.rol_id
      WHERE p.activa = 1 ORDER BY p.alta_manual DESC, r.predefinido DESC, p.nombre`).all()
      .map((p) => ({ ...p, alta_manual: !!p.alta_manual, verificada: !!p.verificada, panel: !!p.panel }));
  }

  /** Rol de una persona en un cliente (6c). null en rolId borra la asignación. */
  function asignarEnCliente(actor, personaId, clienteId, rolId) {
    if (rolId == null) {
      db.prepare('DELETE FROM persona_cliente WHERE persona_id = ? AND cliente_id = ?').run(Number(personaId), Number(clienteId));
      return;
    }
    const r = validarRolAsignable(actor, rolId);
    db.prepare('INSERT INTO persona_cliente (persona_id, cliente_id, rol_id) VALUES (?, ?, ?) ON CONFLICT(persona_id, cliente_id) DO UPDATE SET rol_id = excluded.rol_id')
      .run(Number(personaId), Number(clienteId), r.id);
    auditar(db, 'persona.rol_cliente', { actor: String(actor.personaId ?? ''), detalle: { personaId, clienteId, rol: r.nombre } });
  }

  /**
   * Personas que parecen la misma (mismo nombre, o el mismo LID): suele pasar cuando alguien escribe primero en un
   * grupo, donde WhatsApp no muestra su número. Se proponen de a pares: la que tiene número queda.
   */
  function duplicados() {
    const activas = db.prepare('SELECT p.id, p.nombre, p.telefono, p.lid, p.alta_manual, r.nombre AS rol FROM personas p LEFT JOIN roles r ON r.id = p.rol_id WHERE p.activa = 1 ORDER BY p.id').all();
    const clave = (n) => String(n ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
    const pares = [];
    for (let i = 0; i < activas.length; i++) {
      for (let j = i + 1; j < activas.length; j++) {
        const a = activas[i], b = activas[j];
        const mismoNombre = clave(a.nombre) && clave(a.nombre) === clave(b.nombre);
        const mismoLid = a.lid && a.lid === b.lid;
        if (!mismoNombre && !mismoLid) continue;
        if (a.telefono && b.telefono && a.telefono !== b.telefono) continue; // dos números distintos: dos personas
        const [queda, quita] = !a.telefono && b.telefono ? [b, a] : [a, b];
        pares.push({ queda, quita });
      }
    }
    return pares;
  }

  // Columnas que apuntan a una persona (en cualquier tabla): al fusionar pasan a la que queda.
  const COLUMNAS_PERSONA = ['persona_id', 'persona_origen', 'pedida_por', 'pedido_por', 'creada_por', 'creado_por', 'decidida_por', 'aprobada_por', 'conectada_por', 'propuesta_por'];

  /** Une dos fichas de la misma persona: queda `quedaId` con todo lo de `quitaId`, que se desactiva. */
  function fusionarPersonas(actor, quedaId, quitaId) {
    if (!actor.permisos?.gestionar_personas) throw new ErrorRoles('No tenés permiso para gestionar personas.', 403);
    const queda = db.prepare('SELECT * FROM personas WHERE id = ?').get(Number(quedaId));
    const quita = db.prepare('SELECT * FROM personas WHERE id = ?').get(Number(quitaId));
    if (!queda || !quita) throw new ErrorRoles('Esa persona no existe.', 404);
    if (queda.id === quita.id) throw new ErrorRoles('Es la misma ficha.');
    if (queda.telefono && quita.telefono && queda.telefono !== quita.telefono) throw new ErrorRoles('Tienen números distintos: son dos personas.', 409);
    db.exec('BEGIN');
    try {
      const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_nueva'").all();
      for (const { name } of tablas) {
        if (name === 'personas') continue;
        for (const c of db.prepare(`PRAGMA table_info("${name}")`).all()) {
          if (COLUMNAS_PERSONA.includes(c.name)) db.prepare(`UPDATE OR IGNORE "${name}" SET "${c.name}" = ? WHERE "${c.name}" = ?`).run(queda.id, quita.id);
        }
      }
      db.prepare("UPDATE OR IGNORE memoria SET alcance_id = ? WHERE alcance = 'contacto' AND alcance_id = ?").run(queda.id, quita.id);
      // Si el rol de la que se va es "más" (por ejemplo Propietario), lo conserva la que queda.
      const rolQueda = queda.alta_manual ? queda.rol_id : (quita.alta_manual ? quita.rol_id : queda.rol_id);
      db.prepare(`UPDATE personas SET nombre = COALESCE(nombre, ?), telefono = COALESCE(telefono, ?), lid = COALESCE(lid, ?), rol_id = ?,
        alta_manual = MAX(alta_manual, ?), verificada = MAX(verificada, ?) WHERE id = ?`)
        .run(quita.nombre, quita.telefono, quita.lid, rolQueda, quita.alta_manual, quita.verificada, queda.id);
      db.prepare('UPDATE personas SET activa = 0, alta_manual = 0, verificada = 0, lid = NULL, telefono = NULL WHERE id = ?').run(quita.id);
      // Lo que llegue por ese LID se reconoce como la persona que queda.
      const tel = queda.telefono ?? quita.telefono;
      if (quita.lid && tel) db.prepare('INSERT INTO lids (lid, telefono, actualizado) VALUES (?, ?, ?) ON CONFLICT(lid) DO UPDATE SET telefono = excluded.telefono').run(quita.lid, tel, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    auditar(db, 'persona.fusionar', { actor: String(actor.personaId ?? ''), detalle: { queda: queda.id, quita: quita.id } });
    return queda.id;
  }

  return {
    crearRol, editarRol, borrarRol, listarRoles, duplicados, fusionarPersonas,
    altaPersona, cambiarRol, editarPersona, bajaPersona, listarPersonas, buscarPorTelefono, asignarEnCliente,
    idPropietario, propietariosActivos, politica,
  };
}
