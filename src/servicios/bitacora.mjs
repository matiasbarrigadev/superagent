// Bitácora de decisiones: cada aprobación, rechazo o decisión queda anotada (quién, dónde, qué).
export function crearBitacora({ db, reloj = () => Date.now() }) {
  const ins = db.prepare(`INSERT INTO bitacora (ts, persona_id, pedida_por, chat_id, donde, resultado, que, ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  function anotar({ personaId = null, pedidaPor = null, chatId = null, donde = 'charla', resultado = 'decision', que, ref = null }) {
    if (!que) return null;
    return Number(ins.run(reloj(), personaId, pedidaPor, chatId, donde, resultado, String(que).slice(0, 1000), ref).lastInsertRowid);
  }

  function listar({ limite = 100, antes = null } = {}) {
    return db.prepare(`SELECT b.*, p.nombre AS persona, q.nombre AS pedida_por_nombre FROM bitacora b
      LEFT JOIN personas p ON p.id = b.persona_id LEFT JOIN personas q ON q.id = b.pedida_por
      ${antes ? 'WHERE b.id < ?' : ''} ORDER BY b.id DESC LIMIT ?`).all(...(antes ? [antes, limite] : [limite]));
  }

  return { anotar, listar };
}
