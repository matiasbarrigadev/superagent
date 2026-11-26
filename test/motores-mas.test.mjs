// Motores, fases 3 a 5: Codex, Gemini, respaldo automático y topes de gasto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { configCodex, crearAdaptadorCodex, clasificarErrorCodex } from '../src/engine/codex.mjs';
import { configGemini, excluidasGemini, crearAdaptadorGemini, clasificarErrorGemini } from '../src/engine/gemini.mjs';
import { crearAdaptadorOpenCode } from '../src/engine/opencode.mjs';
import { crearAdaptadorClaude } from '../src/engine/claude.mjs';
import { crearEjecutorComun } from '../src/engine/ejecutor.mjs';
import { crearMotores } from '../src/engine/motores.mjs';
import { armar, persona } from './ayuda.mjs';

const mcp = { url: 'http://127.0.0.1:8081/mcp', token: 'tok-mcp-secreto' };

function lugarFalso() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-motor-'));
  const l = { clave: 'chat:x', usuario: { uid: 1, gid: 1 }, base };
  for (const d of ['config', 'trabajo', 'tmp', 'adjuntos', 'salida']) { l[d] = path.join(base, d); fs.mkdirSync(l[d]); }
  return l;
}
const aisFalso = (lugar, transformar = (c) => c) => ({
  activo: false, preparar: () => lugar, terminar() {}, copiarAdentro() {},
  escribirArchivo: (r, c) => { fs.mkdirSync(path.dirname(r), { recursive: true }); fs.writeFileSync(r, transformar(String(c))); },
});
function lanzarCon({ salida = [], errores = [], codigo = 0 } = {}) {
  const llamadas = [];
  const lanzar = (file, args, opts) => {
    llamadas.push({ file, args, opts });
    const h = new EventEmitter();
    h.stdout = new EventEmitter(); h.stderr = new EventEmitter();
    h.stdin = { on() {}, end() {} };
    h.kill = () => { h.matado = true; setImmediate(() => h.emit('close', null)); };
    setImmediate(() => {
      for (const l of errores) h.stderr.emit('data', `${l}\n`);
      if (h.matado) return;
      for (const l of salida) h.stdout.emit('data', `${JSON.stringify(l)}\n`);
      h.emit('close', codigo);
    });
    return h;
  };
  return { lanzar, llamadas };
}
function ajustesFalsos() {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
}
let n = 0;
const entra = (t, de, texto) => { n++; return t.nucleo.ingesta({ event: 'message.any', session: 'default', me: { id: '5491100000001@c.us' }, payload: { id: `false_${de}@c.us_X${n}`, timestamp: 1_800_000_000 + n, from: `${de}@c.us`, fromMe: false, body: texto, hasMedia: false, _data: { Info: { PushName: 'Alguien' } } } }); };

test('Codex: un rol sin terminal no tiene terminal ni nada que no se pueda limitar; el modo completo sí la tiene', () => {
  const t = configCodex({ herramientasClaude: [], mcp, sistema: 'Sos el agente.' }, { modelo: 'gpt-5.5' });
  for (const l of ['shell_tool = false', 'unified_exec = false', 'web_search = "disabled"', 'sandbox_mode = "read-only"', 'approval_policy = "never"', 'apps = false', 'plugins = false', 'computer_use = false', 'browser_use = false', 'hooks = false', 'daemon_auto_start = false', 'default_tools_approval_mode = "approve"', 'bearer_token_env_var = "SUPERAGENT_MCP_TOKEN"', 'cli_auth_credentials_store = "file"']) assert.ok(t.includes(l), l);
  assert.match(t, /\[agents\]\nenabled = false/);
  assert.match(t, /developer_instructions = "Sos el agente."/);
  assert.ok(!t.includes('tok-mcp-secreto'));
  const c = configCodex({ completo: true, herramientasClaude: [], mcp });
  assert.ok(c.includes('shell_tool = true') && c.includes('sandbox_mode = "danger-full-access"') && c.includes('web_search = "live"'));
  assert.equal(clasificarErrorCodex('thread/resume failed: no rollout found for thread id x'), 'sesion_perdida');
  assert.equal(clasificarErrorCodex('unexpected status 401 Unauthorized: Missing bearer'), 'sin_sesion');
  assert.equal(clasificarErrorCodex("You've hit your usage limit. Try again in 3 hours"), 'limite');
});

test('Codex: con la cuenta de ChatGPT recibe su auth.json (y guarda el renovado); lee sesión, herramientas y uso', async () => {
  const lugar = lugarFalso();
  let guardado = null;
  const cuenta = { conectada: () => true, authJson: () => '{"tokens":"v1"}', actualizar: (j) => { guardado = j; } };
  const ad = crearAdaptadorCodex({ cuenta });
  const { lanzar, llamadas } = lanzarCon({ salida: [
    { type: 'thread.started', thread_id: 't-1' },
    { type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'superagent', tool: 'responder' } },
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Listo.' } },
    { type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 2 } },
  ] });
  // Codex renueva el token durante la corrida: acá, al escribir la copia ya queda la versión nueva.
  const ais = aisFalso(lugar, (c) => c.replace('v1', 'v2'));
  const ej = crearEjecutorComun({ adaptadores: { codex: ad }, aislamiento: ais, lanzar });
  const r = await ej({ motor: 'codex', herramientasClaude: [], mcp, prompt: 'hola' }, { sesion: 't-1', nueva: false });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.sessionId, r.resultado, r.herramientas[0]], ['t-1', 'Listo.', 'mcp__superagent__responder']);
  assert.deepEqual([r.uso.entrada, r.uso.cache, r.uso.salida, r.uso.costo], [160, 40, 12, 0]);
  assert.ok(llamadas[0].args.includes('resume') && llamadas[0].args.includes('t-1'));
  assert.equal(llamadas[0].opts.env.CODEX_API_KEY, undefined, 'con ChatGPT no va la clave');
  assert.equal(guardado, '{"tokens":"v2"}', 'el token renovado se guarda');
  assert.ok(!fs.existsSync(path.join(lugar.config, 'codex', 'auth.json')), 'la copia de la cuenta no queda en la carpeta');
  assert.throws(() => crearAdaptadorCodex({ clave: () => null }).preparar({ spec: { mcp }, lugar, aislamiento: ais }), (e) => e.tipoError === 'sin_sesion');
  // Con clave de API: va la clave y el costo queda desconocido (Codex no informa precio).
  const ad2 = crearAdaptadorCodex({ clave: (k) => (k === 'CODEX_API_KEY' ? 'sk-x' : null) });
  const l2 = lanzarCon({ salida: [{ type: 'thread.started', thread_id: 't-2' }, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } }] });
  const r2 = await crearEjecutorComun({ adaptadores: { codex: ad2 }, aislamiento: aisFalso(lugar), lanzar: l2.lanzar })({ motor: 'codex', herramientasClaude: [], mcp, prompt: 'hola' }, { sesion: 'x', nueva: true });
  assert.equal(l2.llamadas[0].opts.env.CODEX_API_KEY, 'sk-x');
  assert.equal(r2.uso.costo, null);
});

test('Gemini: herramientas excluidas por rol, sin preguntas ni hooks, y si ignora la config de seguridad no corre', async () => {
  const nada = excluidasGemini({ herramientasClaude: [] });
  for (const t of ['run_shell_command', 'read_file', 'write_file', 'replace', 'web_fetch', 'google_web_search', 'invoke_agent', 'ask_user', 'save_memory', 'activate_skill']) assert.ok(nada.includes(t), t);
  const leer = excluidasGemini({ herramientasClaude: ['Read', 'Glob', 'Grep'] });
  assert.ok(!leer.includes('read_file') && !leer.includes('glob') && leer.includes('run_shell_command') && leer.includes('ask_user'));
  assert.deepEqual(excluidasGemini({ completo: true }).sort(), ['activate_skill', 'ask_user', 'enter_plan_mode', 'exit_plan_mode', 'save_memory', 'update_topic']);
  const c = configGemini({ herramientasClaude: [], mcp, mcpExtra: { navegador: { command: 'playwright-mcp', args: [] } } });
  assert.deepEqual(c.mcp.allowed, ['superagent', 'navegador']);
  assert.equal(c.hooksConfig.enabled, false);
  assert.equal(c.mcpServers.superagent.headers.Authorization, 'Bearer $SUPERAGENT_MCP_TOKEN');
  assert.equal(clasificarErrorGemini('Error resuming session: Invalid session identifier "x"'), 'sesion_perdida');
  assert.equal(clasificarErrorGemini('[API Error: 429 RESOURCE_EXHAUSTED quota]'), 'limite');
  assert.equal(clasificarErrorGemini('API key not valid. Please pass a valid API key.'), 'sin_sesion');

  const lugar = lugarFalso();
  fs.mkdirSync(path.join(lugar.trabajo, '.gemini'));
  const ad = crearAdaptadorGemini({ clave: () => 'k', dirSistema: path.join(lugar.base, 'sistema') });
  const prep = ad.preparar({ spec: { herramientasClaude: [], mcp, sistema: 'Sos el agente.', prompt: 'hola' }, lugar, aislamiento: aisFalso(lugar), sesion: '11111111-2222-4333-8444-555555555555', nueva: true });
  assert.ok(!fs.existsSync(path.join(lugar.trabajo, '.gemini')), 'la config del proyecto se borra');
  assert.ok(prep.args.includes('--session-id') && prep.args.includes('--skip-trust') && prep.args.includes('yolo'));
  assert.equal(JSON.parse(fs.readFileSync(prep.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8')).hooksConfig.enabled, false);
  assert.match(fs.readFileSync(path.join(prep.env.GEMINI_CLI_HOME, '.gemini', 'GEMINI.md'), 'utf8'), /Sos el agente/);
  prep.alTerminar();
  assert.ok(!fs.existsSync(prep.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH));

  const { lanzar } = lanzarCon({ errores: ["Security Warning: Skipping system settings file '/x/y.json': Parent directory is writable"] });
  const ej = crearEjecutorComun({ adaptadores: { gemini: ad }, aislamiento: aisFalso(lugar), lanzar });
  const r = await ej({ motor: 'gemini', herramientasClaude: [], mcp, prompt: 'hola' }, { sesion: 's', nueva: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /ignoró la config de seguridad/);

  const l2 = lanzarCon({ salida: [
    { type: 'init', session_id: 'g-1', model: 'gemini-2.5-flash' },
    { type: 'message', role: 'user', content: 'hola' },
    { type: 'tool_use', tool_name: 'mcp_superagent_responder', tool_id: 'x', parameters: {} },
    { type: 'message', role: 'assistant', content: 'Lis', delta: true },
    { type: 'message', role: 'assistant', content: 'to.', delta: true },
    { type: 'result', status: 'success', stats: { input_tokens: 200, output_tokens: 10, cached: 40, tool_calls: 1 } },
  ] });
  const r2 = await crearEjecutorComun({ adaptadores: { gemini: ad }, aislamiento: aisFalso(lugar), lanzar: l2.lanzar })({ motor: 'gemini', herramientasClaude: [], mcp, prompt: 'hola' }, { sesion: 'g-1', nueva: false });
  assert.deepEqual([r2.ok, r2.sessionId, r2.resultado, r2.herramientas[0], r2.uso.cache, r2.uso.costo], [true, 'g-1', 'Listo.', 'mcp__superagent__responder', 40, null]);
  assert.ok(l2.llamadas[0].args.includes('--resume'));
});

test('Respaldo y topes: con el principal en su límite sigue el respaldo; con todos sobre su tope no corre nada', () => {
  const ajustes = ajustesFalsos();
  const gastos = { opencode: 0 };
  const cuenta = { tokenActual: () => 'oat', tieneClaveApi: () => false };
  const m = crearMotores({ ajustes, cuenta, gasto: (mt) => gastos[mt] ?? 0, adaptadores: {
    claude: crearAdaptadorClaude({ cuenta: {} }), 'claude-api': crearAdaptadorClaude({ cuenta: {}, credencial: 'api' }),
    opencode: crearAdaptadorOpenCode({ clave: () => 'k', dirConfigVacio: os.tmpdir() }),
  } });
  const spec = { completo: true };
  assert.equal(m.elegir(spec).motor, 'claude');
  m.bloquear('claude', 'limite');
  assert.equal(m.elegir(spec).motor, 'claude', 'sin respaldo, se queda con el suyo');
  m.configurar({ respaldo: [{ motor: 'opencode', modelo: 'deepseek/deepseek-chat' }], topes: { opencode: { dia: 1, mes: null } } });
  const e = m.elegir(spec);
  assert.deepEqual([e.motor, e.modelo, e.respaldo], ['opencode', 'deepseek/deepseek-chat', true]);
  assert.match(e.nota, /claude está en su límite/);
  gastos.opencode = 1.5;
  assert.equal(m.elegir(spec).motor, 'claude', 'el respaldo pasó su tope: vuelve al principal (y su error sigue el camino de siempre)');
  m.configurar({ propietario: { motor: 'opencode', modelo: 'deepseek/deepseek-chat' }, respaldo: null });
  assert.match(m.elegir(spec).detener, /tope diario de US\$ 1/);
  assert.throws(() => m.configurar({ topes: { claude: { dia: 1 } } }), /no se cobra por uso/);
  assert.equal(m.estado().motores.find((x) => x.id === 'opencode').sobreTope, 'llegó a su tope diario de US$ 1');
});

test('Respaldo en vivo: Claude llega al límite, la misma charla sigue con el respaldo y el Propietario se entera', async () => {
  const vistos = [];
  const t = armar({
    cuentaClaude: { tokenActual: () => 'oat', tieneClaveApi: () => false, preguntar: async () => null },
    guion: (spec) => (vistos.push(spec.motor), spec.motor === 'claude' ? { falla: 'limite', error: 'usage limit reached' } : [{ herramienta: 'responder', args: { texto: `te respondo con ${spec.motor}` } }]),
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  t.nucleo.entorno.guardar('GEMINI_API_KEY', 'clave-de-prueba');
  t.nucleo.motores.configurar({ respaldo: [{ motor: 'gemini', modelo: 'gemini-2.5-flash' }] });
  await entra(t, '5491111111111', 'hola');
  await t.avanzar(46_000);
  assert.deepEqual(vistos, ['claude', 'gemini']);
  assert.match(t.corridas.at(-1).spec.clave, /^gemini:/);
  assert.equal(t.db.prepare('SELECT credencial_usada FROM corridas ORDER BY id DESC LIMIT 1').get().credencial_usada, 'gemini');
  assert.ok(t.waha.enviados.some((e) => /te respondo con gemini/.test(e.texto ?? '')), 'la respuesta llega');
  const textos = t.nucleo.avisos.listar().map((a) => a.texto ?? a.cuerpo ?? '');
  assert.ok(textos.some((x) => /respaldo de motores[\s\S]*claude llegó a su límite: sigo con gemini/.test(x)), JSON.stringify(textos));
  // La próxima charla ya arranca con el respaldo (Claude sigue en su límite por un rato).
  vistos.length = 0;
  await entra(t, '5491111111111', 'otra');
  await t.avanzar(46_000);
  assert.deepEqual(vistos, ['gemini'], 'no vuelve a probar Claude mientras está bloqueado');
  t.limpiar();
});

test('Tope de gasto: si el motor de esa charla pasó su tope, no corre y se avisa', async () => {
  const t = armar({ guion: () => [{ herramienta: 'responder', args: { texto: 'hola' } }] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  t.nucleo.motores.configurar({ terceros: { motor: 'opencode', modelo: 'opencode/x-free' }, topes: { opencode: { dia: 0, mes: null } } });
  const antes = t.corridas.length;
  await entra(t, '5491144444444', 'hola, quiero info');
  await t.avanzar(46_000);
  assert.equal(t.corridas.length, antes, 'no corrió');
  const textos = t.nucleo.avisos.listar().map((a) => a.texto ?? a.cuerpo ?? '');
  assert.ok(textos.some((x) => /tope de gasto[\s\S]*opencode llegó a su tope diario/.test(x)), JSON.stringify(textos));
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM mensajes WHERE chat_id = '5491144444444@c.us' AND procesado = 0").get().n, 1, 'el mensaje queda en cola');
  t.limpiar();
});
