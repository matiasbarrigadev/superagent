// Memoria por alcance (cuenta, cliente, proyecto, contacto) con las secciones de Sadie.
// Lo marcado como público es lo único de la cuenta, el cliente o el proyecto que ve un Tercero.

export const SECCIONES = ['Contexto', 'Comportamiento', 'Alcance', 'Decisiones', 'Pendientes', 'Historial'];

export function crearMemoria(db) {
  function guardar({ alcance, alcanceId = null, seccion, contenido, autor = null, publica = false }) {
    if (!SECCIONES.includes(seccion)) throw new Error(`Sección inválida. Usá una de: ${SECCIONES.join(', ')}.`);
    const texto = String(contenido ?? '').trim();
    if (!texto) throw new Error('El contenido está vacío.');
    return Number(db.prepare('INSERT INTO memoria (alcance, alcance_id, seccion, contenido, autor, publica, creada) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(alcance, alcanceId, seccion, texto.slice(0, 4000), autor, publica ? 1 : 0, Date.now()).lastInsertRowid);
  }

  function leer({ alcance, alcanceId = null, soloPublica = false }) {
    const filas = alcanceId == null
      ? db.prepare('SELECT * FROM memoria WHERE alcance = ? AND alcance_id IS NULL ORDER BY id').all(alcance)
      : db.prepare('SELECT * FROM memoria WHERE alcance = ? AND alcance_id = ? ORDER BY id').all(alcance, alcanceId);
    return soloPublica ? filas.filter((f) => f.publica) : filas;
  }

  /** Texto agrupado por sección, para el prompt. Lo más reciente de Historial va al final y recortado. */
  function formatear(filas) {
    if (!filas.length) return '';
    const out = [];
    for (const s of SECCIONES) {
      let items = filas.filter((f) => f.seccion === s);
      if (s === 'Historial') items = items.slice(-15);
      if (items.length) out.push(`### ${s}\n${items.map((f) => `- ${f.contenido}${f.publica ? ' (pública)' : ''}`).join('\n')}`);
    }
    return out.join('\n');
  }

  return { guardar, leer, formatear, borrar: (id) => db.prepare('DELETE FROM memoria WHERE id = ?').run(Number(id)).changes };
}
