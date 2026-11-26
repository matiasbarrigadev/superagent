// Catálogo cerrado de permisos (TEORIA §2.5). Un rol es una fila de datos con un valor por permiso.
// Cada permiso tiene niveles ordenados de menor a mayor; el gateway decide con esto, nunca el modelo.

export const PERMISOS = {
  conversar: { niveles: [false, true], nombre: 'Conversar con el agente' },
  herramientas_negocio: { niveles: ['ninguna', 'lectura', 'lectura_escritura'], nombre: 'Herramientas del negocio' },
  trabajar_en_codigo: { niveles: ['no', 'solo_leer', 'en_rama'], nombre: 'Trabajar con archivos y código' },
  publicar_sistemas: { niveles: ['no', 'con_aprobacion', 'directo'], nombre: 'Publicar en producción' },
  cambiar_agente: { niveles: ['no', 'con_aprobacion', 'directo'], nombre: 'Cambiar el agente (instrucciones y memoria)' },
  gestionar_personas: { niveles: [false, true], nombre: 'Dar de alta personas y cambiarles el rol' },
  gestionar_roles: { niveles: [false, true], nombre: 'Crear y editar roles' },
  aprobar: { niveles: [false, true], nombre: 'Aprobar lo que piden otros' },
  conectar_cuentas: { niveles: [false, true], nombre: 'Conectar cuentas de la instalación' },
  conectar_mis_cuentas: { niveles: [false, true], nombre: 'Conectar sus propias cuentas' },
  usar_web: { niveles: [false, true], nombre: 'Buscar y navegar en la web' },
  programar_rutinas: { niveles: ['no', 'con_aprobacion', 'directo'], nombre: 'Programar rutinas' },
  iniciar_conversacion: { niveles: ['no', 'con_aprobacion', 'directo'], nombre: 'Escribirle primero a alguien' },
  ver_consumo: { niveles: [false, true], nombre: 'Ver el consumo de Claude y recibir sus avisos' },
};

const TEXTO_NIVEL = {
  true: 'sí', false: 'no', no: 'no', ninguna: 'no',
  lectura: 'solo leer', lectura_escritura: 'leer y escribir',
  solo_leer: 'solo leer', en_rama: 'sí, en una rama propia',
  con_aprobacion: 'con aprobación del Propietario', directo: 'sí, directo',
};

/** Normaliza un objeto de permisos: completa lo que falta con el nivel más bajo y descarta lo desconocido. */
export function normalizar(p) {
  const fuente = typeof p === 'string' ? (() => { try { return JSON.parse(p); } catch { return {}; } })() : (p ?? {});
  const out = {};
  for (const [k, def] of Object.entries(PERMISOS)) {
    const v = fuente[k];
    out[k] = def.niveles.includes(v) ? v : def.niveles[0];
  }
  return out;
}

export const nivel = (permiso, valor) => PERMISOS[permiso].niveles.indexOf(valor);

/** Permisos de `pedido` que superan a `tope` (vacío si ninguno). */
export function excesos(tope, pedido) {
  const t = normalizar(tope), p = normalizar(pedido);
  return Object.keys(PERMISOS).filter((k) => nivel(k, p[k]) > nivel(k, t[k]));
}

/** Descripción en lenguaje simple, para tarjetas de propuesta y el panel. */
export function enPalabras(p) {
  const n = normalizar(p);
  return Object.entries(PERMISOS).map(([k, def]) => ({ permiso: k, nombre: def.nombre, valor: n[k], texto: TEXTO_NIVEL[String(n[k])] ?? String(n[k]) }));
}

export function resumen(p) {
  return enPalabras(p).filter((x) => x.valor !== false && x.valor !== 'no' && x.valor !== 'ninguna').map((x) => `${x.nombre}: ${x.texto}`).join('; ') || 'Nada';
}

export const TODOS = normalizar(Object.fromEntries(Object.entries(PERMISOS).map(([k, d]) => [k, d.niveles.at(-1)])));
