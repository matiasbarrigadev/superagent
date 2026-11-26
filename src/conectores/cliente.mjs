// Cliente MCP por HTTP (Streamable HTTP): JSON-RPC por POST, respuestas JSON o SSE, y el header Mcp-Session-Id.
// Lo usa el gateway para hablar con los conectores remotos en nombre del agente.

export class ErrorConector extends Error {
  constructor(mensaje, { status = 502, sinAutorizar = false } = {}) { super(mensaje); this.status = status; this.sinAutorizar = sinAutorizar; }
}

/** De un cuerpo SSE, la respuesta JSON-RPC con ese id. */
function desdeSse(texto, id) {
  for (const bloque of texto.split(/\r?\n\r?\n/)) {
    const datos = bloque.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!datos) continue;
    try {
      const m = JSON.parse(datos);
      if (m.id === id) return m;
    } catch {}
  }
  return null;
}

export function crearClienteMcp({ url, token = null, headers = {}, fetch: f = globalThis.fetch, timeoutMs = 60_000 }) {
  let sesion = null;
  let id = 0;
  let iniciado = false;

  async function rpc(method, params, { notificacion = false } = {}) {
    const mid = notificacion ? undefined : ++id;
    let r;
    try {
      r = await f(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(sesion ? { 'Mcp-Session-Id': sesion } : {}),
          'MCP-Protocol-Version': '2025-06-18',
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...(mid !== undefined ? { id: mid } : {}), method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ErrorConector(`El conector no responde (${e.cause?.code ?? e.name}).`, { status: 503 });
    }
    if (r.status === 401 || r.status === 403) throw new ErrorConector('El conector rechazó la autorización.', { status: 401, sinAutorizar: true });
    if (!r.ok && r.status !== 202) throw new ErrorConector(`El conector respondió ${r.status}.`);
    const s = r.headers.get('mcp-session-id');
    if (s) sesion = s;
    if (notificacion || r.status === 202) return null;
    const tipo = r.headers.get('content-type') ?? '';
    const texto = await r.text();
    const m = tipo.includes('text/event-stream') ? desdeSse(texto, mid) : JSON.parse(texto);
    if (!m) throw new ErrorConector('Respuesta vacía del conector.');
    if (m.error) throw new ErrorConector(`Error del conector: ${m.error.message ?? m.error.code}`);
    return m.result;
  }

  async function iniciar() {
    if (iniciado) return;
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'superagent', version: '1' } });
    await rpc('notifications/initialized', null, { notificacion: true });
    iniciado = true;
  }

  return {
    async herramientas() {
      await iniciar();
      const out = [];
      let cursor;
      for (let i = 0; i < 20; i++) {
        const r = await rpc('tools/list', cursor ? { cursor } : {});
        out.push(...(r?.tools ?? []));
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      return out;
    },
    async llamar(nombre, args) {
      await iniciar();
      return rpc('tools/call', { name: nombre, arguments: args ?? {} });
    },
  };
}
