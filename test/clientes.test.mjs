// Etapa 6c: clientes y proyectos en el núcleo (rol por cliente, autonomía y memoria por cliente/proyecto).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, idRol, escribe } from './ayuda.mjs';

function cliente(db, nombre, autonomia = 'consultar_lo_importante') {
  return Number(db.prepare("INSERT INTO clientes (nombre, tipo, autonomia) VALUES (?, 'cliente', ?)").run(nombre, autonomia).lastInsertRowid);
}
function grupo(db, id, clienteId, proyectoId = null) {
  db.prepare("INSERT INTO chats (id, tipo, cliente_id, proyecto_id, activo, nombre, creado) VALUES (?, 'grupo', ?, ?, 1, ?, 0)").run(id, clienteId, proyectoId, id);
}

test('la misma persona, Colaborador en el cliente A y Tercero en el B, recibe herramientas distintas según el chat', async () => {
  const t = armar({ guion: () => [] });
  const a = cliente(t.db, 'Cliente A'), b = cliente(t.db, 'Cliente B');
  const p = persona(t.db, { nombre: 'Lu', telefono: '5491130000000', rol: 'Tercero' });
  t.db.prepare('INSERT INTO persona_cliente (persona_id, cliente_id, rol_id) VALUES (?, ?, ?), (?, ?, ?)').run(p, a, idRol(t.db, 'Colaborador'), p, b, idRol(t.db, 'Tercero'));
  grupo(t.db, '120363000000000a@g.us', a);
  grupo(t.db, '120363000000000b@g.us', b);
  await escribe(t.nucleo, { telefono: '5491130000000', texto: 'mirá esto', grupo: '120363000000000a@g.us', mencion: true });
  await escribe(t.nucleo, { telefono: '5491130000000', texto: 'mirá esto', grupo: '120363000000000b@g.us', mencion: true });
  await t.avanzar(46_000);
  const porChat = Object.fromEntries(t.corridas.map((c) => [c.spec.chatId, c.spec]));
  assert.equal(porChat['120363000000000a@g.us'].rol.nombre, 'Colaborador');
  assert.ok(porChat['120363000000000a@g.us'].herramientasClaude.includes('Read'));
  assert.equal(porChat['120363000000000b@g.us'].variante, 'tercero');
  assert.deepEqual(porChat['120363000000000b@g.us'].herramientasClaude, []);
  t.limpiar();
});

test('con autonomía "consultar todo", una acción directa del Propietario sobre ese cliente pasa a consulta', async () => {
  const t = armar({
    guion: (spec) => [{ herramienta: 'programar_rutina', args: { cuando: '0 9 * * 1', instruccion: 'resumen semanal' } }, { herramienta: 'iniciar_conversacion', args: { destino: '5491130000001', texto: 'hola' } }],
  });
  const c = cliente(t.db, 'Cliente estricto', 'consultar_todo');
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  grupo(t.db, '120363000000000c@g.us', c);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'programá el resumen', grupo: '120363000000000c@g.us', mencion: true });
  await t.avanzar(46_000);
  const textos = t.corridas[0].resultados.map((r) => r.r.content[0].text);
  assert.match(textos[0], /pendiente de aprobación A-1/);
  assert.match(textos[1], /Pendiente de aprobación A-2/);
  assert.equal(t.db.prepare('SELECT activa FROM rutinas').get().activa, 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM salida WHERE chat_id = '5491130000001@c.us'").get().n, 0);
  t.limpiar();
});

test('una instalación sin clientes extra se comporta igual que antes (vía libre en el cliente propio)', async () => {
  const t = armar({ guion: () => [{ herramienta: 'programar_rutina', args: { cuando: '0 9 * * 1', instruccion: 'resumen semanal' } }] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'programá el resumen' });
  await t.avanzar(46_000);
  assert.match(t.corridas[0].resultados[0].r.content[0].text, /programada/);
  assert.equal(t.db.prepare('SELECT activa FROM rutinas').get().activa, 1);
  assert.equal(t.db.prepare("SELECT autonomia FROM clientes WHERE tipo = 'propio'").get().autonomia, 'via_libre');
  t.limpiar();
});

test('cada corrida carga la memoria de su cliente y proyecto; a un Tercero solo le llega lo público', async () => {
  const t = armar({ guion: () => [] });
  const a = cliente(t.db, 'Cliente A'), b = cliente(t.db, 'Cliente B');
  const pr = Number(t.db.prepare('INSERT INTO proyectos (cliente_id, nombre) VALUES (?, ?)').run(a, 'Sitio').lastInsertRowid);
  const m = t.nucleo.memoria;
  m.guardar({ alcance: 'cuenta', seccion: 'Contexto', contenido: 'Somos una agencia', publica: true });
  m.guardar({ alcance: 'cuenta', seccion: 'Decisiones', contenido: 'Margen interno 40%' });
  m.guardar({ alcance: 'cliente', alcanceId: a, seccion: 'Comportamiento', contenido: 'A prefiere audios', publica: true });
  m.guardar({ alcance: 'cliente', alcanceId: a, seccion: 'Decisiones', contenido: 'A debe dos facturas' });
  m.guardar({ alcance: 'cliente', alcanceId: b, seccion: 'Contexto', contenido: 'B es una ferretería', publica: true });
  m.guardar({ alcance: 'proyecto', alcanceId: pr, seccion: 'Alcance', contenido: 'El sitio usa Astro' });
  const colab = persona(t.db, { nombre: 'Colab', telefono: '5491130000010', rol: 'Colaborador' });
  grupo(t.db, '120363000000000a@g.us', a, pr);
  await escribe(t.nucleo, { telefono: '5491130000010', texto: 'hola', grupo: '120363000000000a@g.us', mencion: true });
  await escribe(t.nucleo, { telefono: '5491130000099', texto: 'hola', grupo: '120363000000000a@g.us', mencion: true });
  await t.avanzar(46_000);
  await t.avanzar(1000);
  const deColab = t.corridas.find((c) => c.spec.personaId === colab).spec.prompt;
  const deTercero = t.corridas.find((c) => c.spec.personaId !== colab).spec.prompt;
  for (const x of ['Somos una agencia', 'Margen interno 40%', 'A prefiere audios', 'A debe dos facturas', 'El sitio usa Astro']) assert.ok(deColab.includes(x), x);
  assert.ok(!deColab.includes('ferretería'), 'no carga la memoria de otro cliente');
  assert.ok(deTercero.includes('Somos una agencia') && deTercero.includes('A prefiere audios'));
  for (const x of ['Margen interno', 'A debe dos facturas', 'El sitio usa Astro', 'ferretería']) assert.ok(!deTercero.includes(x), x);
  t.limpiar();
});
