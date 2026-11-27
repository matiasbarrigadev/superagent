// Rutinas que ya existen: el Propietario las edita (con confirmación para que corran con sus permisos), el otro
// Propietario ve el cambio, un "sí" no aprueba pedidos que llegaron después, y un conector de solo lectura no pide
// aprobación por cada consulta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe, entrarComoPropietario } from './ayuda.mjs';
import { fichaConector } from '../src/roles/ficha.mjs';

const textos = (c) => JSON.stringify(c.resultados);

test('rutinas: el Propietario la hace correr con sus permisos (confirmando en otro mensaje), la manda a otro chat y el otro Propietario lo ve', async () => {
  const t = armar({
    guion: (spec) => {
      if (spec.prompt.includes('ZXCOMO')) return [{ herramienta: 'rutinas', args: { accion: 'cambiar', id: 'R-1', corre_como: 'propietario' } }];
      if (spec.prompt.includes('ZXCONFIRMO')) return [{ herramienta: 'rutinas', args: { accion: 'cambiar', id: 'R-1', corre_como: 'propietario', confirmado: true } }];
      if (spec.prompt.includes('ZXHORA')) return [{ herramienta: 'rutinas', args: { accion: 'cambiar', id: 'R-1', cuando: '30 8 * * 1-5', destino: '5491122222222' } }];
      if (spec.prompt.includes('ZXPANEL')) return [{ herramienta: 'panel', args: { metodo: 'PATCH', ruta: '/api/rutinas/1', cuerpo: { activa: false } } }];
      return [];
    },
  });
  const duena = persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Socio', telefono: '5491133333333', rol: 'Propietario', verificada: 1 });
  const colab = persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  t.db.prepare("INSERT INTO rutinas (cuando, zona_horaria, instruccion, creada_por, chat_destino, activa, aprobada, proxima, destinos, creada) VALUES ('0 9 * * *', 'UTC', 'reporte de ventas, solo cantidades', ?, '5491111111111@c.us', 1, 1, ?, '[\"5491111111111@c.us\"]', 0)").run(colab, t.tiempo.t + 3_600_000);

  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'ZXCOMO' });
  await t.avanzar(46_000);
  assert.match(t.corridas.at(-1).spec.prompt, /Rutinas \(se cambian con la herramienta rutinas\):[\s\S]*R-1 \[activa\][\s\S]*la pidió Colab; corre con los permisos de quien la pidió/);
  assert.match(textos(t.corridas.at(-1)), /Todavía no se cambió nada/);
  assert.equal(t.db.prepare('SELECT ejecuta_como FROM rutinas').get().ejecuta_como, null);

  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'ZXCONFIRMO' });
  await t.avanzar(46_000);
  assert.match(textos(t.corridas.at(-1)), /corre con los permisos de Dueña/);
  assert.equal(t.db.prepare('SELECT ejecuta_como FROM rutinas').get().ejecuta_como, duena);

  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'ZXHORA' });
  await t.avanzar(46_000);
  const r = t.db.prepare('SELECT * FROM rutinas').get();
  assert.equal(r.cuando, '30 8 * * 1-5');
  assert.equal(r.chat_destino, '5491122222222@c.us');
  assert.ok(JSON.parse(r.destinos).includes('5491122222222@c.us'));
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM rutinas').get().n, 1, 'se edita la que existe, no se copia');

  // Por la API del panel, no: tiene que ser con la herramienta (que confirma lo delicado).
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'ZXPANEL' });
  await t.avanzar(46_000);
  assert.match(textos(t.corridas.at(-1)), /la herramienta rutinas/);
  assert.equal(t.db.prepare('SELECT activa FROM rutinas').get().activa, 1);

  // El otro Propietario ve lo que cambió la Dueña.
  await escribe(t.nucleo, { telefono: '5491133333333', texto: 'hola' });
  await t.avanzar(46_000);
  const ctxSocio = t.corridas.at(-1).spec.prompt;
  assert.match(ctxSocio, /Lo que hicieron otros Propietarios en las últimas 24 h[\s\S]*Dueña \(charla\): Rutina R-1: horario "30 8 \* \* 1-5"[\s\S]*Dueña \(charla\): Rutina R-1: corre con los permisos de Dueña/);
  t.limpiar();
});

test('decidir: un "sí" anterior al pedido no lo aprueba; hace falta un mensaje del Propietario después', async () => {
  const t = armar({
    guion: (spec) => {
      if (spec.prompt.includes('programá')) return [{ herramienta: 'programar_rutina', args: { cuando: '0 9 * * *', instruccion: 'x' } }];
      if (spec.prompt.includes('[pedido A-1]') || spec.prompt.includes('ZXSI')) return [{ herramienta: 'decidir', args: { id: 'A-1', si: true } }];
      return [];
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'buen día' });
  await t.avanzar(46_000);
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'programá el reporte' });
  await t.avanzar(46_000);
  await t.avanzar(5_000);
  const intento = t.corridas.find((c) => c.spec.prompt.includes('[pedido A-1]'));
  assert.ok(intento, 'el agente se despierta con el pedido');
  assert.match(textos(intento), /llegó después del último mensaje del Propietario/);
  assert.equal(t.db.prepare("SELECT estado FROM aprobaciones WHERE id = 'A-1'").get().estado, 'pendiente');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'ZXSI dale' });
  await t.avanzar(46_000);
  assert.equal(t.db.prepare("SELECT estado FROM aprobaciones WHERE id = 'A-1'").get().estado, 'aprobada');
  t.limpiar();
});

test('conector de solo lectura: por la URL (read_only=true) o marcado por el Propietario, nada cuenta como escritura', async () => {
  const t = armar();
  const herramientas = JSON.stringify([{ nombre: 'execute_sql', descripcion: 'corre SQL', esquema: { type: 'object' }, escribe: true }]);
  t.db.prepare("INSERT INTO conexiones (id, app, estado, permisos, habilitada_para, url_mcp) VALUES (1, 'Base', 'activa', ?, ?, 'https://mcp.ejemplo.com/mcp')").run(herramientas, JSON.stringify({ roles: ['Lector', 'Equipo'] }));
  const lector = { nombre: 'Lector', permisos: { herramientas_negocio: 'lectura' } };
  const equipo = { nombre: 'Equipo', permisos: { herramientas_negocio: 'lectura_escritura' } };
  const c = t.nucleo.conectores;
  assert.equal(c.paraCorrida({ personaId: 9, rol: lector }).length, 0, 'sin marca: execute_sql escribe y un rol que solo lee no la ve');
  assert.equal(c.paraCorrida({ personaId: 9, rol: equipo })[0].escribe, true);
  assert.match(fichaConector(t.db, 1, { roles: ['Equipo'], soloLectura: true }), /Pasa a solo lectura[\s\S]*Confirmalo solo si el servicio de verdad no deja escribir/);

  c.configurar(1, { solo_lectura: true });
  assert.equal(c.paraCorrida({ personaId: 9, rol: lector })[0].escribe, false);
  assert.equal(c.paraCorrida({ personaId: 9, rol: equipo })[0].escribe, false, 'no pide aprobación');
  assert.equal(c.listar()[0].solo_lectura, true);

  c.configurar(1, { solo_lectura: false });
  t.db.prepare("UPDATE conexiones SET url_mcp = 'https://mcp.ejemplo.com/mcp?project_ref=abc&read_only=true' WHERE id = 1").run();
  assert.equal(c.paraCorrida({ personaId: 9, rol: lector })[0].escribe, false, 'la URL le pide al servicio que solo lea');
  assert.match(fichaConector(t.db, 1, { roles: ['Lector'] }), /su URL se lo pide al servicio/);
  t.limpiar();
});

test('panel: editar una rutina y que corra con mis permisos; queda en la bitácora', async () => {
  const t = armar();
  await entrarComoPropietario(t);
  const colab = persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  t.db.prepare("INSERT INTO rutinas (cuando, zona_horaria, instruccion, creada_por, chat_destino, activa, aprobada, proxima, destinos, creada) VALUES ('0 9 * * *', 'UTC', 'reporte', ?, '5491122222222@c.us', 1, 1, 1, '[]', 0)").run(colab);
  const r = await t.pedir('PATCH', '/api/rutinas/1', { instruccion: 'reporte, solo cantidades', corre_como: 'propietario', activa: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const f = t.db.prepare('SELECT * FROM rutinas').get();
  assert.equal(f.instruccion, 'reporte, solo cantidades');
  assert.ok(f.ejecuta_como);
  assert.equal(f.activa, 0);
  assert.match(f.pausa_motivo, /desde el panel/);
  assert.equal((await t.pedir('PATCH', '/api/rutinas/1', { cuando: 'cualquier cosa' })).status, 400);
  const lista = (await t.pedir('GET', '/api/rutinas')).json.rutinas;
  assert.equal(lista[0].destino_nombre, 'Colab');
  assert.ok((await t.pedir('GET', '/api/bitacora')).json.entradas.some((e) => e.ref === 'R-1' && /pausada/.test(e.que) && e.donde === 'panel'));
  t.limpiar();
});
