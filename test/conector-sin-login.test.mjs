// MCP "sin estado" (como el de Google): initialize contesta sin login y la autorización se pide recién al usar una
// herramienta. El gateway no lo da por conectado sin probarlo de verdad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { descubrir, urlAutorizacion } from '../src/conectores/oauth.mjs';
import { armar, persona, escribe } from './ayuda.mjs';

const BASE = 'https://cal.test';

function mcpSinEstado({ metadatos = true } = {}) {
  const app = new Hono();
  if (metadatos) {
    app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json({ resource: `${BASE}/mcp`, authorization_servers: ['https://cuentas.test'], scopes_supported: ['cal.leer', 'cal.escribir'] }));
  }
  app.post('/mcp', async (c) => {
    const m = await c.req.json();
    if (m.id === undefined) return c.body(null, 202);
    if (m.method === 'initialize') return c.json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'sin-estado', version: '1' } } });
    if (m.method === 'tools/list') return c.json({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'listar_calendarios', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } });
    return c.json({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'Request is missing required authentication credential.' }], isError: true } }, 401);
  });
  const cuentas = new Hono();
  cuentas.get('/.well-known/openid-configuration', (c) => c.json({ issuer: 'https://cuentas.test', authorization_endpoint: 'https://cuentas.test/auth', token_endpoint: 'https://cuentas.test/token', scopes_supported: ['openid', 'email'] }));
  return (url, opts) => {
    const u = new URL(String(url));
    return (u.origin === 'https://cuentas.test' ? cuentas : app).request(u.pathname + u.search, opts);
  };
}

test('initialize sin login pero con metadatos de recurso protegido: pide OAuth, con los permisos del MCP', async () => {
  const d = await descubrir(`${BASE}/mcp`, { fetch: mcpSinEstado() });
  assert.ok(d, 'no es "sin autorización"');
  assert.equal(d.meta.token_endpoint, 'https://cuentas.test/token');
  assert.deepEqual(d.alcances, ['cal.leer', 'cal.escribir']);
  const u = new URL(urlAutorizacion({ meta: d.meta, clientId: 'c', redirectUri: 'https://x.test/cb', estado: 'e', desafio: 'd', recurso: d.recurso, alcance: d.alcances.join(' ') }));
  assert.equal(u.searchParams.get('scope'), 'cal.leer cal.escribir');
});

test('sin metadatos y la herramienta pide login: no queda "conectado", queda con error y el agente lo sabe', async () => {
  const t = armar({
    fetchConectores: mcpSinEstado({ metadatos: false }),
    guion: async (spec) => (spec.prompt.includes('conectá el calendario') ? [{ herramienta: 'agregar_conector', args: { nombre: 'Calendario', url: `${BASE}/mcp` } }] : []),
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'conectá el calendario' });
  await t.avanzar(46_000);
  const c = t.db.prepare('SELECT estado FROM conexiones').get();
  assert.equal(c.estado, 'error');
  const evt = t.db.prepare("SELECT cuerpo FROM mensajes WHERE tipo = 'evento' AND cuerpo LIKE '[conector Calendario sin autorización real]%'").get();
  assert.ok(evt, 'le llega al agente que no quedó autorizado');
  assert.ok(!t.db.prepare("SELECT 1 FROM mensajes WHERE tipo = 'evento' AND cuerpo LIKE '[conector Calendario conectado]%'").get());
  t.limpiar();
});
