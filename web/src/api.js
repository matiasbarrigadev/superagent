// Llamadas a la API del gateway. Mismo origen, cookie HttpOnly.
export class ErrorApi extends Error {
  constructor(mensaje, status) { super(mensaje); this.status = status; }
}

export async function api(ruta, { method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetch(ruta, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) },
      body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ErrorApi('No hay conexión con el servidor.', 0);
  }
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && ruta !== '/api/auth/login' && !ruta.startsWith('/api/setup')) {
      window.dispatchEvent(new Event('sesion-vencida'));
    }
    throw new ErrorApi(datos.error ?? `Error ${r.status}`, r.status);
  }
  return datos;
}

export const post = (ruta, body) => api(ruta, { method: 'POST', body });
export const patch = (ruta, body) => api(ruta, { method: 'PATCH', body });
export const borrar = (ruta) => api(ruta, { method: 'DELETE', body: {} });
