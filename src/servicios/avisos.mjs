// Avisos al Propietario: quedan en el panel y, si su número está verificado, le llegan por WhatsApp.
export function crearAvisos({ db, salida, log = console }) {
  /** Chats de WhatsApp de los Propietarios con número verificado. */
  function chatsPropietario() {
    return db.prepare(`SELECT p.telefono FROM personas p JOIN roles r ON r.id = p.rol_id
      WHERE r.nombre = 'Propietario' AND r.predefinido = 1 AND p.activa = 1 AND p.verificada = 1 AND p.telefono IS NOT NULL`).all()
      .map((r) => `${r.telefono}@c.us`);
  }

  function alPropietario(texto, { tipo = 'aviso', chatOrigen = null, personaOrigen = null, whatsapp = true } = {}) {
    const id = Number(db.prepare('INSERT INTO avisos (tipo, texto, chat_origen, persona_origen, ts) VALUES (?, ?, ?, ?, ?)')
      .run(tipo, String(texto).slice(0, 4000), chatOrigen, personaOrigen, Date.now()).lastInsertRowid);
    if (whatsapp) {
      for (const chat of chatsPropietario()) salida.encolar({ chatId: chat, texto, origen: `aviso:${id}` });
      salida.procesar().catch((e) => log.warn('[avisos]', e.message));
    }
    return id;
  }

  function consultasAbiertas() {
    return db.prepare(`SELECT a.id, a.texto, a.chat_origen, a.ts, p.nombre, p.telefono FROM avisos a LEFT JOIN personas p ON p.id = a.persona_origen
      WHERE a.tipo = 'consulta' AND a.estado = 'abierto' ORDER BY a.id DESC LIMIT 20`).all();
  }

  const resolverConsultasDe = (chatId) => db.prepare("UPDATE avisos SET estado = 'resuelto' WHERE tipo = 'consulta' AND chat_origen = ? AND estado = 'abierto'").run(chatId);

  function listar({ limite = 50 } = {}) {
    return db.prepare('SELECT * FROM avisos ORDER BY id DESC LIMIT ?').all(limite);
  }

  return {
    alPropietario, chatsPropietario, consultasAbiertas, resolverConsultasDe, listar,
    marcarLeidos: () => db.prepare('UPDATE avisos SET leido = 1 WHERE leido = 0').run().changes,
    resolver: (id) => db.prepare("UPDATE avisos SET estado = 'resuelto', leido = 1 WHERE id = ?").run(Number(id)).changes,
  };
}
