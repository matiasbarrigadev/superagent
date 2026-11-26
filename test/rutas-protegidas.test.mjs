// Ninguna ruta de la API queda abierta por olvido: sin sesión, todo lo que no es público responde 401.
// Si se suma una ruta nueva y no se agrega a los prefijos protegidos (PREFIJOS_PANEL), esta prueba falla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar } from './ayuda.mjs';

// Lo público a propósito: setup, login, recuperación, invitaciones y el estado del servidor.
const PUBLICAS = [/^\/api\/setup\//, /^\/api\/auth\/(login|logout)$/, /^\/api\/recuperar\//, /^\/api\/invitacion(\/|$)/, /^\/api\/estado$/];

test('sin sesión, toda ruta de la API que no es pública responde 401', async () => {
  const t = armar();
  const rutas = t.app.routes.filter((r) => r.path.startsWith('/api/') && r.method !== 'ALL' && !r.path.includes('*'));
  assert.ok(rutas.length > 50, `hay ${rutas.length} rutas`);
  const abiertas = [];
  for (const r of rutas) {
    if (PUBLICAS.some((re) => re.test(r.path))) continue;
    const ruta = r.path.replace(/:(\w+)/g, '1');
    const res = await t.app.request(ruta, { method: r.method, headers: { 'Content-Type': 'application/json', Host: 'localhost' }, body: r.method === 'GET' ? undefined : '{}' });
    if (res.status !== 401) abiertas.push(`${r.method} ${r.path} → ${res.status}`);
  }
  assert.deepEqual(abiertas, []);
  t.limpiar();
});
