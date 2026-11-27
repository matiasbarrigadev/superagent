// Ficha de un rol: qué puede hacer de verdad (lo que el gateway hace cumplir) y qué queda solo como instrucción.
// El agente se la explica al Propietario antes de crear o cambiar un rol, o de habilitarle un conector, y recién
// aplica cuando el Propietario confirma. Se arma con los datos reales, no con lo que el modelo cree.
import { enPalabras, normalizar } from './permisos.mjs';
import { json } from '../util.mjs';
import { soloLectura, pideSoloLectura } from '../conectores/lectura.mjs';

/** Conectores activos de la instalación con sus herramientas (lectura / escritura) y los roles que los tienen. */
function conectoresActivos(db) {
  return db.prepare("SELECT id, app, permisos, habilitada_para, url_mcp FROM conexiones WHERE estado = 'activa' AND alcance <> 'persona' ORDER BY id").all()
    .map(herramientasDe);
}

/** Herramientas de un conector separadas en lectura y escritura (si es de solo lectura, todas leen). */
function herramientasDe(c, { soloLecturaForzada = null } = {}) {
  const hab = json(c.habilitada_para, { roles: [], apagadas: [] });
  const hs = json(c.permisos, []).filter((h) => !(hab.apagadas ?? []).includes(h.nombre));
  const sl = soloLecturaForzada ?? soloLectura(c);
  const escribe = (h) => h.escribe && !sl;
  return { id: c.id, app: c.app, roles: hab.roles ?? [], soloLectura: sl, lee: hs.filter((h) => !escribe(h)).map((h) => h.nombre), escribe: hs.filter(escribe).map((h) => h.nombre) };
}

const lista = (xs, n = 12) => (xs.length > n ? `${xs.slice(0, n).join(', ')} y ${xs.length - n} más` : xs.join(', '));

/** Cómo usa un rol un conector, según su nivel de herramientas del negocio. */
function usoDeConector(c, permisos, esPropietario) {
  const nivelNeg = permisos.herramientas_negocio;
  if (nivelNeg === 'ninguna') return `${c.app}: habilitado, pero el rol no usa herramientas del negocio (no lo usa).`;
  const partes = [];
  if (c.lee.length) partes.push(`lee directo (${lista(c.lee)})`);
  if (c.escribe.length) {
    if (nivelNeg === 'lectura') partes.push('no puede usar lo que escribe');
    else partes.push(esPropietario
      ? `escribe directo (${lista(c.escribe)})`
      : `cada uso de lo que escribe o puede escribir pide aprobación de un Propietario (${lista(c.escribe)})`);
  }
  return `${c.app}: ${partes.join('; ') || 'sin herramientas'}.`;
}

const NOTA_INSTRUCCION = 'Lo que diga la descripción del rol (por ejemplo "solo cantidades, sin montos" o "solo su ciudad") es una instrucción para el agente, no un límite del sistema: con un conector habilitado, técnicamente alcanza todo lo que ese conector alcanza. Los límites reales son los permisos del rol y qué conectores tiene.';

/**
 * Ficha de un rol tal como quedaría. `rol`: { nombre, descripcion, permisos }; `rolesConConector`: si se está
 * cambiando un conector, la lista de roles que lo tendrían.
 */
export function fichaRol(db, { nombre, descripcion = null, permisos }, { conector = null, rolesConConector = null } = {}) {
  const p = normalizar(permisos);
  const esPropietario = nombre === 'Propietario';
  const lineas = [`Rol "${nombre}"${descripcion ? ` (${descripcion})` : ''}:`];
  lineas.push(`- Permisos que hace cumplir el sistema: ${enPalabras(p).map((x) => `${x.nombre}: ${x.texto}`).join('; ')}.`);
  const cons = conectoresActivos(db).map((c) => (conector && c.id === conector && rolesConConector ? { ...c, roles: rolesConConector } : c));
  const suyos = cons.filter((c) => esPropietario || c.roles.includes(nombre));
  lineas.push(suyos.length ? `- Conectores: ${suyos.map((c) => usoDeConector(c, p, esPropietario)).join(' ')}` : '- Conectores: ninguno.');
  const otros = cons.filter((c) => !suyos.includes(c)).map((c) => c.app);
  if (otros.length) lineas.push(`- No tiene: ${otros.join(', ')}.`);
  lineas.push(`- ${NOTA_INSTRUCCION}`);
  return lineas.join('\n');
}

/** Ficha de un cambio de conector: cómo lo usaría cada rol que lo tenga. */
export function fichaConector(db, conectorId, { roles, soloLectura: nuevaLectura = null }) {
  const f = db.prepare('SELECT id, app, permisos, habilitada_para, url_mcp FROM conexiones WHERE id = ?').get(Number(conectorId));
  if (!f) return 'Ese conector no existe.';
  const antes = soloLectura(f);
  const c = herramientasDe(f, { soloLecturaForzada: nuevaLectura == null ? null : (nuevaLectura || pideSoloLectura(f.url_mcp)) });
  const lineas = [`Conector ${c.app}, habilitado para: ${roles.join(', ') || 'ningún rol'}.`];
  if (pideSoloLectura(f.url_mcp)) lineas.push('- Es de solo lectura: su URL se lo pide al servicio (read_only), así que el propio servicio no deja escribir. Ninguna herramienta cuenta como escritura.');
  else if (nuevaLectura === true && !antes) lineas.push('- Pasa a solo lectura: todas sus herramientas cuentan como lectura, no piden aprobación y las ve un rol que solo lee. Confirmalo solo si el servicio de verdad no deja escribir con esta conexión (por ejemplo, conectado en modo lectura o con un usuario que solo lee). Si no, quien lo tenga podría escribir sin aprobación.');
  else if (nuevaLectura === false && antes) lineas.push('- Deja de ser de solo lectura: lo que escribe o puede escribir vuelve a pedir aprobación a quien no es Propietario.');
  else if (c.soloLectura) lineas.push('- Marcado como de solo lectura por un Propietario.');
  for (const nombre of roles) {
    const r = db.prepare('SELECT nombre, descripcion, permisos FROM roles WHERE nombre = ?').get(nombre);
    if (!r) { lineas.push(`- ${nombre}: ese rol no existe.`); continue; }
    lineas.push(`- ${nombre}: ${usoDeConector({ ...c, roles }, normalizar(r.permisos), nombre === 'Propietario')}`);
  }
  lineas.push(`- ${NOTA_INSTRUCCION}`);
  return lineas.join('\n');
}
