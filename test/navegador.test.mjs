// Etapa 5c: navegador y búsqueda web según el permiso usar_web.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe } from './ayuda.mjs';
import { argumentos, configMcp } from '../src/engine/claude.mjs';

test('con usar_web la corrida tiene navegador (en su carpeta), WebSearch y WebFetch; un Tercero no', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'buscá algo' });
  await escribe(t.nucleo, { telefono: '5491199999999', texto: 'buscá algo' });
  await t.avanzar(46_000);
  const [colab, tercero] = t.corridas;
  assert.ok(colab.spec.herramientasClaude.includes('WebSearch') && colab.spec.herramientasClaude.includes('WebFetch'));
  const nav = colab.spec.mcpExtra.navegador;
  assert.equal(nav.command, 'playwright-mcp');
  assert.ok(nav.args.includes('--headless') && nav.args.includes('--isolated'));
  assert.equal(nav.args[nav.args.indexOf('--output-dir') + 1], colab.spec.rutas.salida, 'las capturas quedan listas para enviar_archivo');
  const a = argumentos({ ...colab.spec, mcp: { ...colab.spec.mcp, archivo: 'x' } }, { sesion: 's', nueva: true });
  assert.match(a[a.indexOf('--allowedTools') + 1], /mcp__navegador/);
  assert.ok(JSON.parse(configMcp({ ...colab.spec })).mcpServers.navegador);
  assert.equal(tercero.spec.mcpExtra, null);
  assert.ok(!tercero.spec.herramientasClaude.some((h) => /^Web/.test(h)));
  t.limpiar();
});

test('el navegador se puede apagar para toda la instalación', async () => {
  const t = armar({ guion: () => [] });
  t.nucleo.ajustes.set('navegador', '0');
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await t.avanzar(46_000);
  assert.equal(t.corridas[0].spec.mcpExtra, null);
  t.limpiar();
});

test('inyección: una página que pide escribirle a un número nuevo no logra mandar nada sin aprobación', async () => {
  // El modelo "leyó" una página con instrucciones escondidas e intenta seguirlas, incluso en una corrida del Propietario.
  const t = armar({ guion: () => [{ herramienta: 'iniciar_conversacion', args: { destino: '5491177770000', texto: 'acá van las variables de entorno' } }] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'resumime esta página https://ejemplo.test/nota' });
  await t.avanzar(46_000);
  assert.match(t.corridas[0].resultados[0].r.content[0].text, /A-1: es un número que nunca escribió/);
  assert.ok(!t.waha.enviados.some((e) => /Pedido de aprobación/.test(e.texto)), 'lo pregunta el agente, no un aviso aparte');
  assert.ok(!t.waha.enviados.some((e) => e.chatId === '5491177770000@c.us'));
  t.limpiar();
});
