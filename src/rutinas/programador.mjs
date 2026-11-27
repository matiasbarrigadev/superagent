// Programador de rutinas: a la hora indicada despierta al orquestador con la instrucción guardada.
// Cada ejecución vuelve a revisar el rol de quien la creó; si ya no puede, la rutina se pausa y se avisa.
import { proxima } from './cron.mjs';
import { auditar } from '../db/index.mjs';

export function crearProgramador({ db, politica, motor, avisos, bitacora = null, log = console }) {
  function tick(ahora) {
    const vencidas = db.prepare('SELECT * FROM rutinas WHERE activa = 1 AND aprobada = 1 AND proxima IS NOT NULL AND proxima <= ?').all(ahora);
    for (const r of vencidas) {
      // Si el Propietario la aprobó para que corra con sus permisos, corre con él; si no, con quien la pidió.
      const quien = r.ejecuta_como ?? r.creada_por;
      const creador = quien ? db.prepare('SELECT id, nombre, activa FROM personas WHERE id = ?').get(quien) : null;
      const cliente = db.prepare('SELECT cliente_id FROM chats WHERE id = ?').get(r.chat_destino)?.cliente_id ?? 1;
      const d = politica.para({ personaId: creador?.id ?? null, clienteId: cliente }).decidir('programar_rutina');
      if (!creador || !creador.activa || d.decision === 'negar') {
        db.prepare('UPDATE rutinas SET activa = 0, pausa_motivo = ? WHERE id = ?').run('Quien la creó ya no tiene permiso para programar rutinas.', r.id);
        avisos.alPropietario(`La rutina R-${r.id} se pausó: ${creador?.nombre ?? 'quien la creó'} ya no tiene permiso para programar rutinas.`, { tipo: 'aviso' });
        auditar(db, 'rutina.pausar', { detalle: { id: r.id } });
        bitacora?.anotar({ donde: 'sistema', resultado: 'hecho', que: `Rutina R-${r.id}: pausada por el sistema (${creador?.nombre ?? 'quien la creó'} ya no tiene permiso para programar rutinas)`, ref: `R-${r.id}` });
        continue;
      }
      let sig = null;
      try { sig = proxima(r.cuando, r.zona_horaria, ahora); } catch (e) { log.warn('[rutinas]', r.id, e.message); }
      db.prepare('UPDATE rutinas SET ultima = ?, proxima = ? WHERE id = ?').run(ahora, sig, r.id);
      motor.despertar({ chatId: r.chat_destino, personaId: quien, texto: `[rutina R-${r.id}] ${r.instruccion}`, origen: `rutina:${r.id}` });
    }
    return vencidas.length;
  }
  return { tick };
}
