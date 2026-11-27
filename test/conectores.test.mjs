// Etapa 7c: conectores MCP remotos con OAuth, con un proveedor falso (MCP + servidor de autorización).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { armar, persona, escribe } from './ayuda.mjs';

const BASE = 'https://proveedor.test';
const TOKEN = 'tok-secreto-del-proveedor-123';

function proveedorFalso() {
  const app = new Hono();
  const desafios = new Map();
  const llamadas = [];
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json({ resource: `${BASE}/mcp`, authorization_servers: [BASE] }));
  app.get('/.well-known/oauth-authorization-server', (c) => c.json({ issuer: BASE, authorization_endpoint: `${BASE}/authorize`, token_endpoint: `${BASE}/token`, registration_endpoint: `${BASE}/register`, code_challenge_methods_supported: ['S256'] }));
  app.post('/register', async (c) => c.json({ client_id: 'cliente-1', ...(await c.req.json()) }));
  // La persona "autoriza": redirige al callback con un código.
  app.get('/authorize', (c) => {
    const q = c.req.query();
    assert.equal(q.code_challenge_method, 'S256');
    assert.equal(q.resource, `${BASE}/mcp`);
    desafios.set('codigo-1', q.code_challenge);
    return c.redirect(`${q.redirect_uri}?code=codigo-1&state=${encodeURIComponent(q.state)}`);
  });
  app.post('/token', async (c) => {
    const f = new URLSearchParams(await c.req.text());
    const ok = f.get('code') === 'codigo-1' && crypto.createHash('sha256').update(f.get('code_verifier')).digest('base64url') === desafios.get('codigo-1');
    return ok ? c.json({ access_token: TOKEN, refresh_token: 'r-1', expires_in: 3600, token_type: 'Bearer' }) : c.json({ error: 'invalid_grant' }, 400);
  });
  app.post('/mcp', async (c) => {
    if (c.req.header('authorization') !== `Bearer ${TOKEN}`) {
      return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"` });
    }
    const m = await c.req.json();
    if (m.id === undefined) return c.body(null, 202);
    if (m.method === 'initialize') return c.json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'falso', version: '1' } } }, 200, { 'Mcp-Session-Id': 's-1' });
    if (m.method === 'tools/list') {
      return c.json({ jsonrpc: '2.0', id: m.id, result: { tools: [
        { name: 'buscar_eventos', description: 'Busca eventos', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'crear_evento', description: 'Crea un evento', inputSchema: { type: 'object', properties: { titulo: { type: 'string' } } } },
      ] } });
    }
    if (m.method === 'tools/call') {
      llamadas.push({ ...m.params, sesion: c.req.header('mcp-session-id') });
      // Respuesta en SSE, como hacen muchos servidores reales.
      return c.body(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `ok ${m.params.name}` }] } })}\n\n`, 200, { 'Content-Type': 'text/event-stream' });
    }
    return c.json({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
  });
  const fetchFalso = (url, opts = {}) => app.request(String(url).replace(BASE, ''), opts);
  return { fetchFalso, llamadas, app };
}

async function conConector() {
  const prov = proveedorFalso();
  const t = armar({
    fetchConectores: prov.fetchFalso,
    guion: async (spec, ctx, llamar) => {
      if (spec.prompt.includes('conectá la agenda')) return [{ herramienta: 'agregar_conector', args: { nombre: 'Agenda', url: `${BASE}/mcp` } }];
      if (spec.prompt.includes('creá el evento')) {
        const nombre = spec.herramientasGateway.find((h) => h.endsWith('crear_evento'));
        if (nombre) await llamar(nombre, { titulo: 'Reunión' });
      }
      if (spec.prompt.includes('buscá eventos')) {
        const nombre = spec.herramientasGateway.find((h) => h.endsWith('buscar_eventos'));
        if (nombre) await llamar(nombre, {});
      }
      return [];
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'conectá la agenda' });
  await t.avanzar(46_000);
  // El link llega por WhatsApp, mandado por el gateway.
  const msg = t.waha.enviados.find((e) => /authorize/.test(e.texto));
  const link = msg.texto.match(/https:\/\/\S+/)[0];
  const r = await prov.fetchFalso(link);
  const vuelta = new URL(r.headers.get('location'));
  const cb = await t.app.request(`${vuelta.pathname}${vuelta.search}`);
  // Antes de darlo por conectado, el gateway lo prueba con una consulta de solo lectura.
  const prueba = prov.llamadas.splice(0).map((l) => l.name);
  return { t, prov, msg, cb, prueba };
}

test('el link de autorización llega por WhatsApp y el token queda cifrado en conexiones', async () => {
  const { t, msg, cb, prueba } = await conConector();
  assert.deepEqual(prueba, ['buscar_eventos']);
  assert.equal(msg.chatId, '5491111111111@c.us');
  assert.match(await cb.text(), /quedó conectado/);
  const c = t.db.prepare('SELECT * FROM conexiones').get();
  assert.equal(c.estado, 'activa', t.waha.enviados.map((e) => e.texto).join(' | '));
  assert.ok(!c.credencial.includes(TOKEN), 'cifrado');
  assert.equal(JSON.parse(c.permisos).length, 2);
  // El "listo" no sale directo: le llega al agente en el chat donde se pidió, y él sigue la charla sabiéndolo.
  assert.ok(!t.waha.enviados.some((e) => /quedó conectado/.test(e.texto)));
  const evt = t.db.prepare("SELECT chat_id, persona_id, cuerpo FROM mensajes WHERE tipo = 'evento' AND cuerpo LIKE '[conector Agenda conectado]%'").get();
  assert.equal(evt.chat_id, '5491111111111@c.us');
  assert.ok(evt.persona_id);
  assert.match(evt.cuerpo, /2 herramientas/);
  assert.match(evt.cuerpo, /probé con buscar_eventos y respondió bien/);
  await t.avanzar(5_000);
  assert.ok(t.corridas.some((c) => c.spec.prompt.includes('[conector Agenda conectado]')), 'el agente se despierta con eso');
  t.limpiar();
});

test('el Propietario usa el conector; el token no aparece en la corrida', async () => {
  const { t, prov } = await conConector();
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'creá el evento' });
  await t.avanzar(46_000);
  const c = t.corridas.at(-1);
  assert.ok(c.spec.herramientasGateway.includes('agenda__crear_evento'));
  assert.equal(c.resultados[0].r.content[0].text, 'ok crear_evento');
  assert.deepEqual(prov.llamadas.map((l) => [l.name, l.sesion]), [['crear_evento', 's-1']]);
  const todo = JSON.stringify({ spec: { ...c.spec, decidir: null }, args: c.args });
  assert.ok(!todo.includes(TOKEN), 'ni en el prompt, ni en los flags, ni en la config de la corrida');
  t.limpiar();
});

test('un rol sin el conector habilitado no lo ve; habilitado, lo que escribe pide aprobación', async () => {
  const { t, prov } = await conConector();
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'creá el evento' });
  await escribe(t.nucleo, { telefono: '5491199999999', texto: 'creá el evento' });
  await t.avanzar(46_000);
  for (const c of t.corridas.slice(-2)) assert.ok(!c.spec.herramientasGateway.some((h) => h.startsWith('agenda__')));
  assert.match(t.corridas.at(-2).spec.prompt, /no habilitados para el rol Colaborador: .*no están caídas/, 'el agente sabe que es el rol, no una desconexión');
  t.nucleo.conectores.configurar(1, { roles: ['Propietario', 'Colaborador', 'Tercero'] });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'creá el evento' });
  await escribe(t.nucleo, { telefono: '5491199999999', texto: 'buscá eventos' });
  await t.avanzar(46_000);
  const colab = t.corridas.at(-2), tercero = t.corridas.at(-1);
  assert.match(colab.resultados[0].r.content[0].text, /Pendiente de aprobación A-1/);
  assert.equal(prov.llamadas.length, 0, 'no se ejecutó');
  assert.ok(!tercero.spec.herramientasGateway.some((h) => h.startsWith('agenda__')), 'un Tercero (sin herramientas del negocio) nunca');
  // Al aprobar, lo ejecuta el gateway.
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'dale A-1' });
  await t.avanzar(0);
  assert.deepEqual(prov.llamadas.map((l) => l.name), ['crear_evento']);
  t.limpiar();
});

test('agregar conectores de la instalación es del Propietario; un Colaborador solo los suyos', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await t.avanzar(46_000);
  const ctx = t.corridas[0].ctx;
  await assert.rejects(() => t.nucleo.herramientas.agregar_conector.ejecutar(ctx, { nombre: 'X', url: 'https://x.test/mcp' }), /no lo permite/);
  t.limpiar();
});
