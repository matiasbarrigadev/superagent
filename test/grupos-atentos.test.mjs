// Grupos activos: el agente lee toda la charla y un filtro barato decide si es para él.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe } from './ayuda.mjs';
import { analizarGrupo } from '../src/wa/webhook.mjs';

const G = '120363000000000055@g.us';

function montar(decide) {
  const preguntas = [];
  const t = armar({ guion: () => [], cuentaClaude: { preguntar: async (o) => { preguntas.push(o); return decide(o); }, usoPlan: async () => null } });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Ana', telefono: '5491122222222', rol: 'Colaborador', verificada: 1 });
  t.nucleo.ajustes.set('nombre_agente', 'Sandro');
  t.db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, nombre, creado) VALUES (?, 'grupo', 1, 1, 'Equipo', 0)").run(G);
  return { t, preguntas };
}

test('diminutivos y apodos cuentan como mención', () => {
  const a = (body, o = {}) => analizarGrupo({ body }, { nombreAgente: 'Sandro', ...o }).menciona;
  assert.equal(a('Sandrito, ¿me ayudás?'), true);
  assert.equal(a('che sandrín'), true);
  assert.equal(a('Sandra vino ayer'), false);
  assert.equal(a('Sandi mirá esto', { apodos: ['Sandi'] }), true);
});

test('grupo atento: lo que no lo nombra pasa por el filtro; si es para él, corre; si no, queda como contexto', async () => {
  const { t, preguntas } = montar((o) => (o.texto.includes('qué opinás vos') ? 'SI' : 'NO'));
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'mañana almorzamos juntos?', grupo: G });
  await t.avanzar(46_000);
  assert.equal(t.corridas.length, 0, 'charla entre personas: no corre');
  assert.equal(preguntas.length, 1);
  assert.match(preguntas[0].sistema, /se llama Sandro/);
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'agente, qué opinás vos del diseño?', grupo: G });
  await t.avanzar(46_000);
  assert.equal(t.corridas.length, 1, 'le preguntaron a él: corre');
  assert.match(preguntas.at(-1).texto, /mañana almorzamos juntos\?[\s\S]*>> Ana: agente, qué opinás vos/);
  t.limpiar();
});

test('grupo atento: si lo nombran no hace falta el filtro; en "solo menciones" no se lee lo demás', async () => {
  const { t, preguntas } = montar(() => 'SI');
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'Sandrito, me pasás el link?', grupo: G });
  await t.avanzar(46_000);
  assert.equal(t.corridas.length, 1);
  assert.equal(preguntas.length, 0);
  t.db.prepare('UPDATE chats SET responder_solo_si_mencionan = 1 WHERE id = ?').run(G);
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'y vos qué pensás?', grupo: G });
  await t.avanzar(46_000);
  assert.equal(t.corridas.length, 1);
  assert.equal(preguntas.length, 0);
  t.limpiar();
});

test('el Propietario pide sumarse a un grupo: el agente lo activa y guarda sus apodos', async () => {
  const t = armar({ guion: (spec) => (spec.prompt.includes('sumate al grupo') ? [
    { herramienta: 'chats', args: { accion: 'configurar', chat: 'quip', activo: true, apodos: 'Sandrito, Sandri' } },
  ] : []) });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  t.db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, nombre, creado) VALUES (?, 'grupo', 1, 0, 'Equipo', 0)").run(G);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'sumate al grupo del equipo' });
  await t.avanzar(5000);
  assert.match(t.corridas.at(-1).resultados[0].r.content[0].text, /Equipo → .*activo/);
  assert.equal(t.db.prepare('SELECT activo FROM chats WHERE id = ?').get(G).activo, 1);
  assert.equal(t.nucleo.ajustes.get('apodos_agente'), 'Sandrito, Sandri');
  t.limpiar();
});
