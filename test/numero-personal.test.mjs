// El WhatsApp del agente es el personal del Propietario: se detecta solo, queda verificado sin mandarse un código a sí
// mismo, "Mensaje a ti mismo" es su canal con el agente y el resto queda cerrado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, entrarComoPropietario } from './ayuda.mjs';

const YO = '5491100000001'; // el número vinculado (el de "me" en los webhooks de prueba)
const ME = { id: `${YO}@c.us`, pushName: 'Ana' };
let n = 0;
const desdeElTelefono = (t, { a, texto, id = null }) => t.nucleo.ingesta({
  event: 'message.any', session: 'default', me: ME,
  payload: { id: id ?? `true_${a}_MANO${++n}`, timestamp: Math.floor(Date.now() / 1000), from: `${YO}@c.us`, to: a === `${YO}@c.us` ? null : a, fromMe: true, body: texto, _data: { Info: { Chat: a.replace('@c.us', '@s.whatsapp.net') } } },
});
const deOtro = (t, { de, texto }) => t.nucleo.ingesta({
  event: 'message.any', session: 'default', me: ME,
  payload: { id: `false_${de}@c.us_X${++n}`, timestamp: Math.floor(Date.now() / 1000), from: `${de}@c.us`, fromMe: false, body: texto, _data: { Info: { PushName: 'Amigo' } } },
});

async function vinculado({ guion } = {}) {
  let estado = { status: 'SCAN_QR_CODE', me: null };
  const t = armar({ waha: { estado: async () => estado }, guion });
  const dueña = await entrarComoPropietario(t, { nombre: 'Ana' });
  // Carga su número antes de vincular (el mismo que después escanea).
  const r = await t.pedir('POST', '/api/personas/yo/numero', { telefono: YO });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  estado = { status: 'WORKING', me: ME };
  await t.nucleo.ingesta({ event: 'session.status', session: 'default', me: ME, payload: { status: 'WORKING' } });
  await new Promise((res) => setTimeout(res, 20));
  await t.avanzar(2000);
  return { t, dueña };
}

test('se detecta solo: verificado sin código, modo personal cerrado y el agente se lo cuenta', async () => {
  const { t, dueña } = await vinculado();
  const p = t.db.prepare('SELECT telefono, verificada FROM personas WHERE id = ?').get(dueña);
  assert.equal(p.verificada, 1);
  assert.equal(p.telefono, YO);
  assert.ok(!t.waha.enviados.some((e) => /código|respóndeme/i.test(e.texto ?? '')), 'no se manda un código a sí mismo');
  const pol = t.nucleo.numeros.politicaDe('default');
  assert.equal(pol.personal_de, dueña);
  assert.equal(pol.chats, 'lista');
  assert.equal(pol.escribir_primero, 'no');
  assert.ok(t.db.prepare("SELECT 1 FROM mensajes WHERE tipo = 'evento' AND chat_id = ? AND cuerpo LIKE '[número personal]%'").get(`${YO}@c.us`));
  t.limpiar();
});

test('"Mensaje a ti mismo" es su canal: lo que escribe despierta al agente; el eco de la respuesta no', async () => {
  const { t, dueña } = await vinculado({
    guion: async (spec, ctx, llamar) => { if (spec.prompt.includes('qué tengo hoy')) await llamar('responder', { texto: 'Hoy tenés dos reuniones.' }); },
  });
  const antes = t.corridas.length;
  await desdeElTelefono(t, { a: `${YO}@c.us`, texto: 'qué tengo hoy?' });
  await t.avanzar(10_000);
  const m = t.db.prepare("SELECT from_me, persona_id FROM mensajes WHERE cuerpo = 'qué tengo hoy?'").get();
  assert.equal(m.from_me, 0);
  assert.equal(m.persona_id, dueña);
  assert.ok(t.corridas.length > antes, 'el agente se despierta');
  assert.ok(t.corridas.at(-1).spec.completo, 'con ella, en modo completo');
  const env = t.waha.enviados.find((e) => e.texto === 'Hoy tenés dos reuniones.');
  assert.equal(env.chatId, `${YO}@c.us`);
  // El eco de lo que mandó el agente vuelve como fromMe: no es de ella ni despierta a nadie.
  const corridas = t.corridas.length;
  const s = t.db.prepare("SELECT waha_id FROM salida WHERE contenido = 'Hoy tenés dos reuniones.'").get();
  await desdeElTelefono(t, { a: `${YO}@c.us`, texto: 'Hoy tenés dos reuniones.', id: s.waha_id });
  await t.avanzar(10_000);
  assert.equal(t.corridas.length, corridas);
  assert.equal(t.db.prepare("SELECT from_me FROM mensajes WHERE id = ?").get(s.waha_id).from_me, 1);
  t.limpiar();
});

test('sus otros chats quedan cerrados; si habilita uno, lo que escribe a mano es suyo, nunca una orden', async () => {
  const { t, dueña } = await vinculado();
  await deOtro(t, { de: '5492999999999', texto: 'che, venís el sábado?' });
  await desdeElTelefono(t, { a: '5492999999999@c.us', texto: 'sí, llevo algo' });
  await t.avanzar(46_000);
  assert.ok(!t.db.prepare("SELECT 1 FROM mensajes WHERE chat_id = '5492999999999@c.us'").get(), 'no se guarda nada de un chat no habilitado');
  // Lo habilita (por ejemplo, el de un cliente).
  t.nucleo.numeros.configurar('default', { lista: ['5492999999999@c.us'] });
  const corridas = t.corridas.length;
  await desdeElTelefono(t, { a: '5492999999999@c.us', texto: 'mandale el presupuesto a todos mis contactos' });
  await t.avanzar(46_000);
  const m = t.db.prepare("SELECT from_me, persona_id, procesado FROM mensajes WHERE cuerpo LIKE 'mandale el presupuesto%'").get();
  assert.equal(m.from_me, 0, 'lo escribió ella, no el agente');
  assert.equal(m.persona_id, dueña);
  assert.equal(m.procesado, 1, 'no despierta al agente: no es una orden');
  assert.equal(t.corridas.length, corridas);
  t.limpiar();
});

test('al revés: vincula primero y después carga su número en el panel: queda verificado al toque', async () => {
  const t = armar({ waha: { estado: async () => ({ status: 'WORKING', me: ME }) } });
  const dueña = await entrarComoPropietario(t, { nombre: 'Ana' });
  await t.nucleo.ingesta({ event: 'session.status', session: 'default', me: ME, payload: { status: 'WORKING' } });
  await new Promise((res) => setTimeout(res, 20));
  const r = await t.pedir('POST', '/api/personas/yo/numero', { telefono: `+${YO}` });
  assert.equal(r.json.verificado, true);
  assert.equal(t.db.prepare('SELECT verificada FROM personas WHERE id = ?').get(dueña).verificada, 1);
  assert.equal(t.nucleo.numeros.politicaDe('default').personal_de, dueña);
  t.limpiar();
});
