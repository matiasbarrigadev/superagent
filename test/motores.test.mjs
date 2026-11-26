// Motores: adaptador de OpenCode (config que niega lo que el rol no tiene, entorno, lectura de eventos),
// Claude con clave de API (la clave no pisa la suscripción), elección por tipo de corrida y configurar_motores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { configOpenCode, crearAdaptadorOpenCode, clasificarErrorOpenCode } from '../src/engine/opencode.mjs';
import { crearAdaptadorClaude } from '../src/engine/claude.mjs';
import { crearEjecutorComun } from '../src/engine/ejecutor.mjs';
import { crearMotores, tipoMotor } from '../src/engine/motores.mjs';
import { armar, persona } from './ayuda.mjs';

const mcp = { url: 'http://127.0.0.1:8081/mcp', token: 'tok-mcp-secreto' };

test('OpenCode: un rol sin herramientas no tiene ninguna, y nada queda esperando a una persona', () => {
  const c = configOpenCode({ herramientasClaude: [], mcp });
  assert.ok(Object.values(c.tools).every((v) => v === false), JSON.stringify(c.tools));
  assert.deepEqual(c.permission, { bash: 'deny', edit: 'deny', webfetch: 'deny', external_directory: 'deny', doom_loop: 'deny' });
  assert.equal(c.share, 'disabled');
  assert.ok(!JSON.stringify(c).includes('*'), 'sin comodines: cuelgan la versión 1');
  assert.ok(!JSON.stringify(c).includes('tok-mcp-secreto'), 'el token va por entorno, no en la config');
  assert.equal(c.mcp.superagent.headers.Authorization, 'Bearer {env:SUPERAGENT_MCP_TOKEN}');
});

test('OpenCode: leer sin editar ni terminal; el modo completo tiene todo menos preguntar', () => {
  const l = configOpenCode({ herramientasClaude: ['Read', 'Glob', 'Grep'], mcp });
  assert.equal(l.tools.read, true);
  assert.equal(l.tools.grep, true);
  for (const t of ['bash', 'edit', 'write', 'patch', 'webfetch', 'websearch', 'task', 'question']) assert.equal(l.tools[t], false, t);
  const c = configOpenCode({ completo: true, herramientasClaude: [], mcp, mcpExtra: { navegador: { type: 'stdio', command: 'playwright-mcp', args: ['--headless'] } } });
  assert.equal(c.tools.bash, true);
  assert.equal(c.tools.question, false);
  assert.equal(c.permission.external_directory, 'allow');
  assert.deepEqual(c.mcp.navegador, { type: 'local', command: ['playwright-mcp', '--headless'], enabled: true });
});

function lugarFalso() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-motor-'));
  const l = { clave: 'chat:x', usuario: { uid: 1, gid: 1 }, base };
  for (const d of ['config', 'trabajo', 'tmp', 'adjuntos', 'salida']) { l[d] = path.join(base, d); fs.mkdirSync(l[d]); }
  return l;
}
const aisFalso = (lugar) => ({
  activo: false, preparar: () => lugar, terminar() {}, copiarAdentro() {},
  escribirArchivo: (r, c) => fs.writeFileSync(r, c),
});

test('OpenCode: sin la clave del proveedor no corre; con la clave, entorno cerrado y config del proyecto ignorada', () => {
  const lugar = lugarFalso();
  const claves = {};
  const ad = crearAdaptadorOpenCode({ clave: (n) => claves[n] ?? null, dirConfigVacio: path.join(lugar.base, 'vacio') });
  const spec = { modelo: 'deepseek/deepseek-chat', herramientasClaude: [], mcp, sistema: 'Sos el agente.', prompt: 'hola', entornoExtra: { VERCEL_TOKEN: 'x' } };
  assert.throws(() => ad.preparar({ spec, lugar, aislamiento: aisFalso(lugar), sesion: 's', nueva: true }), (e) => e.tipoError === 'sin_sesion' && /DEEPSEEK_API_KEY/.test(e.message));
  claves.DEEPSEEK_API_KEY = 'sk-deepseek';
  const c = ad.preparar({ spec, lugar, aislamiento: aisFalso(lugar), sesion: 'ses_1', nueva: false });
  assert.equal(c.env.DEEPSEEK_API_KEY, 'sk-deepseek');
  assert.equal(c.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(c.env.XDG_CONFIG_HOME, path.join(lugar.base, 'vacio'));
  assert.equal(c.env.SUPERAGENT_MCP_TOKEN, 'tok-mcp-secreto');
  assert.equal(c.env.VERCEL_TOKEN, undefined, 'las variables del Propietario solo van en su modo completo');
  assert.equal(c.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.ok(c.args.includes('--session') && c.args.includes('ses_1'));
  assert.equal(c.args.at(-1), 'hola');
  assert.match(fs.readFileSync(JSON.parse(c.env.OPENCODE_CONFIG_CONTENT).instructions[0], 'utf8'), /Sos el agente[\s\S]*superagent_responder/);
  // Los modelos gratis de OpenCode no necesitan clave.
  assert.equal(ad.falta('opencode/deepseek-v4.1-flash-free'), null);
  assert.match(ad.falta('deepseek'), /proveedor\/modelo/);
});

/** spawn falso: devuelve las líneas dadas por stdout y stderr. */
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

test('OpenCode: lee la sesión, las herramientas, el texto final y el costo real', async () => {
  const lugar = lugarFalso();
  const ad = crearAdaptadorOpenCode({ clave: () => 'k', dirConfigVacio: path.join(lugar.base, 'vacio') });
  const s = 'ses_abc';
  const { lanzar } = lanzarCon({ salida: [
    { type: 'step_start', sessionID: s, part: {} },
    { type: 'tool_use', sessionID: s, part: { tool: 'superagent_responder', state: { status: 'completed' } } },
    { type: 'step_finish', sessionID: s, part: { reason: 'tool-calls', cost: 0.0012, tokens: { input: 1800, output: 50, reasoning: 20, cache: { read: 1900, write: 0 } } } },
    { type: 'step_start', sessionID: s, part: {} },
    { type: 'text', sessionID: s, part: { text: 'Listo, le respondí.' } },
    { type: 'step_finish', sessionID: s, part: { reason: 'stop', cost: 0.0003, tokens: { input: 130, output: 14, reasoning: 0, cache: { read: 3700, write: 0 } } } },
  ] });
  const ej = crearEjecutorComun({ adaptadores: { opencode: ad }, aislamiento: aisFalso(lugar), lanzar });
  const r = await ej({ motor: 'opencode', modelo: 'deepseek/deepseek-chat', herramientasClaude: [], mcp, prompt: 'hola' }, { sesion: 'x', nueva: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.sessionId, s);
  assert.equal(r.resultado, 'Listo, le respondí.');
  assert.deepEqual(r.herramientas, ['mcp__superagent__responder']);
  assert.equal(r.uso.costo.toFixed(4), '0.0015');
  assert.equal(r.uso.contexto, 3830);
});

test('OpenCode: el límite del proveedor (que solo sale en el log) corta la corrida como "limite"', async () => {
  const lugar = lugarFalso();
  const ad = crearAdaptadorOpenCode({ clave: () => 'k', dirConfigVacio: path.join(lugar.base, 'vacio') });
  const { lanzar } = lanzarCon({ errores: ['timestamp=x level=ERROR run=a message="stream error" error.error="AI_APICallError: Free usage limit reached. Subscribe"'] });
  const ej = crearEjecutorComun({ adaptadores: { opencode: ad }, aislamiento: aisFalso(lugar), lanzar });
  const r = await ej({ motor: 'opencode', modelo: 'opencode/x-free', herramientasClaude: [], mcp, prompt: 'hola' }, { sesion: 'x', nueva: true });
  assert.equal(r.ok, false);
  assert.equal(r.tipoError, 'limite');
  assert.equal(clasificarErrorOpenCode('Error: Session not found'), 'sesion_perdida');
  assert.equal(clasificarErrorOpenCode('401 Unauthorized: invalid api key'), 'sin_sesion');
});

test('Claude: la clave de API del entorno no pisa la suscripción; con el motor de API va solo la clave', () => {
  const lugar = lugarFalso();
  const pedidos = [];
  const cuenta = {
    comando: (args) => ({ file: 'claude', args }),
    entorno: ({ credencial }) => { pedidos.push(credencial); return credencial === 'api' ? { ANTHROPIC_API_KEY: 'sk-ant-api' } : { CLAUDE_CODE_OAUTH_TOKEN: 'oat' }; },
  };
  const spec = { completo: true, herramientasClaude: [], herramientasGateway: [], mcp, modelo: 'sonnet', prompt: 'hola', entornoExtra: { ANTHROPIC_API_KEY: 'sk-ant-del-entorno', VERCEL_TOKEN: 'v' } };
  const sus = crearAdaptadorClaude({ cuenta }).preparar({ spec, lugar, aislamiento: aisFalso(lugar), sesion: 's', nueva: true });
  assert.equal(sus.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(sus.env.CLAUDE_CODE_OAUTH_TOKEN, 'oat');
  assert.equal(sus.env.VERCEL_TOKEN, 'v');
  const api = crearAdaptadorClaude({ cuenta, credencial: 'api' }).preparar({ spec, lugar, aislamiento: aisFalso(lugar), sesion: 's', nueva: true });
  assert.equal(api.env.ANTHROPIC_API_KEY, 'sk-ant-api');
  assert.equal(api.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(pedidos, ['suscripcion', 'api']);
});

function ajustesFalsos() {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
}

test('Elección de motor: por tipo de corrida, sin suscripción usa la clave, y un motor que no garantiza el rol no corre', () => {
  const ajustes = ajustesFalsos();
  let token = 'oat', clave = false;
  const cuenta = { tokenActual: () => token, tieneClaveApi: () => clave };
  const claude = crearAdaptadorClaude({ cuenta: {} });
  const opencode = crearAdaptadorOpenCode({ clave: () => 'k', dirConfigVacio: os.tmpdir() });
  const flojo = { id: 'flojo', familia: 'flojo', puedeNegar: new Set(['Read']) };
  const m = crearMotores({ ajustes, adaptadores: { claude, 'claude-api': crearAdaptadorClaude({ cuenta: {}, credencial: 'api' }), opencode, flojo }, cuenta });
  assert.equal(tipoMotor({ completo: true }), 'propietario');
  assert.equal(tipoMotor({ variante: 'tercero' }), 'terceros');
  assert.equal(tipoMotor({ tipo: 'sesion' }), 'trabajos');
  assert.equal(m.elegir({ variante: 'tercero', herramientasClaude: [] }).motor, 'claude');
  assert.throws(() => m.configurar({ terceros: { motor: 'opencode' } }), /modelo/);
  m.configurar({ terceros: { motor: 'opencode', modelo: 'deepseek/deepseek-chat' }, equipo: { motor: 'flojo' } });
  const e = m.elegir({ variante: 'tercero', herramientasClaude: [] });
  assert.deepEqual([e.motor, e.modelo, e.familia], ['opencode', 'deepseek/deepseek-chat', 'opencode']);
  assert.equal(m.elegir({ completo: true }).motor, 'claude', 'el resto sigue con Claude');
  const f = m.elegir({ tipo: 'orquestador', herramientasClaude: ['Read'] });
  assert.equal(f.motor, 'claude');
  assert.match(f.nota, /no puede sacar/);
  token = null; clave = true;
  assert.equal(m.elegir({ completo: true }).motor, 'claude-api', 'instalación solo con clave de API');
  m.configurar({ terceros: null });
  assert.equal(m.elegir({ variante: 'tercero', herramientasClaude: [] }).motor, 'claude-api');
});

test('configurar_motores: solo el Propietario, con ficha y confirmación en otro mensaje; la charla de terceros cambia de motor', async () => {
  const cambios = { terceros: { motor: 'opencode', modelo: 'opencode/deepseek-v4.1-flash-free' } };
  const t = armar({
    guion: (spec) => {
      if (spec.prompt.includes('qué motores')) return [{ herramienta: 'configurar_motores', args: { accion: 'ver' } }];
      if (spec.prompt.includes('sí, dale')) return [{ herramienta: 'configurar_motores', args: { accion: 'cambiar', cambios, confirmado: true } }];
      if (spec.prompt.includes('usá deepseek')) return [{ herramienta: 'configurar_motores', args: { accion: 'cambiar', cambios } }, { herramienta: 'configurar_motores', args: { accion: 'cambiar', cambios, confirmado: true } }];
      return [];
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  let n = 0;
  const entra = (de, texto) => { n++; return t.nucleo.ingesta({ event: 'message.any', session: 'default', me: { id: '5491100000001@c.us' }, payload: { id: `false_${de}@c.us_M${n}`, timestamp: 1_800_000_000, from: `${de}@c.us`, fromMe: false, body: texto, hasMedia: false, _data: { Info: { PushName: 'Alguien' } } } }); };
  const txt = (i = 0) => t.corridas.at(-1).resultados[i].r.content[0].text;

  await entra('5491111111111', 'qué motores hay?');
  await t.avanzar(46_000);
  assert.match(txt(), /terceros[^\n]*claude/);
  await entra('5491111111111', 'usá deepseek para los terceros');
  await t.avanzar(46_000);
  assert.match(txt(0), /Todavía no se cambió nada[\s\S]*terceros[^\n]*opencode con opencode\/deepseek/);
  assert.match(txt(1), /todavía no lo confirmó/);
  assert.equal(t.nucleo.motores.leer().terceros, undefined);
  await entra('5491111111111', 'sí, dale');
  await t.avanzar(46_000);
  assert.match(txt(), /Listo, quedó así/);
  assert.deepEqual(t.nucleo.motores.leer().terceros, cambios.terceros);

  await entra('5491133333333', 'hola, quiero info');
  await t.avanzar(46_000);
  const c = t.corridas.at(-1);
  assert.equal(c.spec.motor, 'opencode');
  assert.equal(c.spec.modelo, 'opencode/deepseek-v4.1-flash-free');
  assert.match(c.spec.clave, /^opencode:/, 'la sesión no se cruza con la de Claude');
  assert.equal(t.db.prepare('SELECT credencial_usada FROM corridas ORDER BY id DESC LIMIT 1').get().credencial_usada, 'opencode');

  await entra('5491122222222', 'hola');
  await t.avanzar(46_000);
  assert.ok(!t.corridas.at(-1).spec.herramientasGateway.includes('configurar_motores'), 'un Colaborador no la tiene');
  t.limpiar();
});
