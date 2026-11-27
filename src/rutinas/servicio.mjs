// Rutinas que ya existen: listarlas y cambiarlas (instrucción, horario, destino, con qué permisos corren, pausa) o
// borrarlas. Lo usan la herramienta `rutinas` del agente y el panel. Cada cambio queda en la bitácora con quién lo
// hizo, así un Propietario ve lo que cambió el otro.
import { proxima, zonaValida } from './cron.mjs';
import { auditar } from '../db/index.mjs';
import { json } from '../util.mjs';

export function crearRutinas({ db, bitacora = null, chatDeDestino, reloj = () => Date.now() }) {
  const numero = (id) => Number(String(id ?? '').trim().replace(/^R-/i, ''));
  const obtener = (id) => db.prepare('SELECT * FROM rutinas WHERE id = ?').get(numero(id)) ?? null;
  const nombreDe = (pid) => {
    const p = pid ? db.prepare('SELECT nombre, telefono FROM personas WHERE id = ?').get(pid) : null;
    return p ? (p.nombre ?? `+${p.telefono}`) : null;
  };
  const nombreChat = (chatId) => {
    if (!chatId) return '—';
    const c = db.prepare('SELECT nombre FROM chats WHERE id = ?').get(chatId);
    const p = db.prepare("SELECT nombre FROM personas WHERE telefono = ? AND activa = 1").get(String(chatId).split('@')[0]);
    return c?.nombre ?? p?.nombre ?? chatId;
  };

  function listar() {
    return db.prepare(`SELECT r.*, p.nombre AS creador, q.nombre AS corre_como FROM rutinas r
      LEFT JOIN personas p ON p.id = r.creada_por LEFT JOIN personas q ON q.id = r.ejecuta_como ORDER BY r.id`).all()
      .map((r) => ({ ...r, destinos: json(r.destinos, []), activa: !!r.activa, aprobada: !!r.aprobada, destino_nombre: nombreChat(r.chat_destino) }));
  }

  /** Una línea por rutina, para el contexto del agente y la herramienta. */
  function describir(r) {
    const estado = !r.aprobada ? 'sin aprobar' : r.activa ? 'activa' : `pausada${r.pausa_motivo ? ` (${r.pausa_motivo})` : ''}`;
    const como = r.ejecuta_como && r.ejecuta_como !== r.creada_por ? `corre con permisos de ${nombreDe(r.ejecuta_como) ?? 'un Propietario'}` : 'corre con los permisos de quien la pidió';
    return `R-${r.id} [${estado}] "${r.cuando}" (${r.zona_horaria}); la pidió ${nombreDe(r.creada_por) ?? 'alguien'}; ${como}; le llega a ${nombreChat(r.chat_destino)}: ${String(r.instruccion).slice(0, 160)}`;
  }

  function anotar(r, que, { actorId = null, donde = 'charla', chatId = null } = {}) {
    bitacora?.anotar({ personaId: actorId, chatId, donde, resultado: 'hecho', que: `Rutina R-${r.id}: ${que}`, ref: `R-${r.id}` });
    auditar(db, 'rutina.cambiar', { actor: String(actorId ?? ''), detalle: { id: r.id, que } });
  }

  /**
   * cambios: { instruccion, cuando, zona_horaria, destino, destinos, corre_como ('propietario' | 'quien_la_pidio'), activa }.
   * "corre_como: propietario" la deja corriendo con los permisos de quien hace el cambio (tiene que ser Propietario).
   */
  function cambiar(id, cambios = {}, { actorId = null, donde = 'charla', chatId = null } = {}) {
    const r = obtener(id);
    if (!r) throw new Error(`No existe la rutina R-${numero(id)}.`);
    const set = {};
    const que = [];
    if (cambios.instruccion != null) {
      const t = String(cambios.instruccion).trim().slice(0, 4000);
      if (!t) throw new Error('La instrucción no puede quedar vacía.');
      if (t !== r.instruccion) { set.instruccion = t; que.push('nueva instrucción'); }
    }
    const cuando = cambios.cuando != null ? String(cambios.cuando).trim() : r.cuando;
    const tz = cambios.zona_horaria != null ? String(cambios.zona_horaria).trim() : r.zona_horaria;
    if (cuando !== r.cuando || tz !== r.zona_horaria) {
      if (!zonaValida(tz)) throw new Error(`Zona horaria inválida: ${tz}.`);
      const p = proxima(cuando, tz, reloj());
      if (!p) throw new Error('Esa expresión no se cumple nunca.');
      Object.assign(set, { cuando, zona_horaria: tz, proxima: p });
      que.push(`horario "${cuando}" (${tz})`);
    }
    let destinos = json(r.destinos, []);
    if (cambios.destino != null) {
      const d = chatDeDestino(cambios.destino);
      if (!d) throw new Error('El destino tiene que ser un teléfono con código de país o un chat.');
      if (d !== r.chat_destino) { set.chat_destino = d; destinos = [d, ...destinos]; que.push(`ahora le llega a ${nombreChat(d)}`); }
    }
    if (cambios.destinos != null) {
      const lista = (Array.isArray(cambios.destinos) ? cambios.destinos : [cambios.destinos]).map(chatDeDestino);
      if (lista.some((x) => !x)) throw new Error('Algún destino no es un teléfono o chat válido.');
      destinos = lista;
      que.push(`destinos: ${lista.map(nombreChat).join(', ')}`);
    }
    const principal = set.chat_destino ?? r.chat_destino;
    const unicos = [...new Set([principal, ...destinos].filter(Boolean))];
    if (JSON.stringify(unicos) !== JSON.stringify(json(r.destinos, []))) set.destinos = JSON.stringify(unicos);
    if (cambios.corre_como != null) {
      if (cambios.corre_como === 'propietario') {
        if (!actorId) throw new Error('Falta quién la aprueba.');
        if (r.ejecuta_como !== actorId) { set.ejecuta_como = actorId; que.push(`corre con los permisos de ${nombreDe(actorId) ?? 'el Propietario'}`); }
      } else if (cambios.corre_como === 'quien_la_pidio') {
        if (r.ejecuta_como != null) { set.ejecuta_como = null; que.push(`corre con los permisos de ${nombreDe(r.creada_por) ?? 'quien la pidió'}`); }
      } else throw new Error('corre_como es "propietario" o "quien_la_pidio".');
    }
    if (cambios.activa != null) {
      const activa = !!cambios.activa;
      if (activa && !r.aprobada) throw new Error('Primero hay que aprobarla.');
      if (activa !== !!r.activa) {
        set.activa = activa ? 1 : 0;
        set.pausa_motivo = activa ? null : `Pausada por ${nombreDe(actorId) ?? 'el Propietario'}${donde === 'panel' ? ' desde el panel' : ''}.`;
        if (activa && (!r.proxima || r.proxima <= reloj()) && !set.proxima) set.proxima = proxima(set.cuando ?? r.cuando, set.zona_horaria ?? r.zona_horaria, reloj());
        que.push(activa ? 'reactivada' : 'pausada');
      }
    }
    if (!Object.keys(set).length) return { rutina: r, que: [] };
    const cols = Object.keys(set);
    db.prepare(`UPDATE rutinas SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), r.id);
    if (que.length) anotar(r, que.join('; '), { actorId, donde, chatId });
    return { rutina: obtener(r.id), que };
  }

  function borrar(id, { actorId = null, donde = 'charla', chatId = null } = {}) {
    const r = obtener(id);
    if (!r) return false;
    db.prepare('DELETE FROM rutinas WHERE id = ?').run(r.id);
    anotar(r, `borrada ("${String(r.instruccion).slice(0, 120)}")`, { actorId, donde, chatId });
    return true;
  }

  return { listar, obtener, describir, cambiar, borrar, anotar, nombreChat };
}
