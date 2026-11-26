// Etapa 9: recuperación de acceso (una prueba por fila de TEORIA §4.4) y pausa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp, pasoActual } from '../src/auth/cripto.mjs';
import { crearAuth } from '../src/auth/servicio.mjs';
import { armar, persona, escribe, silencio } from './ayuda.mjs';

const CLAVE = 'contraseña-bien-larga';

/** Setup completo guardando el secreto TOTP y los códigos de recuperación. */
async function conPropietario() {
  const t = armar({ guion: (spec) => [{ herramienta: 'responder', args: { texto: `hola ${spec.rol.nombre}` } }] });
  await t.pedir('POST', '/api/setup/codigo', { codigo: 'PRUE-BA12-3456' });
  const ini = await t.pedir('POST', '/api/setup/iniciar', { codigo: 'PRUE-BA12-3456', email: 'duena@ejemplo.com', contrasena: CLAVE });
  // Un paso de TOTP "usado" en el setup: los siguientes códigos usan pasos futuros para no repetir.
  const conf = await t.pedir('POST', '/api/setup/confirmar', { token: ini.json.token, totp: totp(ini.json.secreto, pasoActual()), nombre: 'Dueña' });
  t.olvidarCookie();
  return { t, secreto: ini.json.secreto, codigos: conf.json.recuperacion, codigo: (n = 1) => totp(ini.json.secreto, pasoActual() + n) };
}
const login = (t, contrasena, codigo) => t.pedir('POST', '/api/auth/login', { email: 'duena@ejemplo.com', contrasena, codigo });

test('contraseña perdida: TOTP + código de recuperación → contraseña nueva; el código no se reusa', async () => {
  const { t, codigos, codigo } = await conPropietario();
  const r = await t.pedir('POST', '/api/recuperar/contrasena', { email: 'duena@ejemplo.com', totp: codigo(1), recuperacion: codigos[0], nueva: 'otra-contraseña-larga' });
  assert.equal(r.status, 200);
  assert.equal((await login(t, CLAVE, codigos[1])).status, 401, 'la vieja ya no sirve');
  assert.equal((await login(t, 'otra-contraseña-larga', codigos[1])).status, 200);
  assert.equal((await t.pedir('POST', '/api/recuperar/contrasena', { email: 'duena@ejemplo.com', totp: codigo(2), recuperacion: codigos[0], nueva: 'tercera-contraseña-larga' })).status, 401, 'código de recuperación ya usado');
  assert.equal((await t.pedir('POST', '/api/recuperar/contrasena', { email: 'duena@ejemplo.com', totp: '000000', recuperacion: codigos[2], nueva: 'tercera-contraseña-larga' })).status, 401, 'TOTP malo');
  t.limpiar();
});

test('contraseña perdida, otra vía: código por WhatsApp al número verificado + TOTP', async () => {
  const { t, codigo, codigos } = await conPropietario();
  t.db.prepare("UPDATE personas SET telefono = '5491111111111', verificada = 1").run();
  assert.equal((await t.pedir('POST', '/api/recuperar/whatsapp/pedir', { email: 'nadie@ejemplo.com' })).json.ok, true, 'no delata si el email existe');
  assert.equal(t.waha.enviados.length, 0);
  await t.pedir('POST', '/api/recuperar/whatsapp/pedir', { email: 'duena@ejemplo.com' });
  const msg = t.waha.enviados.at(-1);
  assert.equal(msg.chatId, '5491111111111@c.us');
  const cod = msg.texto.match(/(\d{6})/)[1];
  assert.equal((await t.pedir('POST', '/api/recuperar/whatsapp/confirmar', { email: 'duena@ejemplo.com', codigoWhatsapp: cod, totp: '000000', nueva: 'nueva-por-whatsapp-1' })).status, 401, 'sin TOTP no alcanza');
  assert.equal((await t.pedir('POST', '/api/recuperar/whatsapp/confirmar', { email: 'duena@ejemplo.com', codigoWhatsapp: cod, totp: codigo(1), nueva: 'nueva-por-whatsapp-1' })).status, 200);
  assert.equal((await login(t, 'nueva-por-whatsapp-1', codigos[0])).status, 200);
  t.limpiar();
});

test('teléfono del TOTP perdido: contraseña + código de recuperación → TOTP nuevo y códigos nuevos', async () => {
  const { t, secreto, codigos } = await conPropietario();
  const ini = await t.pedir('POST', '/api/recuperar/totp/iniciar', { email: 'duena@ejemplo.com', contrasena: CLAVE, recuperacion: codigos[0] });
  assert.equal(ini.status, 200);
  assert.match(ini.json.qr, /^data:image\/png/);
  const conf = await t.pedir('POST', '/api/recuperar/totp/confirmar', { token: ini.json.token, totp: totp(ini.json.secreto, pasoActual()) });
  assert.equal(conf.json.recuperacion.length, 10);
  assert.equal((await login(t, CLAVE, totp(secreto, pasoActual() + 1))).status, 401, 'el TOTP viejo ya no sirve');
  assert.equal((await login(t, CLAVE, codigos[1])).status, 401, 'los códigos viejos tampoco');
  assert.equal((await login(t, CLAVE, conf.json.recuperacion[0])).status, 200);
  t.limpiar();
});

test('WhatsApp personal perdido: con login normal cambia su número (verificado con código al nuevo)', async () => {
  const { t, codigos } = await conPropietario();
  t.db.prepare("UPDATE personas SET telefono = '5491111111111', verificada = 1").run();
  await login(t, CLAVE, codigos[0]);
  await t.pedir('POST', '/api/personas/yo/telefono', { telefono: '5491133334444' });
  const cod = t.waha.enviados.at(-1);
  assert.equal(cod.chatId, '5491133334444@c.us');
  assert.equal((await t.pedir('POST', '/api/personas/yo/verificar', { codigo: cod.texto.match(/(\d{6})/)[1] })).status, 200);
  assert.equal(t.db.prepare('SELECT telefono FROM personas WHERE id = 1').get().telefono, '5491133334444');
  t.limpiar();
});

test('número dedicado perdido: desvincular no pierde memoria ni roles', async () => {
  let desvinculado = false;
  const { t, codigos } = await conPropietario();
  t.waha.desvincular = async () => { desvinculado = true; };
  t.nucleo.memoria.guardar({ alcance: 'cuenta', seccion: 'Contexto', contenido: 'Somos una productora' });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  const antes = [t.db.prepare('SELECT COUNT(*) n FROM memoria').get().n, t.db.prepare('SELECT COUNT(*) n FROM personas').get().n, t.db.prepare('SELECT COUNT(*) n FROM roles').get().n];
  await login(t, CLAVE, codigos[0]);
  assert.equal((await t.pedir('POST', '/api/whatsapp/desvincular')).status, 200);
  assert.ok(desvinculado);
  assert.deepEqual([t.db.prepare('SELECT COUNT(*) n FROM memoria').get().n, t.db.prepare('SELECT COUNT(*) n FROM personas').get().n, t.db.prepare('SELECT COUNT(*) n FROM roles').get().n], antes);
  t.limpiar();
});

test('todo junto: SUPERAGENT_RESET_OWNER vuelve a modo setup y conserva personas, roles, memoria y repos', async () => {
  const { t } = await conPropietario();
  t.nucleo.memoria.guardar({ alcance: 'cuenta', seccion: 'Contexto', contenido: 'Somos una productora' });
  t.db.prepare("INSERT INTO proyectos (cliente_id, nombre, repo) VALUES (1, 'sitio', 'org/sitio')").run();
  const conteo = () => ['personas', 'roles', 'memoria', 'proyectos'].map((x) => t.db.prepare(`SELECT COUNT(*) n FROM ${x}`).get().n);
  const antes = conteo();
  // Al arrancar con la variable puesta:
  const auth = crearAuth({ db: t.db, config: { ...t.config, setupCode: null }, log: silencio });
  assert.equal(auth.resetPropietario('1'), true);
  assert.equal(auth.enSetup(), true);
  assert.deepEqual(conteo(), antes);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM usuarios_web').get().n, 0);
  assert.ok(t.db.prepare("SELECT 1 FROM auditoria WHERE accion = 'reset_owner'").get(), 'queda en auditoría');
  // Si la variable queda puesta, el próximo arranque no vuelve a resetear.
  assert.equal(crearAuth({ db: t.db, config: t.config, log: silencio }).resetPropietario('1'), false);
  t.limpiar();
});

test('pausa: un mensaje no dispara corrida y recibe el mensaje fijo; "pausá todo" solo desde el Propietario; al reanudar se procesa', async () => {
  const t = armar({ guion: (spec) => [{ herramienta: 'responder', args: { texto: `hola ${spec.rol.nombre}` } }] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'pausá todo' });
  await t.avanzar(46_000);
  assert.equal(t.nucleo.motor.pausada(), false, 'un Colaborador no pausa');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'pausá todo' });
  await t.avanzar(0);
  assert.equal(t.nucleo.motor.pausada(), true);
  const corridas = t.corridas.length;
  await escribe(t.nucleo, { telefono: '5491199990000', texto: 'hola, ¿están?' });
  await t.avanzar(46_000);
  assert.equal(t.corridas.length, corridas, 'en pausa no corre nada');
  assert.ok(t.waha.enviados.some((e) => e.chatId === '5491199990000@c.us' && /en pausa/.test(e.texto)));
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'reanudá' });
  await t.avanzar(3000);
  assert.equal(t.nucleo.motor.pausada(), false);
  await t.avanzar(46_000);
  assert.ok(t.waha.enviados.some((e) => e.chatId === '5491199990000@c.us' && e.texto === 'hola Tercero'), 'lo que quedó guardado se responde al reanudar');
  t.limpiar();
});

test('setup sin código en la ventana inicial; fuera de la ventana lo pide; reiniciar no la extiende', async () => {
  const t = armar({ guion: () => [] });
  const abierto = crearAuth({ db: t.db, config: { ...t.config, setupSinCodigoMs: 60_000 }, log: silencio });
  assert.equal(abierto.setupSinCodigo(), true);
  abierto.verificarCodigoSetup('', '1.1.1.1');
  t.db.prepare("UPDATE ajustes SET valor = ? WHERE clave = 'setup_abierto_hasta'").run(String(Date.now() - 1));
  const vencido = crearAuth({ db: t.db, config: { ...t.config, setupSinCodigoMs: 60_000 }, log: silencio });
  assert.equal(vencido.setupSinCodigo(), false);
  assert.throws(() => vencido.verificarCodigoSetup('', '1.1.1.2'), /incorrecto/);
});
