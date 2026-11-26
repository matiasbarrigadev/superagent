// Lo que hace el gateway al publicar (directo del Propietario o al aprobar un A-n): merge del PR en GitHub
// o, en repos que no son de GitHub, merge de la rama en el espejo y push. También: activar instrucciones.
import { auditar } from '../db/index.mjs';

export function crearPublicador({ db, repos, github, procedimientos = null }) {
  /**
   * Publicar = merge (si hay PR o rama) y, si el proyecto tiene procedimiento, la corrida de publicación
   * (respaldo, ensayo, migraciones, deploy y verificación). Sin procedimiento no hay deploy.
   */
  async function publicarAhora({ proyecto, pr, rama }, { pedidaPor = null, aprobacionId = null } = {}) {
    const p = repos.proyecto(proyecto);
    const partes = [];
    if (repos.esGithub(p) && pr) {
      const r = await github.mergearPr(p.repo, pr);
      auditar(db, 'codigo.publicar', { decision: 'merge', detalle: { proyecto: p.id, pr, sha: r?.sha } });
      partes.push(`PR #${pr} mergeado en ${p.nombre} (${String(r?.sha ?? '').slice(0, 7)}).`);
    } else if (!repos.esGithub(p) && rama) {
      await repos.mergeLocal(p.id, rama);
      auditar(db, 'codigo.publicar', { decision: 'merge', detalle: { proyecto: p.id, rama } });
      partes.push(`Rama ${rama} publicada en ${p.nombre} (${p.rama_principal}).`);
    }
    const conProcedimiento = !!p.procedimiento_publicacion && procedimientos;
    if (!conProcedimiento) {
      if (!partes.length) throw new Error(`${p.nombre} no tiene un procedimiento de publicación: no hay nada que publicar. Cargalo en el panel (Conexiones → Proyectos).`);
      return `${partes.join(' ')} (Este proyecto no tiene procedimiento de publicación: el deploy no corre.)`;
    }
    const r = await procedimientos.publicar(p.id, { pedidaPor, aprobacionId });
    partes.push(r.resultado);
    if (!r.ok) throw Object.assign(new Error(partes.join(' ')), { publicacion: r });
    return partes.join(' ');
  }

  function activarInstrucciones(version, aprobadaPor = null) {
    const v = db.prepare('SELECT version FROM instrucciones WHERE version = ?').get(version);
    if (!v) throw new Error(`No existe la versión ${version}.`);
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE instrucciones SET activa = 0').run();
      db.prepare('UPDATE instrucciones SET activa = 1, aprobada_por = COALESCE(aprobada_por, ?) WHERE version = ?').run(aprobadaPor, version);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    auditar(db, 'instrucciones.activar', { actor: String(aprobadaPor ?? ''), detalle: { version } });
    return `Instrucciones v${version} activas.`;
  }

  return { publicarAhora, activarInstrucciones };
}

/** Diff de líneas, simple y legible (para cambios de instrucciones). */
export function diffTexto(antes, despues) {
  const a = String(antes ?? '').split('\n'), b = String(despues ?? '').split('\n');
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return `--- antes (${n} líneas)\n+++ después (${m} líneas)\n(demasiado largo para comparar)`;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = ['--- antes', '+++ después'];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
  }
  return out.join('\n');
}
