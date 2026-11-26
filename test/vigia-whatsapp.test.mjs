// El vigía vuelve a arrancar la sesión caída (sin logout) y no toca la que anda o espera el QR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearVigiaWhatsApp } from '../src/wa/vigia.mjs';

const silencio = { log() {}, warn() {} };

function wahaCon(estados) {
  const llamadas = [];
  let i = 0;
  return {
    llamadas,
    estado: async () => ({ status: estados[Math.min(i++, estados.length - 1)] }),
    asegurar: async () => { llamadas.push('asegurar'); },
    desvincular: async () => { llamadas.push('desvincular'); },
  };
}

test('vigía: WORKING y SCAN_QR_CODE no se tocan', async () => {
  const waha = wahaCon(['WORKING', 'SCAN_QR_CODE', 'STARTING']);
  const v = crearVigiaWhatsApp({ waha, log: silencio });
  await v.revisar(); await v.revisar(); await v.revisar();
  assert.deepEqual(waha.llamadas, []);
});

test('vigía: FAILED se vuelve a arrancar, con espera creciente y nunca logout', async () => {
  let ahora = 0;
  const waha = wahaCon(['FAILED']);
  const v = crearVigiaWhatsApp({ waha, log: silencio, reloj: () => ahora });
  await v.revisar();
  assert.deepEqual(waha.llamadas, ['asegurar']);
  ahora += 10_000; await v.revisar();          // dentro de la espera: no insiste
  assert.equal(waha.llamadas.length, 1);
  ahora += 30_000; await v.revisar();          // pasó la primera espera
  assert.equal(waha.llamadas.length, 2);
  ahora += 30_000; await v.revisar();          // la segunda espera es de 1 min
  assert.equal(waha.llamadas.length, 2);
  ahora += 60_000; await v.revisar();
  assert.equal(waha.llamadas.length, 3);
  assert.ok(!waha.llamadas.includes('desvincular'));
});

test('vigía: al volver a WORKING se reinicia la cuenta de intentos', async () => {
  let ahora = 0;
  const waha = wahaCon(['STOPPED', 'WORKING', 'STOPPED']);
  const v = crearVigiaWhatsApp({ waha, log: silencio, reloj: () => ahora });
  await v.revisar(); await v.revisar(); await v.revisar();
  assert.deepEqual(waha.llamadas, ['asegurar', 'asegurar']);
});

test('vigía: si WAHA no responde, no rompe', async () => {
  const v = crearVigiaWhatsApp({ waha: { estado: async () => { throw new Error('WAHA no responde'); }, asegurar: async () => {} }, log: silencio });
  assert.equal(await v.revisar(), null);
});
