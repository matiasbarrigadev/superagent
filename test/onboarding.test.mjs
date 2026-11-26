// Etapa 7: conversación de onboarding en el panel y propuestas de roles y personas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, entrarComoPropietario, persona, escribe } from './ayuda.mjs';

test('el chat del panel usa el mismo motor con las instrucciones de onboarding', async () => {
  const t = armar({ guion: () => [{ herramienta: 'responder', args: { texto: '¡Hola! ¿Para qué vas a usar este agente?' } }] });
  await entrarComoPropietario(t);
  assert.equal((await t.pedir('POST', '/api/chat', { texto: 'hola' })).status, 200);
  await t.avanzar(1000);
  const c = t.corridas[0];
  assert.equal(c.spec.variante, 'onboarding');
  assert.equal(c.spec.canal, 'panel');
  assert.match(c.spec.sistema, /# Quién sos[\s\S]*# Configuración inicial/, 'onboarding va encima de las instrucciones base');
  for (const h of ['proponer_rol', 'proponer_persona', 'terminar_onboarding']) assert.ok(c.spec.herramientasGateway.includes(h), h);
  const chat = (await t.pedir('GET', '/api/chat')).json;
  assert.deepEqual(chat.mensajes.map((m) => [m.from_me, m.cuerpo]), [[0, 'hola'], [1, '¡Hola! ¿Para qué vas a usar este agente?']]);
  assert.equal(t.waha.enviados.length, 0, 'el panel no pasa por WhatsApp');
  t.limpiar();
});

test('una propuesta sin confirmar no cambia ningún permiso; confirmada, crea el rol y la persona', async () => {
  const t = armar({
    guion: () => [
      { herramienta: 'proponer_rol', args: { nombre: 'Productor', descripcion: 'Arma eventos', permisos: { conversar: true, usar_web: true, herramientas_negocio: 'lectura_escritura' } } },
      { herramienta: 'proponer_persona', args: { nombre: 'Juan', telefono: '5491140000000', rol: 'Productor' } },
      { herramienta: 'terminar_onboarding', args: { nombre_agente: 'Nina', zona_horaria: 'America/Argentina/Buenos_Aires' } },
    ],
  });
  await entrarComoPropietario(t);
  t.nucleo.ajustes.set('propietario_completo', '0'); // prueba el flujo de propuestas y aprobaciones (otros roles)
  await t.pedir('POST', '/api/chat', { texto: 'somos una productora' });
  await t.avanzar(1000);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM roles WHERE nombre = 'Productor'").get().n, 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM personas WHERE telefono = '5491140000000'").get().n, 0);
  const props = (await t.pedir('GET', '/api/propuestas?estado=pendiente')).json.propuestas;
  assert.equal(props.length, 2);
  const rol = props.find((p) => p.tipo === 'rol');
  assert.equal(rol.permisos.find((x) => x.permiso === 'usar_web').texto, 'sí', 'la tarjeta trae los permisos en palabras');
  const per = props.find((p) => p.tipo === 'persona');
  assert.equal((await t.pedir('POST', `/api/propuestas/${per.id}/confirmar`)).status, 409, 'primero el rol');
  assert.equal((await t.pedir('POST', `/api/propuestas/${rol.id}/confirmar`)).status, 200);
  assert.equal((await t.pedir('POST', `/api/propuestas/${per.id}/confirmar`)).status, 200);
  const juan = t.db.prepare("SELECT r.nombre FROM personas p JOIN roles r ON r.id = p.rol_id WHERE p.telefono = '5491140000000'").get();
  assert.equal(juan.nombre, 'Productor');
  assert.equal(t.nucleo.ajustes.get('nombre_agente'), 'Nina');
  assert.equal(t.nucleo.ajustes.bool('onboarding_hecho'), true);
  // Cerrado el onboarding, el chat del panel vuelve a las instrucciones base.
  await t.pedir('POST', '/api/chat', { texto: 'gracias' });
  await t.avanzar(1000);
  assert.equal(t.corridas.at(-1).spec.variante, 'base');
  t.limpiar();
});

test('si un Colaborador pide crear un rol, la respuesta es que solo el Propietario puede', async () => {
  const t = armar({ guion: async (spec, ctx, llamar) => { await llamar('proponer_rol', { nombre: 'Jefe', permisos: {} }); return []; } });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'creá un rol Jefe' });
  await t.avanzar(46_000);
  const c = t.corridas[0];
  assert.ok(!c.spec.herramientasGateway.includes('proponer_rol'), 'ni se le ofrece');
  // Y aunque el modelo la llame igual, la herramienta vuelve a mirar la política.
  assert.throws(() => t.nucleo.herramientas.proponer_rol.ejecutar(c.ctx, { nombre: 'Jefe', permisos: {} }), /Solo el Propietario/);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM propuestas').get().n, 0);
  t.limpiar();
});

test('por WhatsApp después del setup: "agregá a Juan" queda como propuesta y "confirmo P-n" del Propietario la aplica', async () => {
  const t = armar({ guion: (spec) => (spec.mensajes ?? true) && spec.prompt.includes('agregá') ? [{ herramienta: 'proponer_persona', args: { nombre: 'Juan', telefono: '5491140000001', rol: 'Colaborador' } }] : [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  t.nucleo.ajustes.set('propietario_completo', '0'); // prueba el flujo de propuestas y aprobaciones (otros roles)
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'agregá a Juan como Colaborador' });
  await t.avanzar(46_000);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM personas WHERE telefono = '5491140000001'").get().n, 0);
  // Desde otro número no confirma.
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'confirmo P-1' });
  await t.avanzar(46_000);
  assert.equal(t.db.prepare('SELECT estado FROM propuestas').get().estado, 'pendiente');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'confirmo P-1' });
  await t.avanzar(0);
  assert.equal(t.db.prepare('SELECT estado FROM propuestas').get().estado, 'confirmada');
  assert.ok(t.waha.enviados.some((e) => e.chatId === '5491111111111@c.us' && /P-1 confirmada/.test(e.texto)));
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM personas WHERE telefono = '5491140000001' AND alta_manual = 1").get().n, 1);
  t.limpiar();
});

test('la configuración inicial también sigue por el WhatsApp del Propietario, pero no en grupos ni con otros', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Ana', telefono: '5491122222222', rol: 'Colaborador', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'hola' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await t.avanzar(46_000);
  const v = (tel) => t.corridas.find((c) => c.spec.chatId === `${tel}@c.us`)?.spec.variante;
  assert.equal(v('5491111111111'), 'onboarding');
  assert.equal(v('5491122222222'), 'base');
  t.nucleo.ajustes.set('onboarding_hecho', '1');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'otra cosa' });
  await t.avanzar(46_000);
  assert.equal(t.corridas.at(-1).spec.variante, 'base', 'terminada, vuelve a lo normal');
  t.limpiar();
});
