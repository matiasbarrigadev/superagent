// "Ver al agente": pasos de cada turno en palabras simples, tachados; mensajes descartados con su motivo; solo el
// Propietario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe, entrarComoPropietario } from './ayuda.mjs';
import { crearAdaptadorClaude } from '../src/engine/claude.mjs';
import { describirHerramienta, resumirTurno } from '../src/servicios/actividad.mjs';

test('el lector de Claude da texto, llamadas y resultados como pasos', () => {
  const ad = crearAdaptadorClaude({ cuenta: {} });
  const lector = ad.lector();
  assert.equal(lector.pasosPropios, true);
  const pasos = [];
  const r = { herramientas: [] };
  lector.linea(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reviso el repo' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'git status', description: 'Ver cambios' } }] } }), r, (p) => pasos.push(p));
  lector.linea(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'nada para commitear' }] }] } }), r, (p) => pasos.push(p));
  assert.deepEqual(pasos.map((p) => p.tipo), ['texto', 'herramienta', 'resultado']);
  assert.equal(pasos[2].ref, 'u1');
  assert.deepEqual(r.herramientas, ['Bash']);
});

test('títulos en palabras simples y resumen del turno', () => {
  assert.equal(describirHerramienta('Bash', { command: 'npm i', description: 'Instalar dependencias' }).titulo, 'Ejecutó un comando: Instalar dependencias');
  assert.equal(describirHerramienta('mcp__superagent__responder', { texto: 'hola' }).titulo, 'Respondió');
  assert.equal(describirHerramienta('mcp__superagent__no_responder', { motivo: 'no me hablan a mí' }).titulo, 'Decidió no responder: no me hablan a mí');
  assert.match(describirHerramienta('mcp__supabase__execute_sql', {}).titulo, /^Usó supabase: execute sql/);
  const pasos = [{ tipo: 'herramienta', categoria: 'comando' }, { tipo: 'herramienta', categoria: 'comando' }, { tipo: 'herramienta', categoria: 'responder', nombre: 'mcp__superagent__responder' }];
  assert.equal(resumirTurno(pasos, { disparo: 'recibió un mensaje de Ana' }), 'Recibió un mensaje de Ana, ejecutó 2 comandos y respondió');
});

test('se tachan secretos y no se guarda el contenido de archivos sensibles', () => {
  const t = armar();
  t.nucleo.entorno.guardar('API_DEMO', 'valor-super-secreto-123');
  const a = t.nucleo.actividad;
  const c = Number(t.db.prepare("INSERT INTO corridas (tipo, estado, inicio) VALUES ('orquestador', 'ok', 1)").run().lastInsertRowid);
  a.registrar(c, { tipo: 'herramienta', nombre: 'Bash', entrada: { command: 'echo valor-super-secreto-123' }, ref: 'x1' });
  a.registrar(c, { tipo: 'resultado', ref: 'x1', salida: 'valor-super-secreto-123 y Bearer abcdefghijklmnopqrstu' });
  a.registrar(c, { tipo: 'herramienta', nombre: 'Read', entrada: { file_path: '/home/x/.env' }, ref: 'x2' });
  a.registrar(c, { tipo: 'resultado', ref: 'x2', salida: 'CLAVE=algo' });
  const pasos = a.pasos(c);
  const todo = JSON.stringify(pasos);
  assert.ok(!todo.includes('valor-super-secreto-123'), todo);
  assert.ok(!todo.includes('abcdefghijklmnopqrstu'));
  assert.ok(!todo.includes('CLAVE=algo'));
  assert.match(pasos[3].detalle, /archivo sensible/);
  t.limpiar();
});

test('el panel muestra turnos, el motivo de no responder y los mensajes descartados', async () => {
  const t = armar({
    guion: async (spec, ctx, llamar) => {
      if (spec.prompt.includes('ojo eh')) await llamar('no_responder', { motivo: 'charla entre ellos, no me nombran' });
      else await llamar('responder', { texto: 'hola!' });
    },
  });
  await entrarComoPropietario(t);
  persona(t.db, { nombre: 'Ana', telefono: '5492222222222', rol: 'Colaborador', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5492222222222', texto: 'ojo eh' });
  await t.avanzar(46_000);
  // Un número sin alta: el gateway no se lo pasa al agente.
  t.db.prepare('UPDATE cuentas SET responder_sin_alta = 0 WHERE id = 1').run();
  await escribe(t.nucleo, { telefono: '5493333333333', texto: 'hola, quién sos?' });
  await t.avanzar(46_000);

  const r = await t.pedir('GET', '/api/actividad');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const turno = r.json.items.find((i) => i.clase === 'turno' && /Ana/.test(i.resumen));
  assert.match(turno.resumen, /^Recibió un mensaje de Ana/);
  assert.equal(turno.noResponde, 'charla entre ellos, no me nombran');
  const desc = r.json.items.find((i) => i.clase === 'descarte');
  assert.match(desc.motivo, /sin alta/);
  assert.match(desc.texto, /quién sos/);

  const d = await t.pedir('GET', `/api/actividad/turnos/${turno.id}`);
  assert.equal(d.json.mensajes[0].texto, 'ojo eh');
  assert.deepEqual(d.json.pasos.map((p) => p.tipo), ['herramienta', 'resultado']);
  assert.match(d.json.pasos[0].titulo, /Decidió no responder/);

  const e = await t.pedir('GET', '/api/actividad/estado');
  assert.equal(e.status, 200);
  assert.ok(Array.isArray(e.json.enCurso));
  t.limpiar();
});

test('en vivo: el panel recibe cada paso apenas pasa (solo con sesión del Propietario)', async () => {
  const t = armar();
  const sin = await t.pedirCrudo('GET', '/api/actividad/vivo');
  assert.equal(sin.status, 401);
  await entrarComoPropietario(t);
  const r = await t.pedirCrudo('GET', '/api/actividad/vivo');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const lector = r.body.getReader();
  const dec = new TextDecoder();
  let texto = '';
  const leerHasta = async (patron) => {
    while (!patron.test(texto)) {
      const { value, done } = await lector.read();
      if (done) break;
      texto += dec.decode(value);
    }
  };
  await leerHasta(/event: listo/);
  const c = Number(t.db.prepare("INSERT INTO corridas (tipo, estado, inicio) VALUES ('orquestador', 'corriendo', 1)").run().lastInsertRowid);
  t.nucleo.actividad.turno('inicio', c);
  t.nucleo.actividad.registrar(c, { tipo: 'herramienta', nombre: 'Bash', entrada: { command: 'ls', description: 'Listar' }, ref: 'z' });
  await leerHasta(/event: paso/);
  assert.match(texto, /event: turno/);
  assert.match(texto, /Ejecutó un comando: Listar/);
  await lector.cancel();
  t.limpiar();
});
