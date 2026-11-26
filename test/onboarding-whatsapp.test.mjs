// Onboarding por WhatsApp: el Propietario carga su número antes de vincular; al vincular, el agente le escribe;
// él confirma respondiendo con el código del panel, y ahí arranca la configuración. Una instalación nueva no le
// responde a números sin alta hasta que el Propietario lo decide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe } from './ayuda.mjs';
import { abrirBase } from '../src/db/index.mjs';

const TEL = '5491133334444';

test('número antes de vincular → saludo al conectar → confirma respondiendo con el código → arranca la configuración', async () => {
  const t = armar({ guion: () => [] });
  const dueño = persona(t.db, { nombre: 'Dueña', telefono: null, rol: 'Propietario' });
  const v = t.nucleo.verificacion;

  const r = await v.pedirPorRespuesta(dueño, TEL, { conectado: false });
  assert.equal(r.enviado, false);
  assert.match(r.codigo, /^\d{6}$/);
  assert.deepEqual(v.pendiente(dueño), { telefono: TEL, saludado: false });
  assert.equal(t.waha.enviados.length, 0);

  // Se vincula WhatsApp: el agente saluda (sin el código en el mensaje).
  assert.equal(await v.saludarPendientes(), 1);
  assert.equal(t.waha.enviados.at(-1).chatId, `${TEL}@c.us`);
  assert.ok(!t.waha.enviados.at(-1).texto.includes(r.codigo));
  assert.equal(await v.saludarPendientes(), 0, 'no saluda dos veces');

  // El código no se puede confirmar desde el panel: tiene que llegar desde el teléfono.
  assert.throws(() => v.confirmar(dueño, r.codigo), /WhatsApp/);

  // Un código equivocado no confirma.
  await escribe(t.nucleo, { telefono: TEL, texto: '000000' });
  assert.equal(t.db.prepare('SELECT verificada FROM personas WHERE id = ?').get(dueño).verificada, 0);

  // El código correcto, aunque venga con texto alrededor.
  await escribe(t.nucleo, { telefono: TEL, texto: `hola! es ${r.codigo.slice(0, 3)} ${r.codigo.slice(3)}` });
  const p = t.db.prepare('SELECT telefono, verificada FROM personas WHERE id = ?').get(dueño);
  assert.deepEqual({ ...p }, { telefono: TEL, verificada: 1 });
  assert.equal(v.pendiente(dueño), null);
  await t.avanzar(5_000);
  const corrida = t.corridas.at(-1).spec;
  assert.equal(corrida.variante, 'onboarding');
  assert.match(corrida.prompt, /confirmar su número respondiendo/);
  assert.ok(corrida.herramientasGateway.includes('chats'));
  t.limpiar();
});

test('alguien que recibe el saludo por error no puede volverse Propietario', async () => {
  const t = armar({ guion: () => [] });
  const dueño = persona(t.db, { nombre: 'Dueña', telefono: null, rol: 'Propietario' });
  await t.nucleo.verificacion.pedirPorRespuesta(dueño, TEL, { conectado: true });
  for (let i = 0; i < 6; i++) await escribe(t.nucleo, { telefono: TEL, texto: String(100000 + i) });
  assert.equal(t.db.prepare('SELECT verificada FROM personas WHERE id = ?').get(dueño).verificada, 0);
  t.limpiar();
});

test('instalación nueva: no responde a números sin alta hasta que el Propietario lo decida', () => {
  const db = abrirBase(':memory:');
  assert.equal(db.prepare('SELECT responder_sin_alta FROM cuentas WHERE id = 1').get().responder_sin_alta, 0);
});

test('el Propietario abre o cierra a los desconocidos desde la charla (chats → responder_desconocidos)', async () => {
  const t = armar({
    guion: (spec) => (spec.variante === 'tercero' ? [] : [{ herramienta: 'chats', args: { accion: 'configurar', responder_desconocidos: false } }]),
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'de a poco, no le respondas a desconocidos' });
  await t.avanzar(46_000);
  assert.equal(t.db.prepare('SELECT responder_sin_alta FROM cuentas WHERE id = 1').get().responder_sin_alta, 0);
  const antes = t.corridas.length;
  await escribe(t.nucleo, { telefono: '5491177778888', texto: 'hola, quién sos?' });
  await t.avanzar(46_000);
  assert.equal(t.corridas.length, antes, 'el desconocido no genera corrida');
  t.limpiar();
});
