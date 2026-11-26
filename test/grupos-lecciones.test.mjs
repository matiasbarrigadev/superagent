// Etapas 6b (grupos habilitados uno por uno) y 7d (lecciones).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe, entrarComoPropietario } from './ayuda.mjs';

const G = '120363000000000077@g.us';

test('grupos: inactivo no genera corridas; activo sin mención tampoco; con mención, una sola', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491133330000', texto: '¿quién trae las sillas?', grupo: G, mencion: true });
  await t.avanzar(46_000);
  assert.equal(t.corridas.length, 0, 'grupo nuevo: inactivo');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'activá este grupo', grupo: G });
  await t.avanzar(0);
  assert.equal(t.db.prepare('SELECT activo FROM chats WHERE id = ?').get(G).activo, 1);
  assert.ok(t.waha.enviados.some((e) => e.chatId === G && /activo en este grupo/.test(e.texto)));
  await escribe(t.nucleo, { telefono: '5491133330000', texto: 'buen día a todos', grupo: G });
  await t.avanzar(46_000);
  assert.equal(t.corridas.length, 0, 'activo pero sin mención');
  await escribe(t.nucleo, { telefono: '5491133330000', texto: '¿me pasás la lista?', grupo: G, mencion: true });
  await t.avanzar(10_000);
  await escribe(t.nucleo, { telefono: '5491133330000', texto: 'la de proveedores', grupo: G, mencion: true });
  await t.avanzar(46_000);
  assert.equal(t.corridas.length, 1, 'la ráfaga se junta en una corrida');
  assert.match(t.corridas[0].spec.prompt, /<contexto_del_grupo>[\s\S]*buen día a todos/);
  t.limpiar();
});

test('activar un grupo desde el número de un Colaborador falla', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'activá este grupo', grupo: G });
  await t.avanzar(0);
  assert.equal(t.db.prepare('SELECT activo FROM chats WHERE id = ?').get(G).activo, 0);
  assert.ok(t.waha.enviados.some((e) => /Solo el Propietario/.test(e.texto)));
  t.limpiar();
});

test('lecciones: la del Propietario entra en la corrida siguiente; la de un Colaborador, recién cuando se aprueba', async () => {
  const t = armar({
    guion: (spec) => (spec.prompt.includes('no le hables de usted') ? [{ herramienta: 'guardar_leccion', args: { regla: 'No hablar de usted', como_aplicar: 'tutear siempre' } }]
      : spec.prompt.includes('respaldá') ? [{ herramienta: 'guardar_leccion', args: { regla: 'Antes de migrar, respaldar la base' } }] : []),
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'no le hables de usted a nadie' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'antes de migrar respaldá la base' });
  await t.avanzar(46_000);
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await escribe(t.nucleo, { telefono: '5491199999999', texto: 'hola' });
  await t.avanzar(46_000);
  const colab = t.corridas.filter((c) => c.spec.personaId === 2).at(-1);
  assert.match(colab.spec.prompt, /# Lecciones[\s\S]*No hablar de usted \(tutear siempre\)/);
  assert.ok(!colab.spec.prompt.includes('respaldar la base'), 'la propuesta no entra');
  assert.match(colab.spec.agentes.explorador.prompt, /No hablar de usted/, 'los subagentes también la reciben');
  const tercero = t.corridas.at(-1);
  assert.ok(!tercero.spec.prompt.includes('No hablar de usted'), 'al Tercero solo le llegan las públicas');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'dale A-1' });
  await t.avanzar(0);
  assert.equal(t.db.prepare("SELECT estado FROM lecciones WHERE regla LIKE 'Antes%'").get().estado, 'activa');
  t.limpiar();
});

test('panel: las lecciones se ven, se editan, se desactivan y se borran', async () => {
  const t = armar();
  await entrarComoPropietario(t);
  const { json: { id } } = await t.pedir('POST', '/api/lecciones', { regla: 'Firmar los mails con el nombre del agente', publica: true });
  assert.equal((await t.pedir('PATCH', `/api/lecciones/${id}`, { estado: 'desactivada' })).status, 200);
  const l = (await t.pedir('GET', '/api/lecciones')).json.lecciones[0];
  assert.equal(l.estado, 'desactivada');
  assert.equal(l.publica, true);
  assert.equal((await t.pedir('DELETE', `/api/lecciones/${id}`)).status, 200);
  assert.equal((await t.pedir('GET', '/api/lecciones')).json.lecciones.length, 0);
  t.limpiar();
});
