// WhatsApp como una persona: marca leído, "escribiendo…" corto (sin refrescarlo durante minutos) y, antes de cada
// texto, un rato acorde al largo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe } from './ayuda.mjs';
import { tiempoDeEscritura } from '../src/wa/salida.mjs';

test('tiempo de escritura: entre 1 y 4 s (más o menos un 20 %), según el largo', () => {
  assert.equal(tiempoDeEscritura('hola', () => 0.5), 1000);
  assert.equal(tiempoDeEscritura('x'.repeat(5000), () => 0.5), 4000);
  assert.ok(tiempoDeEscritura('x'.repeat(50), () => 0) < tiempoDeEscritura('x'.repeat(50), () => 1));
});

test('al responder: visto, "escribiendo…" una vez y otra justo antes del texto; nunca un refresco cada 20 s', async () => {
  const llamadas = [];
  const t = armar({
    waha: {
      visto: async (c) => { llamadas.push(`visto ${c}`); },
      escribiendo: async (c, on) => { llamadas.push(`escribiendo ${on}`); },
    },
    guion: async (spec, ctx, llamar) => {
      await new Promise((r) => setTimeout(r, 50)); // el agente tarda: no hay refresco del "escribiendo…"
      await llamar('responder', { texto: 'listo, ya está' });
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'hola' });
  await t.avanzar(46_000);
  await t.avanzar(5_000);
  assert.deepEqual(llamadas.slice(0, 2), ['visto 5491111111111@c.us', 'escribiendo true']);
  assert.equal(llamadas.filter((l) => l === 'escribiendo true').length, 2, llamadas.join(' | '));
  assert.ok(t.waha.enviados.some((e) => e.texto === 'listo, ya está'));
  t.limpiar();
});
