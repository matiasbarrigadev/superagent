// Proxy de /apps/<nombre>/ al puerto local de cada app del agente (HTTP y WebSocket, así funciona la recarga en
// vivo de los servidores de desarrollo). Va antes que la app del gateway, a nivel del servidor HTTP de Node.
//
// La app comparte origen con el panel, así que la cookie de sesión del panel nunca le llega, y la app no puede
// pisarla. La API del panel rechaza pedidos que vienen desde una página de /apps/ (ver app.mjs).
import http from 'node:http';
import { NOMBRE_APP } from '../servicios/apps.mjs';

const SALTO = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

export function crearProxyApps({ apps, cookiePanel = 'sa_sesion', log = console }) {
  const sinCookiePanel = (valor) => String(valor ?? '').split(';').map((x) => x.trim())
    .filter((x) => x && !x.startsWith(`${cookiePanel}=`)).join('; ');

  /** { app, ruta } si la URL es de una app registrada; null si no es de /apps/. */
  function resolver(url) {
    const m = /^\/apps\/([^/?#]+)(\/[^?#]*)?(\?.*)?$/.exec(url ?? '');
    if (!m) return null;
    const nombre = decodeURIComponent(m[1]);
    const app = NOMBRE_APP.test(nombre) ? apps.obtener(nombre) : null;
    const resto = m[2] ?? '';
    const ruta = app?.quitar_prefijo ? `${resto || '/'}${m[3] ?? ''}` : url;
    return { nombre, app, ruta, sinBarra: !m[2] };
  }

  function cabeceras(req, nombre, puerto) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!SALTO.has(k)) h[k] = v;
    const c = sinCookiePanel(req.headers.cookie);
    if (c) h.cookie = c; else delete h.cookie;
    h['x-forwarded-host'] = req.headers.host ?? '';
    // Los servidores de desarrollo (vite, etc.) rechazan hosts desconocidos: hacia la app va como localhost.
    h.host = `localhost:${puerto}`;
    h['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? 'https';
    h['x-forwarded-prefix'] = `/apps/${nombre}`;
    return h;
  }

  function noDisponible(res, nombre, existe) {
    res.writeHead(existe ? 502 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${nombre}</title>
<body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#444">
<h1 style="font-size:1.2rem">${existe ? 'La app se está levantando' : 'No hay una app con este nombre'}</h1>
<p>${existe ? 'Probá de nuevo en unos segundos.' : 'Revisá el link.'}</p></body>`);
  }

  /** Devuelve true si atendió el pedido. */
  function manejar(req, res) {
    const r = resolver(req.url);
    if (!r) return false;
    if (!r.app) { noDisponible(res, r.nombre, false); return true; }
    if (r.sinBarra) {
      res.writeHead(308, { location: `/apps/${r.nombre}/${(req.url.split('?')[1] ? `?${req.url.split('?')[1]}` : '')}` });
      res.end();
      return true;
    }
    const pedido = http.request({ host: 'localhost', port: r.app.puerto, autoSelectFamily: true, method: req.method, path: r.ruta, headers: cabeceras(req, r.nombre, r.app.puerto) }, (resp) => {
      const h = { ...resp.headers };
      // La app no puede tocar la cookie del panel.
      if (h['set-cookie']) h['set-cookie'] = [].concat(h['set-cookie']).filter((c) => !c.trim().startsWith(`${cookiePanel}=`));
      for (const k of SALTO) delete h[k];
      res.writeHead(resp.statusCode ?? 502, h);
      resp.pipe(res);
    });
    pedido.on('error', () => { if (!res.headersSent) noDisponible(res, r.nombre, true); else res.destroy(); });
    req.pipe(pedido);
    return true;
  }

  /** WebSocket (recarga en vivo, apps en tiempo real). Devuelve true si lo atendió. */
  function upgrade(req, socket, cabeza) {
    const r = resolver(req.url);
    if (!r) return false;
    if (!r.app) { socket.destroy(); return true; }
    const h = cabeceras(req, r.nombre, r.app.puerto);
    h.connection = 'Upgrade';
    h.upgrade = req.headers.upgrade;
    const pedido = http.request({ host: 'localhost', port: r.app.puerto, autoSelectFamily: true, method: req.method, path: r.ruta, headers: h });
    pedido.on('upgrade', (resp, remoto, cabezaRemota) => {
      const lineas = [`HTTP/1.1 ${resp.statusCode} ${resp.statusMessage}`];
      for (let i = 0; i < resp.rawHeaders.length; i += 2) lineas.push(`${resp.rawHeaders[i]}: ${resp.rawHeaders[i + 1]}`);
      socket.write(`${lineas.join('\r\n')}\r\n\r\n`);
      if (cabezaRemota?.length) socket.write(cabezaRemota);
      if (cabeza?.length) remoto.write(cabeza);
      remoto.pipe(socket).pipe(remoto);
      remoto.on('error', () => socket.destroy());
      socket.on('error', () => remoto.destroy());
    });
    pedido.on('response', (resp) => { socket.end(`HTTP/1.1 ${resp.statusCode} ${resp.statusMessage}\r\n\r\n`); });
    pedido.on('error', (e) => { log.warn?.(`[apps] ws ${r.nombre}: ${e.message}`); socket.destroy(); });
    pedido.end();
    return true;
  }

  /** Pone el proxy delante de los listeners que ya tiene el servidor (la app del gateway y node-ws). */
  function montar(server) {
    const pedidos = server.listeners('request');
    server.removeAllListeners('request');
    server.on('request', (req, res) => { if (!manejar(req, res)) for (const l of pedidos) l.call(server, req, res); });
    const upgrades = server.listeners('upgrade');
    server.removeAllListeners('upgrade');
    server.on('upgrade', (req, socket, cabeza) => { if (!upgrade(req, socket, cabeza)) for (const l of upgrades) l.call(server, req, socket, cabeza); });
  }

  return { manejar, upgrade, montar, resolver };
}
