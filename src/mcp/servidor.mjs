// MCP del gateway: única vía del agente hacia afuera. Servidor MCP por HTTP (JSON-RPC, respuestas JSON),
// escuchando solo en 127.0.0.1, con un token por corrida. Cada token ve solo las herramientas de su corrida.
import crypto from 'node:crypto';
import { Hono } from 'hono';

const PROTOCOLO = '2025-06-18';

export class ErrorHerramienta extends Error {}

export function crearServidorMcp({ herramientas, version = '0.0.0', log = console }) {
  const corridas = new Map(); // sha256(token) → contexto de la corrida
  const app = new Hono();
  const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

  function registrar(ctx) {
    const token = crypto.randomBytes(32).toString('base64url');
    corridas.set(hash(token), ctx);
    return token;
  }
  const liberar = (token) => corridas.delete(hash(token));
  const contexto = (token) => corridas.get(hash(token)) ?? null;

  // Además de las fijas, cada corrida puede traer herramientas de conectores remotos (ctx.dinamicas).
  const definicion = (ctx, n) => herramientas[n] ?? (ctx.dinamicas ?? []).find((d) => d.nombre === n) ?? null;

  function lista(ctx) {
    return ctx.herramientasGateway
      .map((n) => [n, definicion(ctx, n)])
      .filter(([, d]) => d)
      .map(([n, d]) => ({ name: n, description: d.descripcion, inputSchema: d.esquema }));
  }

  /** Llama una herramienta como lo haría el agente (lo usan el HTTP y los tests). */
  async function llamar(ctx, nombre, args = {}) {
    const def = ctx.herramientasGateway.includes(nombre) ? definicion(ctx, nombre) : null;
    if (!def) {
      return { isError: true, content: [{ type: 'text', text: `La herramienta ${nombre} no está disponible en esta corrida.` }] };
    }
    try {
      const salida = await def.ejecutar(ctx, args ?? {});
      ctx.llamadas?.push({ nombre, args });
      return { content: [{ type: 'text', text: typeof salida === 'string' ? salida : JSON.stringify(salida) }] };
    } catch (e) {
      if (!(e instanceof ErrorHerramienta)) log.error('[mcp]', nombre, e);
      ctx.llamadas?.push({ nombre, args, error: e.message });
      return { isError: true, content: [{ type: 'text', text: e instanceof ErrorHerramienta ? e.message : 'Error interno del gateway.' }] };
    }
  }

  async function responder(ctx, m) {
    const base = { jsonrpc: '2.0', id: m.id };
    switch (m.method) {
      case 'initialize':
        return { ...base, result: { protocolVersion: m.params?.protocolVersion ?? PROTOCOLO, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'superagent', version } } };
      case 'ping':
        return { ...base, result: {} };
      case 'tools/list':
        return { ...base, result: { tools: lista(ctx) } };
      case 'tools/call':
        return { ...base, result: await llamar(ctx, m.params?.name, m.params?.arguments) };
      default:
        return { ...base, error: { code: -32601, message: `Método no soportado: ${m.method}` } };
    }
  }

  app.post('/mcp', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const ctx = auth.startsWith('Bearer ') ? contexto(auth.slice(7)) : null;
    if (!ctx) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Token inválido o corrida terminada.' } }, 401);
    let cuerpo;
    try { cuerpo = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido.' } }, 400); }
    const mensajes = Array.isArray(cuerpo) ? cuerpo : [cuerpo];
    const respuestas = [];
    for (const m of mensajes) {
      if (m?.id === undefined || m?.id === null) continue; // notificaciones: no llevan respuesta
      respuestas.push(await responder(ctx, m));
    }
    if (!respuestas.length) return c.body(null, 202);
    return c.json(Array.isArray(cuerpo) ? respuestas : respuestas[0]);
  });
  app.get('/mcp', (c) => c.body(null, 405));
  app.delete('/mcp', (c) => c.body(null, 405));

  return { app, registrar, liberar, contexto, llamar, lista };
}
