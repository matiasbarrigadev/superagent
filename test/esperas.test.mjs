// Esperar una autorización: el agente deja cómo comprobarla, termina su turno y el gateway lo despierta en la charla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe } from './ayuda.mjs';
import { tacharTokens } from '../src/servicios/esperas.mjs';

function conEspera({ respuestas, minutos }) {
  const corridas = [];
  const t = armar({
    correrEsperas: async (comando) => { corridas.push(comando); return respuestas.shift() ?? { codigo: 1, salida: 'Error: not logged in' }; },
    guion: async (spec, ctx, llamar) => {
      if (spec.prompt.includes('conectá vercel')) {
        await llamar('esperar_autorizacion', { accion: 'esperar', servicio: 'Vercel', comprobar: 'vercel whoami', ...(minutos ? { minutos } : {}) });
        await llamar('responder', { texto: 'Entrá a este link y autorizá' });
      }
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  return { t, corridas };
}

test('queda conectado: el agente se despierta en la charla con el resultado, sin tokens', async () => {
  const { t, corridas } = conEspera({ respuestas: [{ codigo: 1, salida: 'not logged in' }, { codigo: 0, salida: 'Vercel CLI 39\nana-dev token=abcdefghijklmnop1234' }] });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'conectá vercel' });
  await t.avanzar(46_000);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM esperas').get().n, 1);
  await t.avanzar(10_000); // primera comprobación: todavía no
  await t.avanzar(10_000); // segunda: listo
  assert.deepEqual(corridas, ['vercel whoami', 'vercel whoami']);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM esperas').get().n, 0);
  const evt = t.db.prepare("SELECT chat_id, cuerpo FROM mensajes WHERE tipo = 'evento' AND cuerpo LIKE '[autorización Vercel lista]%'").get();
  assert.equal(evt.chat_id, '5491111111111@c.us');
  assert.match(evt.cuerpo, /ana-dev/);
  assert.ok(!evt.cuerpo.includes('abcdefghijklmnop1234'), 'el token no vuelve');
  await t.avanzar(5_000);
  assert.ok(t.corridas.some((c) => c.spec.prompt.includes('[autorización Vercel lista]')));
  t.limpiar();
});

test('vence: avisa que no se completó', async () => {
  const { t } = conEspera({ respuestas: [], minutos: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'conectá vercel' });
  await t.avanzar(46_000);
  for (let i = 0; i < 8; i++) await t.avanzar(10_000);
  assert.ok(t.db.prepare("SELECT 1 FROM mensajes WHERE tipo = 'evento' AND cuerpo LIKE '[autorización Vercel sin completar]%'").get());
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM esperas').get().n, 0);
  t.limpiar();
});

test('solo el Propietario la tiene', async () => {
  const t = armar({ guion: async () => {} });
  persona(t.db, { nombre: 'Colaboradora', telefono: '5492222222222', rol: 'Colaborador', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5492222222222', texto: 'hola' });
  await t.avanzar(46_000);
  const c = t.corridas.at(-1);
  assert.ok(!c.spec.herramientasGateway.some((h) => h.endsWith('esperar_autorizacion')));
  t.limpiar();
});

test('tachado de tokens', () => {
  assert.equal(tacharTokens('Bearer abcdefghijklmnopqrst'), 'Bearer [secreto]');
  assert.equal(tacharTokens('logged in as ghp_abcdefghijklmnopqrstuvwxyz12'), 'logged in as [secreto]');
  assert.equal(tacharTokens('ok, cuenta ana'), 'ok, cuenta ana');
});
