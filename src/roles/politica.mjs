// Motor de política: dado (persona, cliente del chat, acción) devuelve permitir, con_aprobacion o negar.
// Lo usan el armado de la corrida, el MCP del gateway y el panel. El modelo nunca decide sus permisos.
import { normalizar, nivel } from './permisos.mjs';

// externo: la acción tiene efecto fuera de la conversación y por eso la autonomía del cliente la puede frenar.
// importante: la frena también "consultar lo importante".
export const ACCIONES = {
  conversar: { permiso: 'conversar' },
  responder: { permiso: 'conversar' },
  preguntar_al_propietario: { permiso: 'conversar' },
  guardar_memoria_contacto: { permiso: 'conversar' },
  guardar_memoria: { permiso: 'cambiar_agente', externo: true },
  cambiar_instrucciones: { permiso: 'cambiar_agente', externo: true, importante: true },
  leer_codigo: { permiso: 'trabajar_en_codigo', minimo: 'solo_leer' },
  editar_codigo: { permiso: 'trabajar_en_codigo', minimo: 'en_rama' },
  publicar: { permiso: 'publicar_sistemas', externo: true, importante: true },
  usar_web: { permiso: 'usar_web' },
  programar_rutina: { permiso: 'programar_rutinas', externo: true },
  iniciar_conversacion: { permiso: 'iniciar_conversacion', externo: true, importante: true },
  gestionar_personas: { permiso: 'gestionar_personas' },
  gestionar_roles: { permiso: 'gestionar_roles' },
  aprobar: { permiso: 'aprobar' },
  // El Propietario siempre ve el consumo; a otros se lo da él.
  ver_consumo: { especial: (p) => p.ver_consumo === true || p.aprobar === true },
  conectar_cuentas: { permiso: 'conectar_cuentas' },
  conectar_mis_cuentas: { permiso: 'conectar_mis_cuentas' },
  // Conectores (herramientas del negocio): leer y escribir.
  conector_leer: { permiso: 'herramientas_negocio', minimo: 'lectura' },
  conector_escribir: { permiso: 'herramientas_negocio', minimo: 'lectura_escritura', externo: true, importante: true },
  agregar_conector: { permiso: 'conectar_cuentas' },
  // Delegar (subagentes, trabajos) solo tiene sentido si el rol trabaja con algo: código o web.
  delegar: { especial: (p) => p.trabajar_en_codigo !== 'no' || p.usar_web === true },
};

const MOTIVOS = {
  gestionar_roles: 'Solo el Propietario (o quien tenga permiso de gestionar roles) puede crear o cambiar roles.',
  gestionar_personas: 'Solo el Propietario (o quien tenga permiso de gestionar personas) puede dar de alta personas o cambiarles el rol.',
  aprobar: 'Solo el Propietario puede aprobar.',
};

/** Decisión pura sobre un objeto de permisos y la autonomía del cliente. */
export function decidir(permisos, accion, autonomia = 'via_libre') {
  const def = ACCIONES[accion];
  if (!def) return { decision: 'negar', motivo: `Acción desconocida: ${accion}.` };
  const p = normalizar(permisos);
  let decision;
  if (def.especial) {
    decision = def.especial(p) ? 'permitir' : 'negar';
  } else {
    const v = p[def.permiso];
    if (def.minimo != null) decision = nivel(def.permiso, v) >= nivel(def.permiso, def.minimo) ? 'permitir' : 'negar';
    else if (v === true || v === 'directo' || v === 'lectura_escritura') decision = 'permitir';
    else if (v === 'con_aprobacion') decision = 'con_aprobacion';
    else decision = 'negar';
  }
  // La autonomía del cliente se suma: con "consultar todo", hasta lo directo pasa por el Propietario.
  if (decision === 'permitir' && def.externo) {
    if (autonomia === 'consultar_todo' || (autonomia === 'consultar_lo_importante' && def.importante)) decision = 'con_aprobacion';
  }
  const motivo = decision === 'negar' ? (MOTIVOS[accion] ?? 'Tu rol no lo permite.') : null;
  return { decision, motivo };
}

export function crearPolitica(db) {
  const qRol = db.prepare('SELECT id, nombre, permisos, predefinido FROM roles WHERE id = ?');
  const qRolNombre = db.prepare('SELECT id, nombre, permisos, predefinido FROM roles WHERE nombre = ? AND predefinido = 1');
  const qPersona = db.prepare('SELECT id, nombre, telefono, rol_id, activa, alta_manual FROM personas WHERE id = ?');
  const qPC = db.prepare('SELECT rol_id FROM persona_cliente WHERE persona_id = ? AND cliente_id = ?');
  const qCliente = db.prepare('SELECT id, nombre, tipo, autonomia, estado FROM clientes WHERE id = ?');

  const rol = (r) => (r ? { id: r.id, nombre: r.nombre, permisos: normalizar(r.permisos), predefinido: !!r.predefinido } : null);
  const tercero = () => rol(qRolNombre.get('Tercero'));

  /** Rol de una persona en un cliente: el de persona_cliente, si no el rol por defecto, si no Tercero. */
  function rolDe(personaId, clienteId = 1) {
    const p = personaId ? qPersona.get(personaId) : null;
    if (!p || !p.activa) return tercero();
    const pc = clienteId ? qPC.get(p.id, clienteId) : null;
    return rol(qRol.get(pc?.rol_id ?? p.rol_id)) ?? tercero();
  }

  function cliente(clienteId) {
    return qCliente.get(clienteId ?? 1) ?? qCliente.get(1);
  }

  /** Contexto de política para (persona, cliente): rol resuelto y una función decidir(acción). */
  function para({ personaId, clienteId = 1 }) {
    const r = rolDe(personaId, clienteId);
    const c = cliente(clienteId);
    return {
      rol: r,
      cliente: c,
      decidir: (accion) => decidir(r.permisos, accion, c?.autonomia),
    };
  }

  return { rolDe, cliente, para, tercero, propietario: () => rol(qRolNombre.get('Propietario')) };
}
