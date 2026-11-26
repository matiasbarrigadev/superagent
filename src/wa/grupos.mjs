// Grupos del número: WAHA los conoce aunque todavía nadie haya escrito. Se suman a `chats` como inactivos
// (decisión 30: un grupo nuevo no se atiende hasta que el Propietario lo activa) y se les pone el nombre.

export async function sincronizarGrupos(db, waha, log = console) {
  if (!waha?.grupos) return 0;
  let grupos;
  try { grupos = await waha.grupos(); } catch (e) { log.warn?.('[grupos]', e.message); return 0; }
  const ins = db.prepare(`INSERT INTO chats (id, tipo, cliente_id, activo, nombre, creado) VALUES (?, 'grupo', 1, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET nombre = COALESCE(excluded.nombre, chats.nombre)`);
  let n = 0;
  for (const g of grupos) {
    if (ins.run(g.id, g.nombre ?? null, Date.now()).changes) n++;
  }
  return n;
}
