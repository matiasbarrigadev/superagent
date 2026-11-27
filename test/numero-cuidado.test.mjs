// Cuidar el número: un 463 no se reintenta y frena los mensajes en frío; los números nuevos tienen tope diario; a
// quien da de alta el Propietario se lo agenda en el teléfono.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, entrarComoPropietario } from './ayuda.mjs';

const ERROR_463 = 'WAHA no pudo enviar el texto (500): {"statusCode":500,"timestamp":"2026-11-27T17:03:32.251Z","exception":{"message":"2 UNKNOWN: server returned error 463"}}';

test('un 463 no se reintenta, frena los mensajes en frío y el agente se entera', async () => {
  let intentos = 0;
  const t = armar({ waha: { enviarTexto: async () => { intentos++; throw new Error(ERROR_463); } } });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  t.nucleo.salida.encolar({ chatId: '5492222222222@c.us', texto: 'hola, soy el asistente', contactoNuevo: true });
  await t.avanzar(1000);
  await t.avanzar(10 * 60_000); // pasaría el reintento
  assert.equal(intentos, 1, 'no se reintenta');
  const f = t.db.prepare("SELECT estado, error FROM salida WHERE chat_id = '5492222222222@c.us'").get();
  assert.equal(f.estado, 'fallido');
  assert.match(f.error, /463/);
  assert.ok(t.db.prepare("SELECT 1 FROM mensajes WHERE tipo = 'evento' AND cuerpo LIKE '[WhatsApp no dejó escribirle a +5492222222222]%'").get());
  // Otro mensaje en frío: ni se intenta.
  t.nucleo.salida.encolar({ chatId: '5493333333333@c.us', texto: 'hola', contactoNuevo: true });
  await t.avanzar(10 * 60_000);
  assert.equal(intentos, 1);
  assert.match(t.db.prepare("SELECT error FROM salida WHERE chat_id = '5493333333333@c.us'").get().error, /restringió/);
  t.limpiar();
});

test('un número nuevo tiene tope de mensajes en frío por día', async () => {
  const enviados = [];
  const t = armar({ waha: { enviarTexto: async (chatId) => { enviados.push(chatId); return `id-${enviados.length}`; } } });
  t.db.prepare("UPDATE ajustes SET valor = '0' WHERE clave = 'ritmo_suave'").run();
  t.nucleo.ajustes.set('ritmo_suave', '0');
  for (let i = 0; i < 7; i++) t.nucleo.salida.encolar({ chatId: `54911000000${10 + i}@c.us`, texto: 'hola', contactoNuevo: true });
  await t.avanzar(1000);
  assert.equal(enviados.length, 5, 'los primeros días, 5 por día');
  await t.avanzar(25 * 3_600_000);
  assert.equal(enviados.length, 7, 'al día siguiente salen los que faltaban');
  t.limpiar();
});

test('a quien da de alta el Propietario se lo agenda en el teléfono', async () => {
  const agendados = [];
  const t = armar({ waha: { agendar: async (chatId, d) => { agendados.push([chatId, d.nombre]); return true; } } });
  await entrarComoPropietario(t);
  const roles = await t.pedir('GET', '/api/personas');
  const colab = roles.json.roles.find((r) => r.nombre === 'Colaborador');
  const r = await t.pedir('POST', '/api/personas', { nombre: 'Ana Pérez', telefono: '5494444444444', rolId: colab.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(agendados[0], ['5494444444444@c.us', 'Ana Pérez']);
  t.limpiar();
});
