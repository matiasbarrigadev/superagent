// Apps del agente: registro, vigía que las mantiene vivas, proxy /apps/<nombre>/ (HTTP, cookies y WebSocket)
// y la herramienta para el Propietario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { abrirBase } from '../src/db/index.mjs';
import { crearApps } from '../src/servicios/apps.mjs';
import { crearProxyApps } from '../src/apps/proxy.mjs';
import { armar, persona, escribe } from './ayuda.mjs';

const silencio = { log() {}, warn() {} };
const config = { port: 8080, mcpPort: 8081, publicUrl: 'https://agente.ejemplo.com' };
const escuchar = (srv) => new Promise((r) => { escucharTodo(srv); srv.listen(0, '127.0.0.1', () => r(srv.address().port)); });
const sockets = new WeakMap();
const escucharTodo = (srv) => { const l = []; sockets.set(srv, l); srv.on('connection', (s) => l.push(s)); return srv; };
// Cierra también los sockets que pasaron a WebSocket (close() no los corta).
const cerrar = (srv) => new Promise((r) => { for (const s of sockets.get(srv) ?? []) s.destroy(); srv.closeAllConnections?.(); srv.close(() => r()); });

function pedir(puerto, ruta, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: puerto, path: ruta, headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, cuerpo: b }));
    }).on('error', reject);
  });
}

test('apps: valida nombre y puerto, y no deja usar los del sistema', () => {
  const db = abrirBase(':memory:');
  const apps = crearApps({ db, config, log: silencio });
  assert.throws(() => apps.publicar({ nombre: 'Mi CRM', puerto: 3000 }), /minúsculas/);
  assert.throws(() => apps.publicar({ nombre: 'crm', puerto: 8081 }), /lo usa el sistema/);
  assert.throws(() => apps.publicar({ nombre: 'crm', puerto: 80 }), /1024/);
  apps.publicar({ nombre: 'crm', puerto: 3000 });
  assert.throws(() => apps.publicar({ nombre: 'otra', puerto: 3000 }), /ya es de la app "crm"/);
  assert.equal(apps.url('crm'), 'https://agente.ejemplo.com/apps/crm/');
});

test('apps: el vigía levanta las que no responden, con el entorno correcto y sin insistir en loop', async () => {
  const db = abrirBase(':memory:');
  let ahora = 0;
  const lanzadas = [];
  const lanzar = (cmd, args, op) => { lanzadas.push({ cmd, args, op }); return { pid: 4242, unref() {}, on() {} }; };
  const aislamiento = { activo: false, rutas: () => ({ base: '/datos/prop', tmp: '/datos/prop/tmp' }) };
  const entorno = { variables: () => ({ DATABASE_URL: 'postgres://x' }) };
  const apps = crearApps({ db, config, aislamiento, entorno, lanzar, probar: async () => false, reloj: () => ahora, log: silencio });
  apps.publicar({ nombre: 'crm', puerto: 3001, comando: 'npm run dev', dir: 'trabajo/crm' });
  apps.publicar({ nombre: 'manual', puerto: 3002 });
  assert.deepEqual(await apps.vigilar(), ['crm']);
  const l = lanzadas[0];
  assert.equal(l.args[4], 'npm run dev');
  assert.match(l.args[3], /trabajo[\\/]crm$/);
  assert.equal(l.op.env.PORT, '3001');
  assert.equal(l.op.env.BASE_PATH, '/apps/crm');
  assert.equal(l.op.env.DATABASE_URL, 'postgres://x');
  assert.ok(!Object.keys(l.op.env).some((k) => /CLAUDE|ANTHROPIC/.test(k)), 'sin el token de Claude');
  ahora += 60_000;
  assert.deepEqual(await apps.vigilar(), [], 'no reintenta antes de 2 minutos');
  ahora += 61_000;
  assert.deepEqual(await apps.vigilar(), ['crm']);
});

test('apps: en pausa el vigía no levanta nada', async () => {
  const db = abrirBase(':memory:');
  const apps = crearApps({ db, config, aislamiento: { activo: false, rutas: () => ({ base: '/b', tmp: '/t' }) }, pausada: () => true, lanzar: () => { throw new Error('no'); }, probar: async () => false, log: silencio });
  apps.publicar({ nombre: 'crm', puerto: 3001, comando: 'npm start' });
  assert.deepEqual(await apps.vigilar(), []);
});

test('proxy: /apps/<nombre>/ llega a la app sin la cookie del panel, y la app no la puede pisar', async () => {
  const vistos = [];
  const app = http.createServer((req, res) => {
    vistos.push({ url: req.url, cookie: req.headers.cookie, host: req.headers.host, prefijo: req.headers['x-forwarded-prefix'] });
    res.writeHead(200, { 'set-cookie': ['sa_sesion=robada; Path=/', 'propia=1; Path=/apps/crm'], 'content-type': 'text/plain' });
    res.end('hola desde la app');
  });
  const pApp = await escuchar(app);
  const db = abrirBase(':memory:');
  const apps = crearApps({ db, config, log: silencio });
  apps.publicar({ nombre: 'crm', puerto: pApp });
  const otra = http.createServer((req, res) => { vistos.push({ url: req.url }); res.end('estatico'); });
  apps.publicar({ nombre: 'estatico', puerto: await escuchar(otra), quitarPrefijo: true });
  const gw = http.createServer((req, res) => { res.end('panel'); });
  crearProxyApps({ apps, log: silencio }).montar(gw);
  const pGw = await escuchar(gw);

  const r = await pedir(pGw, '/apps/crm/clientes?x=1', { cookie: 'sa_sesion=secreta; propia=1' });
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo, 'hola desde la app');
  assert.deepEqual(vistos[0], { url: '/apps/crm/clientes?x=1', cookie: 'propia=1', host: `localhost:${pApp}`, prefijo: '/apps/crm' });
  assert.deepEqual(r.headers['set-cookie'], ['propia=1; Path=/apps/crm']);

  await pedir(pGw, '/apps/estatico/index.html');
  assert.equal(vistos[1].url, '/index.html', 'quitar_prefijo');

  assert.equal((await pedir(pGw, '/apps/crm')).status, 308);
  assert.equal((await pedir(pGw, '/apps/no-existe/')).status, 404);
  assert.equal((await pedir(pGw, '/inicio')).cuerpo, 'panel', 'lo demás sigue al panel');
  await cerrar(gw); await cerrar(app); await cerrar(otra);
});

test('proxy: app registrada que no responde → 502 con aviso', async () => {
  const db = abrirBase(':memory:');
  const apps = crearApps({ db, config, log: silencio });
  apps.publicar({ nombre: 'caida', puerto: 39999 });
  const gw = http.createServer((req, res) => res.end('panel'));
  crearProxyApps({ apps, log: silencio }).montar(gw);
  const p = await escuchar(gw);
  const r = await pedir(p, '/apps/caida/');
  assert.equal(r.status, 502);
  assert.match(r.cuerpo, /levantando/);
  await cerrar(gw);
});

test('proxy: WebSocket (recarga en vivo) pasa hasta la app', async () => {
  const app = http.createServer();
  app.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(`eco:${d}`));
  });
  const pApp = await escuchar(app);
  const db = abrirBase(':memory:');
  const apps = crearApps({ db, config, log: silencio });
  apps.publicar({ nombre: 'vivo', puerto: pApp });
  const gw = http.createServer((req, res) => res.end('panel'));
  crearProxyApps({ apps, log: silencio }).montar(gw);
  const pGw = await escuchar(gw);
  const eco = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: pGw, path: '/apps/vivo/hmr', headers: { connection: 'Upgrade', upgrade: 'websocket' } });
    req.on('upgrade', (res, socket) => { socket.once('data', (d) => { resolve(String(d)); socket.destroy(); }); socket.write('hola'); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(eco, 'eco:hola');
  await cerrar(gw); await cerrar(app);
});

test('la API del panel no atiende pedidos hechos desde una página de /apps/', async () => {
  const t = armar({ guion: () => [] });
  const r = await t.app.request('/api/estado', { headers: { referer: 'http://localhost:8080/apps/crm/' } });
  assert.equal(r.status, 403);
  assert.equal((await t.app.request('/api/estado', { headers: { referer: 'http://localhost:8080/' } })).status, 200);
  t.limpiar();
});

test('herramienta apps: la tiene el Propietario (con instrucciones del entorno), no otro rol', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'armame una calculadora' });
  await t.avanzar(46_000);
  const prop = t.corridas.at(-1).spec;
  assert.ok(prop.herramientasGateway.includes('apps'));
  assert.match(prop.prompt, /\/apps\/<nombre>\//);
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await t.avanzar(46_000);
  assert.ok(!t.corridas.at(-1).spec.herramientasGateway.includes('apps'));
  t.limpiar();
});
