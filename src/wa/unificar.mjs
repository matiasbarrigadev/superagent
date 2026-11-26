// WhatsApp identifica a un contacto por teléfono ("<num>@c.us") o por LID ("<id>@lid"). Para que la misma
// persona tenga un solo chat, los directos se guardan con el JID del teléfono cuando se conoce; esto mueve un
// chat @lid viejo (y todo lo que cuelga de él) al chat del teléfono.

const COLUMNAS = ['chat_id', 'chat_origen', 'chat_destino'];

function columnasDeChat(db) {
  const out = [];
  const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_nueva'").all();
  for (const { name } of tablas) {
    if (name === 'chats') continue;
    for (const c of db.prepare(`PRAGMA table_info("${name}")`).all()) {
      if (COLUMNAS.includes(c.name)) out.push([name, c.name]);
    }
  }
  return out;
}

/** Mueve el chat `desde` a `hacia`. Si los dos existen, se fusionan (queda activo si cualquiera lo estaba). */
export function moverChat(db, desde, hacia) {
  if (!desde || !hacia || desde === hacia) return false;
  const viejo = db.prepare('SELECT * FROM chats WHERE id = ?').get(desde);
  if (!viejo) return false;
  db.exec('BEGIN');
  try {
    const nuevo = db.prepare('SELECT * FROM chats WHERE id = ?').get(hacia);
    if (nuevo) {
      db.prepare(`UPDATE chats SET persona_id = COALESCE(persona_id, ?), nombre = COALESCE(NULLIF(nombre, ''), ?),
        activo = MAX(activo, ?), creado = MIN(creado, ?) WHERE id = ?`).run(viejo.persona_id, viejo.nombre, viejo.activo, viejo.creado, hacia);
    } else {
      db.prepare('UPDATE chats SET id = ? WHERE id = ?').run(hacia, desde);
    }
    for (const [t, c] of columnasDeChat(db)) {
      // UPDATE OR IGNORE: en tablas con clave (chat_id, …) gana lo que ya tenía el chat destino.
      db.prepare(`UPDATE OR IGNORE "${t}" SET "${c}" = ? WHERE "${c}" = ?`).run(hacia, desde);
      db.prepare(`DELETE FROM "${t}" WHERE "${c}" = ?`).run(desde);
    }
    db.prepare("UPDATE OR IGNORE ajustes SET clave = ? WHERE clave = ?").run(`inbox_leido:${hacia}`, `inbox_leido:${desde}`);
    db.prepare("DELETE FROM ajustes WHERE clave = ?").run(`inbox_leido:${desde}`);
    db.prepare('DELETE FROM chats WHERE id = ?').run(desde);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Al arrancar: todo chat directo @lid cuyo teléfono ya se conoce pasa al chat del teléfono. */
export function unificarChatsLid(db, log = console) {
  const filas = db.prepare(`SELECT c.id, COALESCE(l.telefono, p.telefono) AS telefono FROM chats c
    LEFT JOIN lids l ON l.lid = c.id LEFT JOIN personas p ON p.id = c.persona_id
    WHERE c.tipo = 'directo' AND c.id LIKE '%@lid'`).all();
  let n = 0;
  for (const f of filas) {
    if (!f.telefono) continue;
    try { if (moverChat(db, f.id, `${f.telefono}@c.us`)) n++; } catch (e) { log.warn('[chats] no se pudo unificar', f.id, e.message); }
  }
  if (n) log.info?.(`[chats] ${n} chat(s) @lid unificados con el del teléfono`);
  return n;
}

/**
 * Reparación: mensajes que mandó el agente y quedaron guardados en el chat de su propio número (GOWS pone el
 * propio número como destino en los grupos). Se mueven al chat al que salieron, según la cola de salida.
 */
export function repararChatPropio(db, yo, log = console) {
  if (!yo) return 0;
  const filas = db.prepare('SELECT seq, cuerpo FROM mensajes WHERE chat_id = ? AND from_me = 1').all(yo);
  const destino = db.prepare("SELECT chat_id FROM salida WHERE contenido = ? AND chat_id != ? AND estado = 'enviado' ORDER BY id DESC LIMIT 1");
  const mover = db.prepare('UPDATE mensajes SET chat_id = ? WHERE seq = ?');
  let n = 0;
  for (const f of filas) {
    const d = destino.get(f.cuerpo ?? '', yo);
    if (d?.chat_id) { mover.run(d.chat_id, f.seq); n++; }
  }
  // Si el chat del propio número quedó vacío, se borra (no es una conversación).
  if (!db.prepare('SELECT 1 FROM mensajes WHERE chat_id = ? LIMIT 1').get(yo)) db.prepare('DELETE FROM chats WHERE id = ?').run(yo);
  if (n) log.info?.(`[chats] ${n} mensaje(s) propios movidos a su chat`);
  return n;
}
