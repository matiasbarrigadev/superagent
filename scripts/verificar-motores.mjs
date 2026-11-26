// Verifica los motores de punta a punta, con usuarios reales y el MCP del gateway. Correr dentro del contenedor,
// como root:
//   docker compose exec superagent node scripts/verificar-motores.mjs
//
// Codex y Gemini corren contra un modelo falso local que registra qué herramientas ofrece cada CLI (no hace falta
// ninguna clave): así se comprueba que un rol sin terminal no la tiene, que el modo completo sí, que las
// herramientas del gateway llegan y que la corrida usa el usuario de su conversación.
// OpenCode corre contra un modelo gratis de verdad si se pasa --opencode (puede dar "limite" si se agotó la cuota).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { abrirBase } from '../src/db/index.mjs';
import { crearAislamiento } from '../src/claude/aislamiento.mjs';
import { crearServidorMcp } from '../src/mcp/servidor.mjs';
import { crearAdaptadorOpenCode } from '../src/engine/opencode.mjs';
import { crearAdaptadorCodex } from '../src/engine/codex.mjs';
import { crearAdaptadorGemini } from '../src/engine/gemini.mjs';
import { crearEjecutorComun } from '../src/engine/ejecutor.mjs';

const conOpenCode = process.argv.includes('--opencode');
const dataDir = '/tmp/prueba-motores'; fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { mode: 0o711 });
const db = abrirBase(':memory:');
const ais = crearAislamiento({ db, config: { dataDir, uidBase: 29500 }, log: console });

// --- MCP del gateway con una herramienta, como el de verdad.
const recibidos = [];
const mcp = crearServidorMcp({ herramientas: { responder: {
  descripcion: 'Responde al usuario por WhatsApp. Usala siempre para contestar.',
  esquema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
  ejecutar: (ctx, { texto }) => { recibidos.push(texto); return 'Enviado.'; },
} } });
const servidorMcp = serve({ fetch: mcp.app.fetch, port: 18556, hostname: '127.0.0.1' });

// --- Modelo falso (API de OpenAI Responses y de Gemini): anota las herramientas ofrecidas y llama a "responder".
let ofrecidas = [];
const modelo = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(b); } catch {}
    if (req.url.includes('/v1beta/') || req.url.includes('generateContent')) {
      const tools = (j.tools ?? []).flatMap((t) => (t.functionDeclarations ?? []).map((f) => f.name)).filter(Boolean);
      // Solo los pedidos de la charla principal (con la herramienta del gateway) cuentan como "ofrecidas".
      if (tools.some((t) => /responder/.test(t))) ofrecidas.push(...tools);
      const ya = JSON.stringify(j.contents ?? []).includes('functionResponse');
      const resp = tools.find((t) => /responder/.test(t));
      const part = resp && !ya ? { functionCall: { name: resp, args: { texto: 'hola desde gemini' } } } : { text: 'Listo.' };
      const cuerpo = { candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } };
      if (req.url.includes('stream')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify(cuerpo)}\n\n`); } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(cuerpo)); }
      return;
    }
    const tools = (j.tools ?? []).flatMap((t) => (t.type === 'namespace' ? (t.tools ?? []).map((x) => `${t.name}.${x.name}`) : [t.name ?? t.type]));
    ofrecidas.push(...tools);
    const ya = JSON.stringify(j.input ?? []).includes('function_call_output');
    const resp = tools.find((t) => /responder/.test(t ?? ''));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: 'response.created', response: { id: 'r' } });
    const item = resp && !ya
      ? { type: 'function_call', id: 'fc', call_id: 'c1', ...(resp.includes('.') ? { namespace: resp.split('.')[0], name: resp.split('.')[1] } : { name: resp }), arguments: JSON.stringify({ texto: 'hola desde codex' }) }
      : { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'Listo.' }] };
    ev({ type: 'response.output_item.done', output_index: 0, item });
    ev({ type: 'response.completed', response: { id: 'r', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
    res.end();
  });
}).listen(18600, '127.0.0.1');
await new Promise((r) => setTimeout(r, 400));

const claves = { CODEX_API_KEY: 'falsa', GEMINI_API_KEY: 'falsa' };
const adaptadores = {
  codex: crearAdaptadorCodex({ clave: (n) => claves[n] ?? null, argsPruebas: ['-c', 'model_provider="falso"', '-c', 'model_providers.falso.name="falso"', '-c', 'model_providers.falso.base_url="http://127.0.0.1:18600/v1"', '-c', 'model_providers.falso.wire_api="responses"', '-c', 'model_providers.falso.env_key="CODEX_API_KEY"'] }),
  gemini: crearAdaptadorGemini({ clave: (n) => claves[n] ?? null, dirSistema: '/etc/superagent/gemini', entornoPruebas: { GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:18600' } }),
  opencode: crearAdaptadorOpenCode({ dirConfigVacio: path.join(dataDir, 'opencode-config') }),
};
const ej = crearEjecutorComun({ adaptadores, aislamiento: ais });
const correr = async (motor, { completo = false, herramientasClaude = [], clave = `chat:${motor}` } = {}) => {
  const token = mcp.registrar({ herramientasGateway: ['responder'] });
  ofrecidas = [];
  const antes = recibidos.length;
  const r = await ej({
    motor, completo, herramientasClaude, claveAislamiento: clave,
    modelo: motor === 'gemini' ? 'gemini-2.5-flash' : motor === 'opencode' ? 'opencode/deepseek-v4.1-flash-free' : 'gpt-falso',
    mcp: { url: 'http://127.0.0.1:18556/mcp', token },
    sistema: 'Sos un agente de WhatsApp. Contestá siempre con la herramienta del gateway "responder".', prompt: 'Decí hola.',
  }, { sesion: motor === 'gemini' ? '11111111-2222-4333-8444-555555555555' : null, nueva: true, timeoutMs: 120_000 }).finally(() => mcp.liberar(token));
  return { r, respondio: recibidos.length > antes, ofrecidas: [...new Set(ofrecidas)] };
};

const TERMINAL = /^(exec_command|shell|run_shell_command|bash|unified_exec|write_stdin)$/;
const res = {};
for (const motor of ['codex', 'gemini']) {
  const rol = await correr(motor);
  res[`${motor}_responde`] = rol.r.ok && rol.respondio;
  res[`${motor}_error`] = rol.r.ok ? null : `${rol.r.tipoError}: ${String(rol.r.error).slice(0, 300)}`;
  res[`${motor}_rol_sin_terminal`] = rol.ofrecidas.length > 0 && !rol.ofrecidas.some((t) => TERMINAL.test(t));
  res[`${motor}_ofrecidas_al_rol`] = rol.ofrecidas;
  const comp = await correr(motor, { completo: true, clave: `chat:${motor}-completo` });
  res[`${motor}_completo_con_terminal`] = comp.ofrecidas.some((t) => TERMINAL.test(t));
}
// La carpeta de la config de Gemini es de root y no queda nada en ella.
res.gemini_sistema_de_root = fs.statSync('/etc/superagent/gemini').uid === 0 && fs.readdirSync('/etc/superagent/gemini').length === 0;
// Cada corrida tiene su usuario: lo que dejó Codex en su carpeta es de ese usuario.
const lugarCodex = ais.rutas('chat:codex');
res.codex_carpeta_del_usuario = fs.statSync(path.join(lugarCodex.config, 'codex', 'config.toml')).uid === ais.usuarioDe('chat:codex').uid;
res.codex_sin_auth_en_disco = !fs.existsSync(path.join(lugarCodex.config, 'codex', 'auth.json'));

if (conOpenCode) {
  const oc = await correr('opencode');
  res.opencode = oc.r.ok ? (oc.respondio ? 'responde' : 'no usó responder') : `${oc.r.tipoError}: ${String(oc.r.error).slice(0, 200)}`;
}

console.log(JSON.stringify(res, null, 1));
servidorMcp.close(); modelo.close();
const esperado = { codex_responde: true, codex_rol_sin_terminal: true, codex_completo_con_terminal: true, gemini_responde: true, gemini_rol_sin_terminal: true, gemini_completo_con_terminal: true, gemini_sistema_de_root: true, codex_carpeta_del_usuario: true, codex_sin_auth_en_disco: true };
const fallas = Object.entries(esperado).filter(([k, v]) => res[k] !== v).map(([k]) => k);
console.log(fallas.length ? `FALLA: ${fallas.join(', ')}` : 'OK: Codex y Gemini corren aislados, con el MCP del gateway y sin lo que el rol no tiene');
process.exit(fallas.length ? 1 : 0);
