import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp, pasoActual, verificarTotp, hashContrasena, verificarContrasena, cifrar, descifrar, base32, desdeBase32 } from '../src/auth/cripto.mjs';
import { armar } from './ayuda.mjs';

test('TOTP coincide con el vector de la RFC 6238', () => {
  const secreto = base32(Buffer.from('12345678901234567890'));
  // T = 59 s → 94287082 (8 dígitos); con 6 dígitos: 287082.
  assert.equal(totp(secreto, Math.floor(59 / 30)), '287082');
  assert.deepEqual(desdeBase32(secreto), Buffer.from('12345678901234567890'));
});

test('contraseñas y cifrado', () => {
  const h = hashContrasena('una contraseña larga');
  assert.ok(verificarContrasena('una contraseña larga', h));
  assert.ok(!verificarContrasena('otra', h));
  const s = cifrar('maestro', 'secreto', 'totp');
  assert.equal(descifrar('maestro', s, 'totp'), 'secreto');
  assert.throws(() => descifrar('otro', s, 'totp'));
});

test('flujo completo: setup → login → TOTP inválido → código de recuperación de un solo uso', async () => {
  const { pedir, olvidarCookie } = armar();
  assert.equal((await pedir('GET', '/api/estado')).json.modo, 'setup');

  assert.equal((await pedir('POST', '/api/setup/codigo', { codigo: 'malo' })).status, 401);
  assert.equal((await pedir('POST', '/api/setup/codigo', { codigo: 'prue ba12 3456' })).status, 200);
  assert.equal((await pedir('POST', '/api/setup/iniciar', { codigo: 'PRUE-BA12-3456', email: 'dueno@ejemplo.com', contrasena: 'corta' })).status, 400);

  const ini = await pedir('POST', '/api/setup/iniciar', { codigo: 'PRUE-BA12-3456', email: 'Dueno@Ejemplo.com', contrasena: 'contraseña-bien-larga' });
  assert.equal(ini.status, 200);
  assert.match(ini.json.qr, /^data:image\/png;base64,/);
  const secreto = ini.json.secreto;

  assert.equal((await pedir('POST', '/api/setup/confirmar', { token: ini.json.token, totp: '000000' })).status, 401);
  const paso = pasoActual();
  const conf = await pedir('POST', '/api/setup/confirmar', { token: ini.json.token, totp: totp(secreto, paso), nombre: 'Dueña' });
  assert.equal(conf.status, 200);
  assert.equal(conf.json.recuperacion.length, 10);

  // El setup se cerró solo y ya hay sesión.
  const est = await pedir('GET', '/api/estado');
  assert.equal(est.json.modo, 'panel');
  assert.equal(est.json.usuario.rol, 'Propietario');
  assert.equal((await pedir('POST', '/api/setup/codigo', { codigo: 'PRUE-BA12-3456' })).status, 409);

  await pedir('POST', '/api/auth/logout');
  olvidarCookie();
  assert.equal((await pedir('GET', '/api/estado')).json.modo, 'login');
  assert.equal((await pedir('GET', '/api/whatsapp/estado')).status, 401);

  // TOTP inválido y TOTP ya usado (el del setup) se rechazan.
  assert.equal((await pedir('POST', '/api/auth/login', { email: 'dueno@ejemplo.com', contrasena: 'contraseña-bien-larga', codigo: '123456' })).status, 401);
  assert.equal((await pedir('POST', '/api/auth/login', { email: 'dueno@ejemplo.com', contrasena: 'contraseña-bien-larga', codigo: totp(secreto, paso) })).status, 401);
  assert.equal((await pedir('POST', '/api/auth/login', { email: 'dueno@ejemplo.com', contrasena: 'mal', codigo: totp(secreto, paso + 1) })).status, 401);

  // Código de recuperación: sirve una vez.
  const rec = conf.json.recuperacion[0];
  assert.equal((await pedir('POST', '/api/auth/login', { email: 'dueno@ejemplo.com', contrasena: 'contraseña-bien-larga', codigo: rec.toLowerCase() })).status, 200);
  assert.equal((await pedir('GET', '/api/whatsapp/estado')).status, 200);
  await pedir('POST', '/api/auth/logout');
  olvidarCookie();
  assert.equal((await pedir('POST', '/api/auth/login', { email: 'dueno@ejemplo.com', contrasena: 'contraseña-bien-larga', codigo: rec })).status, 401);
});

test('verificarTotp acepta ±1 paso y nada más', () => {
  const s = base32(Buffer.from('abcdefghijabcdefghij'));
  const ahora = Date.now();
  const p = pasoActual(ahora);
  assert.equal(verificarTotp(s, totp(s, p - 1), ahora), p - 1);
  assert.equal(verificarTotp(s, totp(s, p + 3), ahora), null);
});

test('límite de intentos de login', async () => {
  const { pedir } = armar();
  const ini = await pedir('POST', '/api/setup/iniciar', { codigo: 'PRUE-BA12-3456', email: 'a@b.co', contrasena: 'contraseña-bien-larga' });
  await pedir('POST', '/api/setup/confirmar', { token: ini.json.token, totp: totp(ini.json.secreto, pasoActual()) });
  let ultimo;
  for (let i = 0; i < 10; i++) ultimo = await pedir('POST', '/api/auth/login', { email: 'a@b.co', contrasena: 'mala', codigo: '111111' });
  assert.equal(ultimo.status, 429);
});
