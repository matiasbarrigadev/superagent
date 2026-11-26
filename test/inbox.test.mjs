// Bandeja del panel: conversaciones de WhatsApp con su último mensaje, sin leer y lectura por chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe, entrarComoPropietario } from './ayuda.mjs';

test('bandeja: lista con último mensaje y sin leer; abrir el chat lo marca leído', async () => {
  const t = armar({ guion: () => [] });
  await entrarComoPropietario(t);
  persona(t.db, { nombre: 'Ana', telefono: '5491155550101' });
  await escribe(t.nucleo, { telefono: '5491155550101', texto: 'hola *agente*', nombre: 'Ana' });
  await escribe(t.nucleo, { telefono: '5491155550101', texto: '¿estás?', nombre: 'Ana' });

  const l = await t.pedir('GET', '/api/inbox');
  assert.equal(l.status, 200);
  const chat = l.json.chats.find((x) => x.id.startsWith('5491155550101'));
  assert.ok(chat, JSON.stringify(l.json.chats));
  assert.equal(chat.persona, 'Ana');
  assert.equal(chat.ultimo_texto, '¿estás?');
  assert.equal(chat.sin_leer, 2);
  assert.ok(!l.json.chats.some((x) => x.id.startsWith('panel:')));

  const m = await t.pedir('GET', `/api/inbox/mensajes?chat=${encodeURIComponent(chat.id)}`);
  assert.equal(m.status, 200);
  assert.deepEqual(m.json.mensajes.map((x) => x.cuerpo), ['hola *agente*', '¿estás?']);
  assert.equal((await t.pedir('GET', '/api/inbox')).json.chats.find((x) => x.id === chat.id).sin_leer, 0);

  assert.equal((await t.pedir('GET', '/api/inbox/mensajes?chat=panel%3A1')).status, 404);
  t.olvidarCookie?.();
});
