// Qué puede ver en el panel cada usuario. El Propietario (y quien tenga "todo") ve todo; un invitado, solo las
// secciones que le dieron. La API se filtra por prefijo; lo que no está en ninguna sección es solo para "todo".

export const SECCIONES_PANEL = {
  whatsapp: { nombre: 'WhatsApp', detalle: 'Ver el estado y vincular o desvincular el número del agente.', prefijos: ['/api/whatsapp'] },
  claude: { nombre: 'Claude', detalle: 'Conectar la cuenta de Claude y ver el consumo.', prefijos: ['/api/claude'] },
  bandeja: { nombre: 'Bandeja', detalle: 'Leer las conversaciones de WhatsApp.', prefijos: ['/api/inbox', '/api/chats'] },
  equipo: { nombre: 'Equipo', detalle: 'Personas, roles y clientes.', prefijos: ['/api/personas', '/api/roles', '/api/equipo', '/api/clientes'] },
  conexiones: { nombre: 'Conexiones', detalle: 'Servicios conectados, variables y repos.', prefijos: ['/api/conectores', '/api/entorno', '/api/proyectos', '/api/github', '/api/credenciales'] },
  bitacora: { nombre: 'Bitácora', detalle: 'Lo que se decidió y aprobó.', prefijos: ['/api/bitacora'] },
};

// Para cualquier usuario con sesión.
const SIEMPRE = ['/api/resumen', '/api/auth/sesiones', '/api/auth/cerrar-otras'];
// Solo con acceso total, aunque el prefijo caiga en una sección (el número del Propietario es suyo).
const SOLO_TODO = ['/api/personas/yo'];

export function normalizarAccesos(lista) {
  if (lista === 'todo' || (Array.isArray(lista) && lista.includes('todo'))) return null;
  const v = [...new Set((Array.isArray(lista) ? lista : []).filter((s) => SECCIONES_PANEL[s]))];
  if (!v.length) throw Object.assign(new Error('Elegí al menos una sección (o acceso total).'), { status: 400 });
  return v;
}

export const accesosDe = (fila) => {
  if (fila?.rol === 'Propietario' || fila?.accesos == null) return 'todo';
  try { return JSON.parse(fila.accesos); } catch { return []; }
};

const empieza = (ruta, p) => ruta === p || ruta.startsWith(`${p}/`);

/** ¿Puede este usuario (accesos = 'todo' o lista) usar esta ruta de la API? */
export function puedeRuta(accesos, ruta) {
  if (accesos === 'todo') return true;
  if (SIEMPRE.some((p) => empieza(ruta, p))) return true;
  if (SOLO_TODO.some((p) => empieza(ruta, p))) return false;
  return accesos.some((s) => SECCIONES_PANEL[s]?.prefijos.some((p) => empieza(ruta, p)));
}
