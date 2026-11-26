import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { normalizarJid } from '../src/wa/webhook.mjs';
import { crearWaha, normalizarTelefono } from '../src/wa/waha.mjs';
import { armar } from './ayuda.mjs';
import { totp, pasoActual } from '../src/auth/cripto.mjs';

const firmar = (clave, txt) => crypto.createHmac('sha512', clave).update(txt).digest('hex');

async function webhook(app, cuerpo, firma) {
  return app.request('/webhook/waha', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-hmac': firma }, body: cuerpo });
}

test('webhook: firma válida guarda, inválida rechaza, duplicado no repite', async () => {
  const { app, db, config } = armar();
  const evt = JSON.stringify({ event: 'message.any', session: 'default', payload: { id: 'M1', from: '5491100000000@s.whatsapp.net', body: 'hola', timestamp: 1 } });
  assert.equal((await webhook(app, evt, 'x'.repeat(128))).status, 401);
  assert.equal((await webhook(app, evt, '')).status, 401);
  const r = await webhook(app, evt, firmar(config.waha.hmacKey, evt));
  assert.equal((await r.json()).resultado, 'guardado');
  assert.equal((await (await webhook(app, evt, firmar(config.waha.hmacKey, evt))).json()).resultado, 'duplicado');
  const m = db.prepare('SELECT chat_id, cuerpo FROM mensajes').all();
  assert.deepEqual(m.map((x) => ({ ...x })), [{ chat_id: '5491100000000@c.us', cuerpo: 'hola' }]);

  const est = JSON.stringify({ event: 'session.status', session: 'default', payload: { status: 'WORKING' } });
  await webhook(app, est, firmar(config.waha.hmacKey, est));
  assert.equal(db.prepare('SELECT estado FROM eventos_wa').get().estado, 'WORKING');
});

test('normalización de JID y teléfono', () => {
  assert.equal(normalizarJid('5491100000000:12@s.whatsapp.net'), '5491100000000@c.us');
  assert.equal(normalizarJid('123@g.us'), '123@g.us');
  assert.equal(normalizarTelefono('+54 9 11 5555-0123'), '5491155550123');
  assert.equal(normalizarTelefono('123'), null);
});

test('cliente WAHA: request-code manda phoneNumber y devuelve el código', async () => {
  const llamadas = [];
  const fakeFetch = async (url, op) => {
    llamadas.push({ url, op });
    return new Response(JSON.stringify({ code: 'ABCD-EFGH' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  const w = crearWaha({ url: 'http://waha:3000', apiKey: 'k', session: 'default', fetch: fakeFetch });
  assert.deepEqual(await w.pedirCodigo('5491100000000'), { codigo: 'ABCD-EFGH' });
  assert.equal(llamadas[0].url, 'http://waha:3000/api/default/auth/request-code');
  assert.equal(llamadas[0].op.headers['X-Api-Key'], 'k');
  assert.deepEqual(JSON.parse(llamadas[0].op.body), { phoneNumber: '5491100000000' });
});

test('API de WhatsApp: código de vinculación valida el número', async () => {
  const pedidos = [];
  const { pedir } = armar({ waha: { pedirCodigo: async (t) => { pedidos.push(t); return { codigo: 'WXYZ-1234' }; } } });
  const ini = await pedir('POST', '/api/setup/iniciar', { codigo: 'PRUE-BA12-3456', email: 'a@b.co', contrasena: 'contraseña-bien-larga' });
  await pedir('POST', '/api/setup/confirmar', { token: ini.json.token, totp: totp(ini.json.secreto, pasoActual()) });
  assert.equal((await pedir('POST', '/api/whatsapp/codigo', { telefono: 'abc' })).status, 400);
  const r = await pedir('POST', '/api/whatsapp/codigo', { telefono: '+54 11 0000 0000' });
  assert.equal(r.json.codigo, 'WXYZ-1234');
  assert.deepEqual(pedidos, ['541100000000']);
});

test('CSRF: POST de otro origen o sin JSON se rechaza', async () => {
  const { app } = armar();
  const r1 = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'localhost', Origin: 'https://malo.example' }, body: '{}' });
  assert.equal(r1.status, 403);
  const r2 = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain', Host: 'localhost' }, body: '{}' });
  assert.equal(r2.status, 415);
});
