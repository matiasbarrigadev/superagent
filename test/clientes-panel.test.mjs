// Etapa 7e: clientes en el panel y alta propuesta por el agente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe, entrarComoPropietario, idRol } from './ayuda.mjs';

const G = '120363000000000099@g.us';

test('el agente propone un cliente para un grupo nuevo; hasta que se confirma nada cambia; después el grupo usa su memoria y autonomía', async () => {
  const t = armar({ guion: (spec) => (spec.prompt.includes('somos de Ferretería') ? [{ herramienta: 'proponer_cliente', args: { nombre: 'Ferretería Sur', autonomia: 'consultar_todo' } }] : []) });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  t.db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, nombre, creado) VALUES (?, 'grupo', 1, 1, 'Ferre', 0)").run(G);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'hola, somos de Ferretería Sur', grupo: G, mencion: true });
  await t.avanzar(46_000);
  assert.equal(t.db.prepare('SELECT cliente_id FROM chats WHERE id = ?').get(G).cliente_id, 1, 'sin confirmar, sigue en el cliente propio');
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM clientes WHERE tipo = 'cliente'").get().n, 0);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'confirmo P-1' });
  await t.avanzar(0);
  const cl = t.db.prepare("SELECT * FROM clientes WHERE nombre = 'Ferretería Sur'").get();
  assert.equal(cl.autonomia, 'consultar_todo');
  assert.equal(t.db.prepare('SELECT cliente_id FROM chats WHERE id = ?').get(G).cliente_id, cl.id);
  t.nucleo.memoria.guardar({ alcance: 'cliente', alcanceId: cl.id, seccion: 'Comportamiento', contenido: 'Les gusta que les manden fotos' });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: '¿qué sabés de nosotros?', grupo: G, mencion: true });
  await t.avanzar(46_000);
  const c = t.corridas.at(-1);
  assert.match(c.spec.prompt, /Cliente del chat: Ferretería Sur \(autonomía: consultar todo\)/);
  assert.match(c.spec.prompt, /Les gusta que les manden fotos/);
  assert.equal(c.spec.decidir('programar_rutina').decision, 'con_aprobacion', 'la autonomía del cliente se aplica');
  t.limpiar();
});

test('panel: crear cliente, asignarle un grupo y un rol por cliente', async () => {
  const t = armar();
  await entrarComoPropietario(t);
  t.db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, nombre, creado) VALUES (?, 'grupo', 1, 0, 'Obra', 0)").run(G);
  const juan = persona(t.db, { nombre: 'Juan', telefono: '5491140000000', rol: 'Tercero' });
  const { json: { id } } = await t.pedir('POST', '/api/clientes', { nombre: 'Constructora', autonomia: 'via_libre' });
  assert.equal((await t.pedir('PATCH', `/api/chats/${encodeURIComponent(G)}`, { cliente_id: id })).status, 200);
  assert.equal((await t.pedir('POST', `/api/clientes/${id}/roles`, { personaId: juan, rolId: idRol(t.db, 'Colaborador') })).status, 200);
  const cl = (await t.pedir('GET', '/api/clientes')).json.clientes.find((x) => x.id === id);
  assert.deepEqual(cl.chats.map((x) => x.id), [G]);
  assert.equal(cl.roles[0].rol, 'Colaborador');
  assert.equal(t.nucleo.politica.rolDe(juan, id).nombre, 'Colaborador');
  assert.equal(t.nucleo.politica.rolDe(juan, 1).nombre, 'Tercero');
  assert.equal((await t.pedir('PATCH', `/api/clientes/${id}`, { autonomia: 'consultar_todo' })).status, 200);
  assert.equal(t.db.prepare('SELECT autonomia FROM clientes WHERE id = ?').get(id).autonomia, 'consultar_todo');
  t.limpiar();
});
