// Lo que el agente hace con y para los Propietarios: los avala sin código, une fichas duplicadas, avisa con sus
// palabras (consultas, conectores caídos, rutinas que fallan, decisiones de otro Propietario) y no se queda con
// herramientas viejas en la cabeza.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe, idRol } from './ayuda.mjs';

const eventos = (t, chat) => t.db.prepare("SELECT cuerpo FROM mensajes WHERE chat_id = ? AND tipo = 'evento' ORDER BY seq").all(chat).map((m) => m.cuerpo);
const DUENA = '5491111111111@c.us', OTRO = '5491133333333@c.us';

test('un Propietario verificado suma otro Propietario: queda verificado sin código; uno sin verificar, no', () => {
  const t = armar();
  const duena = persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  const rolP = idRol(t.db, 'Propietario');
  const permisos = t.nucleo.politica.rolDe(duena, 1).permisos;
  const socio = t.nucleo.roles.altaPersona({ personaId: duena, permisos }, { nombre: 'Socio', telefono: '5491133333333', rolId: rolP });
  assert.equal(t.db.prepare('SELECT verificada FROM personas WHERE id = ?').get(socio).verificada, 1);
  const colab = t.nucleo.roles.altaPersona({ personaId: duena, permisos }, { nombre: 'Colab', telefono: '5491122222222', rolId: idRol(t.db, 'Colaborador') });
  assert.equal(t.db.prepare('SELECT verificada FROM personas WHERE id = ?').get(colab).verificada, 0, 'solo Propietarios');
  const sinVer = persona(t.db, { nombre: 'Otra', telefono: '5491144444444', rol: 'Propietario' });
  const tercera = t.nucleo.roles.altaPersona({ personaId: sinVer, permisos }, { nombre: 'Tercera', telefono: '5491155555555', rolId: rolP });
  assert.equal(t.db.prepare('SELECT verificada FROM personas WHERE id = ?').get(tercera).verificada, 0);
  t.limpiar();
});

test('fichas duplicadas: se detectan y al unirlas queda una con todo', () => {
  const t = armar();
  const duena = persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  const conNum = persona(t.db, { nombre: 'Socio Uno', telefono: '5491133333333', rol: 'Propietario' });
  const sinNum = Number(t.db.prepare("INSERT INTO personas (nombre, telefono, lid, rol_id, alta_manual, activa, creada) VALUES ('Socio Uno', NULL, '999@lid', ?, 1, 1, 0)").run(idRol(t.db, 'Propietario')).lastInsertRowid);
  t.db.prepare("INSERT INTO memoria (alcance, alcance_id, seccion, contenido) VALUES ('contacto', ?, 'Contexto', 'prefiere audios')").run(sinNum);
  const d = t.nucleo.roles.duplicados();
  assert.deepEqual(d.map((x) => [x.queda.id, x.quita.id]), [[conNum, sinNum]]);
  t.nucleo.roles.fusionarPersonas({ personaId: duena, permisos: t.nucleo.politica.rolDe(duena, 1).permisos }, conNum, sinNum);
  assert.equal(t.db.prepare("SELECT alcance_id FROM memoria WHERE contenido = 'prefiere audios'").get().alcance_id, conNum);
  assert.equal(t.db.prepare('SELECT activa FROM personas WHERE id = ?').get(sinNum).activa, 0);
  assert.equal(t.db.prepare('SELECT lid FROM personas WHERE id = ?').get(conNum).lid, '999@lid');
  assert.equal(t.db.prepare("SELECT telefono FROM lids WHERE lid = '999@lid'").get().telefono, '5491133333333');
  assert.equal(t.nucleo.roles.duplicados().length, 0);
  t.limpiar();
});

test('rutina de un rol sin el conector: el pedido lo advierte, se aprueba "como Propietario" y corre con él', async () => {
  const t = armar({
    guion: (spec) => {
      if (spec.prompt.includes('programá')) return [{ herramienta: 'programar_rutina', args: { cuando: '0 9 * * *', instruccion: 'mandar el reporte' } }];
      if (spec.prompt.includes('dale, que corra con mis permisos')) return [{ herramienta: 'decidir', args: { id: 'A-1', si: true, como_propietario: true } }];
      return [];
    },
  });
  t.db.prepare("INSERT INTO conexiones (id, app, estado, permisos, habilitada_para) VALUES (1, 'Base', 'activa', '[]', ?)").run(JSON.stringify({ roles: ['Propietario'] }));
  const duena = persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  const colab = persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'programá el reporte diario' });
  await t.avanzar(46_000);
  await t.avanzar(5_000);
  assert.match(eventos(t, DUENA)[0], /\[pedido A-1\][\s\S]*el rol Colaborador no tiene Base/);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'dale, que corra con mis permisos' });
  await t.avanzar(46_000);
  const r = t.db.prepare('SELECT * FROM rutinas').get();
  assert.equal(r.activa, 1);
  assert.equal(r.ejecuta_como, duena);
  t.nucleo.programador.tick(r.proxima);
  await t.avanzar(5_000);
  const corrida = t.corridas.find((c) => c.spec.prompt.includes('[rutina R-1]'));
  assert.equal(corrida.ctx.personaId, duena);
  assert.match(corrida.spec.prompt, /corre con permisos del Propietario[\s\S]*la pidió Colab/);
  assert.notEqual(colab, duena);
  t.limpiar();
});

test('una rutina que falla se la cuenta el agente a los Propietarios', async () => {
  const t = armar({ guion: (spec) => (spec.prompt.includes('[rutina R-1]') ? { falla: 'otro', error: 'se cayó algo' } : []) });
  const duena = persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  t.db.prepare("INSERT INTO rutinas (cuando, zona_horaria, instruccion, creada_por, chat_destino, activa, aprobada, proxima, destinos, creada) VALUES ('0 9 * * *', 'UTC', 'reporte', ?, '5491122222222@c.us', 1, 1, 1, '[]', 0)").run(duena);
  t.nucleo.programador.tick(t.tiempo.t);
  await t.avanzar(5_000);
  await t.avanzar(5_000);
  assert.ok(eventos(t, DUENA).some((e) => /^\[rutina R-1 falló\][\s\S]*se cayó algo/.test(e)));
  t.limpiar();
});

test('consultas, conector caído y decisión de otro Propietario llegan como charla, no como aviso con formato', async () => {
  const t = armar({
    guion: (spec) => {
      if (spec.prompt.includes('necesito algo raro')) return [{ herramienta: 'preguntar_al_propietario', args: { pregunta: '¿Le puedo dar el teléfono del proveedor?' } }];
      if (spec.prompt.includes('programá')) return [{ herramienta: 'programar_rutina', args: { cuando: '0 9 * * *', instruccion: 'x' } }];
      if (spec.prompt.includes('sí, aprobalo')) return [{ herramienta: 'decidir', args: { id: 'A-1', si: true } }];
      return [];
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Socio', telefono: '5491133333333', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'necesito algo raro' });
  await t.avanzar(46_000);
  assert.ok(eventos(t, DUENA).some((e) => /^\[consulta de Colab/.test(e)));
  assert.ok(!t.waha.enviados.some((e) => /^Consulta de/.test(e.texto)), 'sin el aviso con formato de sistema');

  // Otro Propietario aprueba: al resto se le avisa que ya está.
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'programá algo' });
  await t.avanzar(46_000);
  await escribe(t.nucleo, { telefono: '5491133333333', texto: 'sí, aprobalo' });
  await t.avanzar(46_000);
  assert.equal(t.db.prepare('SELECT estado FROM aprobaciones').get().estado, 'aprobada');
  assert.ok(eventos(t, DUENA).some((e) => /^\[A-1 aprobada por Socio\]/.test(e)));
  assert.ok(!eventos(t, OTRO).some((e) => /^\[A-1 aprobada/.test(e)), 'a quien decidió no');

  // Conector que pierde la autorización: avisa una sola vez.
  t.db.prepare("INSERT INTO conexiones (id, app, estado, permisos, habilitada_para) VALUES (7, 'Agenda', 'activa', '[]', '{}')").run();
  await assert.rejects(t.nucleo.conectores.llamar(7, 'x', {}));
  await assert.rejects(t.nucleo.conectores.llamar(7, 'x', {}));
  assert.equal(eventos(t, DUENA).filter((e) => e.startsWith('[conector Agenda sin autorización]')).length, 1);
  t.limpiar();
});

test('si cambian sus herramientas a mitad de una charla, el agente se entera', async () => {
  const t = armar();
  t.db.prepare("INSERT INTO conexiones (id, app, estado, permisos, habilitada_para) VALUES (1, 'Agenda', 'activa', ?, ?)")
    .run(JSON.stringify([{ nombre: 'ver', descripcion: 'ver', esquema: { type: 'object' }, escribe: false }]), JSON.stringify({ roles: ['Propietario'] }));
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await t.avanzar(46_000);
  assert.ok(!t.corridas.at(-1).spec.prompt.includes('Tus herramientas cambiaron'));
  t.nucleo.conectores.configurar(1, { roles: ['Propietario', 'Colaborador'] });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: '¿ahora podés ver la agenda?' });
  await t.avanzar(46_000);
  assert.match(t.corridas.at(-1).spec.prompt, /^\(gateway\) Tus herramientas cambiaron[^\n]*Ahora tenés: agenda__ver/);
  t.limpiar();
});
