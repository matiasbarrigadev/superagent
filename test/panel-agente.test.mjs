// El Propietario le pide al agente lo mismo que haría en el panel (roles, conectores por rol, personas, rutinas):
// el agente usa la API del panel con sus permisos. Nadie más, y nunca lo de la cuenta de cada uno.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe } from './ayuda.mjs';

const llamada = (metodo, ruta, cuerpo) => ({ herramienta: 'panel', args: { metodo, ruta, ...(cuerpo ? { cuerpo } : {}) } });
const texto = (c, i = 0) => c.resultados[i].r.content[0].text;

test('el Propietario habilita un conector para un rol y edita un rol por WhatsApp', async () => {
  let idRol = null;
  const t = armar({
    guion: (spec) => {
      const habilitar = { roles: ['Propietario', 'Colaborador'] };
      if (spec.prompt.includes('habilitá agenda')) return [llamada('GET', '/api/conectores'), llamada('PATCH', '/api/conectores/1', habilitar), { herramienta: 'panel', args: { metodo: 'PATCH', ruta: '/api/conectores/1', cuerpo: habilitar, confirmado: true } }];
      if (spec.prompt.includes('sí, habilitalo')) return [{ herramienta: 'panel', args: { metodo: 'PATCH', ruta: '/api/conectores/1', cuerpo: habilitar, confirmado: true } }];
      if (spec.prompt.includes('cambiá la descripción')) return [llamada('PATCH', `/api/roles/${idRol}`, { descripcion: 'Equipo que opera el día a día.' })];
      if (spec.prompt.includes('confirmo la descripción')) return [{ herramienta: 'panel', args: { metodo: 'PATCH', ruta: `/api/roles/${idRol}`, cuerpo: { descripcion: 'Equipo que opera el día a día.' }, confirmado: true } }];
      if (spec.prompt.includes('mi contraseña')) return [llamada('POST', '/api/auth/login', { email: 'x', contrasena: 'y' }), llamada('POST', '/api/chat', { texto: 'hola' })];
      return [];
    },
  });
  t.db.prepare("INSERT INTO conexiones (id, app, estado, permisos, habilitada_para) VALUES (1, 'Agenda', 'activa', ?, ?)")
    .run(JSON.stringify([{ nombre: 'ver', escribe: false }, { nombre: 'crear_evento', escribe: true }]), JSON.stringify({ roles: ['Propietario'] }));
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });

  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'habilitá agenda para los colaboradores' });
  await t.avanzar(46_000);
  let c = t.corridas.at(-1);
  assert.ok(c.spec.completo && c.spec.herramientasGateway.includes('panel'));
  assert.match(texto(c, 0), /^HTTP 200[\s\S]*Agenda/);
  // Primero la ficha: qué puede de verdad, qué pide aprobación y qué es solo instrucción. No se aplica.
  assert.match(texto(c, 1), /^Todavía no se aplicó[\s\S]*Colaborador: Agenda: lee directo \(ver\); cada uso de lo que escribe[\s\S]*pide aprobación[\s\S]*no un límite del sistema/);
  assert.match(texto(c, 2), /todavía no vio la ficha/, 'no se confirma en la misma corrida');
  assert.deepEqual(JSON.parse(t.db.prepare('SELECT habilitada_para FROM conexiones WHERE id = 1').get().habilitada_para).roles, ['Propietario']);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'sí, habilitalo' });
  await t.avanzar(46_000);
  assert.match(texto(t.corridas.at(-1), 0), /^HTTP 200/);
  assert.deepEqual(JSON.parse(t.db.prepare('SELECT habilitada_para FROM conexiones WHERE id = 1').get().habilitada_para).roles, ['Propietario', 'Colaborador']);
  assert.ok(t.db.prepare("SELECT 1 FROM auditoria WHERE accion = 'panel.agente'").get(), 'queda auditado');

  idRol = t.db.prepare("SELECT id FROM roles WHERE nombre = 'Colaborador'").get().id;
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'cambiá la descripción del rol colaborador' });
  await t.avanzar(46_000);
  assert.match(texto(t.corridas.at(-1), 0), /Antes:[\s\S]*Después:[\s\S]*Equipo que opera/);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'confirmo la descripción' });
  await t.avanzar(46_000);
  assert.equal(t.db.prepare('SELECT descripcion FROM roles WHERE id = ?').get(idRol).descripcion, 'Equipo que opera el día a día.');

  // Lo de la cuenta de cada uno y el chat del panel, no.
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'cambiá mi contraseña' });
  await t.avanzar(46_000);
  c = t.corridas.at(-1);
  for (const r of c.resultados) assert.match(r.r.content[0].text, /lo hace el Propietario directo en el panel/);
  t.limpiar();
});

test('un Colaborador no tiene la herramienta panel, y aunque la llame no hace nada', async () => {
  const t = armar({ guion: () => [llamada('PATCH', '/api/conectores/1', { roles: ['Colaborador'] })] });
  t.db.prepare("INSERT INTO conexiones (id, app, estado, permisos, habilitada_para) VALUES (1, 'Agenda', 'activa', '[]', ?)").run(JSON.stringify({ roles: ['Propietario'] }));
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'habilitame agenda' });
  await t.avanzar(46_000);
  const c = t.corridas.at(-1);
  assert.ok(!c.spec.herramientasGateway.includes('panel'));
  assert.deepEqual(JSON.parse(t.db.prepare('SELECT habilitada_para FROM conexiones WHERE id = 1').get().habilitada_para).roles, ['Propietario']);
  t.limpiar();
});

test('proponer un rol con el Propietario: primero la ficha, se crea recién cuando confirma en otro mensaje', async () => {
  const t = armar({
    guion: (spec) => {
      if (spec.prompt.includes('armá un rol')) return [
        { herramienta: 'proponer_rol', args: { nombre: 'Ventas', descripcion: 'solo cantidades, sin montos', permisos: { conversar: true, herramientas_negocio: 'lectura' } } },
        { herramienta: 'decidir', args: { id: 'P-1', si: true } },
      ];
      if (spec.prompt.includes('sí, crealo')) return [{ herramienta: 'decidir', args: { id: 'P-1', si: true } }];
      return [];
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'armá un rol de ventas' });
  await t.avanzar(46_000);
  const c = t.corridas.at(-1);
  assert.match(texto(c, 0), /todavía no existe[\s\S]*Herramientas del negocio: solo leer[\s\S]*no un límite del sistema/);
  assert.match(texto(c, 1), /mostrale la ficha al Propietario/);
  assert.ok(!t.db.prepare("SELECT 1 FROM roles WHERE nombre = 'Ventas'").get());
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'sí, crealo' });
  await t.avanzar(46_000);
  assert.ok(t.db.prepare("SELECT 1 FROM roles WHERE nombre = 'Ventas'").get());
  t.limpiar();
});
