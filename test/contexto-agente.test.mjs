// El nombre del agente y su zona horaria llegan a cada corrida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe } from './ayuda.mjs';

test('el prompt incluye el nombre guardado del agente', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  t.nucleo.ajustes.set('nombre_agente', 'Sandro');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'te llamás Sandro?' });
  await t.avanzar(46_000);
  assert.match(t.corridas.at(-1).spec.prompt, /Tu nombre: Sandro/);
  t.limpiar();
});

test('el Propietario recibe el link del panel; otro rol no', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'pasame el panel' });
  await t.avanzar(46_000);
  assert.match(t.corridas.at(-1).spec.prompt, /Panel de control: http:\/\/localhost:8080 \(dirección local/);
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await t.avanzar(46_000);
  assert.doesNotMatch(t.corridas.at(-1).spec.prompt, /Panel de control/);
  t.limpiar();
});
