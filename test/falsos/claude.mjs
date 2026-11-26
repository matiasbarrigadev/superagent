#!/usr/bin/env node
// Binario "claude" falso para pruebas de punta a punta: lee los flags como el real, habla con el MCP del
// gateway por HTTP y escribe stream-json. Responde con eco del último mensaje.
const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const cfg = val('--mcp-config');
const mcp = JSON.parse(cfg.trim().startsWith('{') ? cfg : (await import('node:fs')).readFileSync(cfg, 'utf8')).mcpServers.superagent;
const sesion = val('--session-id') ?? val('--resume');
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'system', subtype: 'init', session_id: sesion, tools: (val('--tools') || '').split(',').filter(Boolean) });
  let id = 0;
  const rpc = async (method, params) => {
    const r = await fetch(mcp.url, { method: 'POST', headers: { ...mcp.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    return r.json();
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'falso', version: '1' } });
  const lista = await rpc('tools/list', {});
  const nombres = lista.result.tools.map((t) => t.name);
  const ultimo = (prompt.match(/<mensajes>[\s\S]*?\n([^\n]*)\n<\/mensajes>/) ?? [])[1] ?? '';
  const texto = `eco: ${ultimo.replace(/^\[[^\]]*\]\s*/, '')} | herramientas: ${nombres.join(',')}`;
  const r = await rpc('tools/call', { name: 'responder', arguments: { texto } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__superagent__responder', input: { texto } }] }, session_id: sesion });
  out({ type: 'result', subtype: 'success', is_error: !!r.result?.isError, result: 'listo', session_id: sesion });
});
