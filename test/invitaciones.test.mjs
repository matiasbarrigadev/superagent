// Invitaciones al panel: link de un solo uso, cuenta propia con contraseña y app de códigos, y acceso solo a las
// secciones elegidas. El Propietario ve quién entra, revoca invitaciones y quita accesos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp, pasoActual } from '../src/auth/cripto.mjs';
import { puedeRuta } from '../src/auth/accesos.mjs';
import { armar, persona, escribe } from './ayuda.mjs';

async function conPropietario() {
  const t = armar({ guion: () => [] });
  const ini = await t.pedir('POST', '/api/setup/iniciar', { codigo: 'PRUE-BA12-3456', email: 'dueno@ejemplo.com', contrasena: 'contraseña-bien-larga' });
  await t.pedir('POST', '/api/setup/confirmar', { token: ini.json.token, totp: totp(ini.json.secreto, pasoActual()), nombre: 'Dueña' });
  return t;
}
const tokenDe = (link) => /#invitacion=([\w-]+)$/.exec(link)[1];

test('accesos: un invitado solo usa las rutas de sus secciones', () => {
  assert.ok(puedeRuta('todo', '/api/chat'));
  assert.ok(puedeRuta(['whatsapp'], '/api/whatsapp/qr'));
  assert.ok(puedeRuta(['whatsapp'], '/api/resumen'));
  assert.ok(!puedeRuta(['whatsapp'], '/api/claude/estado'));
  assert.ok(!puedeRuta(['whatsapp'], '/api/chat'));
  assert.ok(!puedeRuta(['bandeja'], '/api/chat'), '/api/chat no es /api/chats');
  assert.ok(puedeRuta(['bandeja'], '/api/chats/x'));
  assert.ok(!puedeRuta(['equipo'], '/api/personas/yo/numero'), 'el número del Propietario es suyo');
  assert.ok(!puedeRuta(['equipo'], '/api/invitaciones'));
});

test('invitación: el invitado crea su cuenta, entra solo a WhatsApp, y el link no sirve dos veces', async () => {
  const t = await conPropietario();
  const inv = await t.pedir('POST', '/api/invitaciones', { nombre: 'Ana', accesos: ['whatsapp'] });
  assert.equal(inv.status, 200);
  assert.match(inv.json.link, /^http:\/\/localhost:8080\/#invitacion=/);
  const tk = tokenDe(inv.json.link);
  t.olvidarCookie();

  const ver = await t.pedir('POST', '/api/invitacion/ver', { invitacion: tk });
  assert.deepEqual(ver.json, { nombre: 'Ana', accesos: ['WhatsApp'] });
  const ini = await t.pedir('POST', '/api/invitacion/iniciar', { invitacion: tk, email: 'ana@ejemplo.com', contrasena: 'otra-contraseña-larga' });
  assert.equal(ini.status, 200);
  const conf = await t.pedir('POST', '/api/invitacion/confirmar', { token: ini.json.token, totp: totp(ini.json.secreto, pasoActual()) });
  assert.equal(conf.status, 200);
  assert.equal(conf.json.recuperacion.length, 10);

  const estado = await t.pedir('GET', '/api/estado');
  assert.equal(estado.json.modo, 'panel');
  assert.deepEqual(estado.json.usuario.accesos, ['whatsapp']);
  assert.equal(estado.json.usuario.nombre, 'Ana');
  assert.equal((await t.pedir('GET', '/api/whatsapp/estado')).status, 200);
  assert.equal((await t.pedir('GET', '/api/resumen')).status, 200);
  assert.equal((await t.pedir('GET', '/api/claude/estado')).status, 403);
  assert.equal((await t.pedir('GET', '/api/personas')).status, 403);
  assert.equal((await t.pedir('GET', '/api/invitaciones')).status, 403);
  assert.equal((await t.pedir('POST', '/api/chat', { texto: 'hola' })).status, 403);

  // Para el agente es un Tercero: no gana permisos por tener panel.
  const p = t.db.prepare("SELECT r.nombre FROM usuarios_web u JOIN personas p ON p.id = u.persona_id JOIN roles r ON r.id = p.rol_id WHERE u.email = 'ana@ejemplo.com'").get();
  assert.equal(p.nombre, 'Tercero');

  t.olvidarCookie();
  assert.equal((await t.pedir('POST', '/api/invitacion/ver', { invitacion: tk })).status, 410, 'un solo uso');
  t.limpiar();
});

test('el Propietario ve, revoca y quita accesos', async () => {
  const t = await conPropietario();
  const a = await t.pedir('POST', '/api/invitaciones', { nombre: 'Ana', accesos: ['bandeja', 'bitacora'] });
  const b = await t.pedir('POST', '/api/invitaciones', { nombre: 'Beto', accesos: ['todo'] });
  assert.equal((await t.pedir('POST', '/api/invitaciones', { nombre: 'Nadie', accesos: [] })).status, 400);
  let l = await t.pedir('GET', '/api/invitaciones');
  assert.equal(l.json.invitaciones.length, 2);
  assert.equal(l.json.invitaciones.find((i) => i.nombre === 'Beto').accesos, 'todo');
  assert.equal(l.json.usuarios.length, 1);

  await t.pedir('DELETE', `/api/invitaciones/${a.json.id}`);
  l = await t.pedir('GET', '/api/invitaciones');
  assert.deepEqual(l.json.invitaciones.map((i) => i.nombre), ['Beto']);

  // Beto acepta (co-propietario) y después se le quita el acceso.
  const tk = tokenDe(b.json.link);
  t.olvidarCookie();
  const ini = await t.pedir('POST', '/api/invitacion/iniciar', { invitacion: tk, email: 'beto@ejemplo.com', contrasena: 'contraseña-de-beto-1' });
  await t.pedir('POST', '/api/invitacion/confirmar', { token: ini.json.token, totp: totp(ini.json.secreto, pasoActual()) });
  assert.equal((await t.pedir('GET', '/api/estado')).json.usuario.accesos, 'todo');
  assert.equal((await t.pedir('GET', '/api/personas')).status, 200);
  const usuarios = (await t.pedir('GET', '/api/invitaciones')).json.usuarios;
  const dueña = usuarios.find((u) => u.email === 'dueno@ejemplo.com');
  const beto = usuarios.find((u) => u.email === 'beto@ejemplo.com');
  assert.equal((await t.pedir('DELETE', `/api/usuarios-panel/${beto.id}`)).status, 409, 'no se quita a sí mismo');
  assert.equal((await t.pedir('DELETE', `/api/usuarios-panel/${dueña.id}`)).status, 200, 'un co-propietario puede quitar a otro Propietario si queda uno');
  t.limpiar();
});

test('el agente invita al panel cuando se lo pide el Propietario, no un Colaborador', async () => {
  const t = armar({
    guion: () => [{ herramienta: 'invitar_panel', args: { nombre: 'Ana', accesos: ['whatsapp'] } }],
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'invitá a Ana al panel para que vincule el WhatsApp' });
  await t.avanzar(46_000);
  const r = t.corridas.at(-1).resultados.find((x) => x.herramienta === 'invitar_panel').r;
  assert.match(JSON.stringify(r), /#invitacion=/);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM invitaciones').get().n, 1);

  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'invitame al panel' });
  await t.avanzar(46_000);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM invitaciones').get().n, 1, 'el Colaborador no puede');
  t.limpiar();
});
