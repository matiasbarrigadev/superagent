// Rutas HTTP del gateway: salud, webhook de WAHA, API del panel y la SPA.
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { ErrorAuth } from './auth/servicio.mjs';
import { ErrorWaha, normalizarTelefono } from './wa/waha.mjs';
import { verificarHmac } from './wa/webhook.mjs';
import { auditar } from './db/index.mjs';
import { montarPanel, PREFIJOS_PANEL } from './rutas/panel.mjs';
import { SECCIONES_PANEL, accesosDe, puedeRuta } from './auth/accesos.mjs';

const COOKIE = 'sa_sesion';
export const VERSION = '0.9.2';

export function crearApp({ db, config, auth, waha, claude, nucleo, upgradeWebSocket = null, log = console }) {
  const app = new Hono();
  // El código de recuperación por WhatsApp lo manda el gateway directo (no pasa por el agente).
  auth.enviarWhatsapp = async (chatId, texto) => { nucleo.salida.encolar({ chatId, texto, origen: 'recuperacion' }); await nucleo.salida.procesar(); };

  const ipDe = (c) => c.req.header('x-forwarded-for')?.split(',')[0].trim()
    || c.env?.incoming?.socket?.remoteAddress || null;
  const meta = (c) => ({ ip: ipDe(c), userAgent: c.req.header('user-agent') ?? null });

  const ponerCookie = (c, sesion) => setCookie(c, COOKIE, sesion.valor, {
    httpOnly: true, secure: config.cookieSegura, sameSite: 'Lax', path: '/',
    expires: new Date(sesion.vence),
  });

  // --- Cabeceras de seguridad para todo.
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    // Una ruta puede poner las suyas, más estrictas (por ejemplo los adjuntos de la bandeja, que se muestran en el panel).
    if (!c.res.headers.get('X-Frame-Options')) c.header('X-Frame-Options', 'DENY');
    if (!c.res.headers.get('Content-Security-Policy')) {
      c.header('Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    }
  });

  // --- Errores conocidos → JSON con mensaje para la persona.
  app.onError((e, c) => {
    if (e instanceof ErrorAuth || e instanceof ErrorWaha) return c.json({ error: e.message }, e.status);
    // Errores de reglas (roles, propuestas, aprobaciones, verificación): traen un 4xx y un mensaje para la persona.
    if (Number.isInteger(e.status) && e.status >= 400 && e.status < 500) return c.json({ error: e.message }, e.status);
    log.error('[app]', c.req.method, c.req.path, e);
    return c.json({ error: 'Error interno.' }, 500);
  });

  app.get('/salud', (c) => {
    db.prepare('SELECT 1').get();
    return c.json({ ok: true, version: VERSION });
  });

  // --- Webhook de WAHA (red interna). Sin firma válida no entra nada.
  app.post('/webhook/waha', async (c) => {
    const crudo = Buffer.from(await c.req.arrayBuffer());
    if (!verificarHmac(config.waha.hmacKey, c.req.header('x-webhook-hmac'), crudo)) return c.json({ error: 'firma inválida' }, 401);
    let evt;
    try { evt = JSON.parse(crudo.toString('utf8')); } catch { return c.json({ error: 'json' }, 400); }
    return c.json({ ok: true, resultado: await nucleo.ingesta(evt) });
  });

  // --- Link firmado de aprobación: muestra el detalle y el diff, y permite decidir una sola vez.
  const escHtml = (t) => String(t ?? '').replace(/[<>&"]/g, (x) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[x]));
  const paginaAprobacion = (c, cuerpo, status = 200) => c.html(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aprobación</title>
<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1c1917}pre{background:#f5f5f4;padding:1rem;overflow:auto;font-size:.8rem;border-radius:.5rem}
.mas{color:#047857}.menos{color:#b91c1c}button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #d6d3d1;margin-right:.5rem;cursor:pointer}
.si{background:#047857;color:#fff;border-color:#047857}textarea{width:100%;font:inherit;margin:.5rem 0}@media(prefers-color-scheme:dark){body{background:#1c1917;color:#f5f5f4}pre{background:#292524}}</style>
<body>${cuerpo}</body></html>`, status);
  app.get('/aprobacion/:token', (c) => {
    let e;
    try { e = nucleo.aprobaciones.enlace(c.req.param('token')); } catch (err) { return paginaAprobacion(c, `<h1>No disponible</h1><p>${escHtml(err.message)}</p>`, err.status ?? 400); }
    const a = e.aprobacion;
    const diff = a.diff ? `<h2>Cambio</h2><pre>${escHtml(a.diff).split('\n').map((l) => (/^\+(?!\+\+)/.test(l) ? `<span class="mas">${l}</span>` : /^-(?!--)/.test(l) ? `<span class="menos">${l}</span>` : l)).join('\n')}</pre>` : '';
    return paginaAprobacion(c, `<h1>${escHtml(a.id)} · ${escHtml(a.estado)}</h1><p style="white-space:pre-wrap">${escHtml(a.detalle)}</p>${diff}
${a.estado === 'pendiente' ? `<form method="post"><label>Comentario (si rechazás, vuelve al agente)<textarea name="comentario" rows="3"></textarea></label>
<button class="si" name="decision" value="aprobar">Aprobar</button><button name="decision" value="rechazar">Rechazar</button></form>` : ''}`);
  });
  app.post('/aprobacion/:token', async (c) => {
    const origen = c.req.header('origin');
    if (origen) { let h = null; try { h = new URL(origen).host; } catch {} if (h !== c.req.header('host')) return c.text('Origen no permitido.', 403); }
    const f = await c.req.parseBody();
    try {
      const a = await nucleo.aprobaciones.decidirConEnlace(c.req.param('token'), { aprobar: f.decision === 'aprobar', comentario: String(f.comentario ?? '').slice(0, 1000) || null });
      return paginaAprobacion(c, `<h1>Listo: ${escHtml(a.id)} ${escHtml(a.estado)}</h1>${a.resultado ? `<p>${escHtml(a.resultado)}</p>` : ''}<p>Ya podés cerrar esta pestaña.</p>`);
    } catch (err) {
      return paginaAprobacion(c, `<h1>No se pudo</h1><p>${escHtml(err.message)}</p>`, err.status ?? 400);
    }
  });

  // --- Vuelta del OAuth de un conector (la abre la persona en su navegador).
  app.get('/oauth/callback', async (c) => {
    const pagina = (titulo, texto) => c.html(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1c1917"><h1 style="font-size:1.3rem">${titulo}</h1><p>${texto}</p></body></html>`);
    const esc = (t) => String(t).replace(/[<>&"]/g, (x) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[x]));
    if (c.req.query('error')) return pagina('No se conectó', `El proveedor respondió: ${esc(c.req.query('error'))}. Podés volver a pedir el link.`);
    try {
      const nombre = await nucleo.conectores.callback(c.req.query('state'), c.req.query('code'));
      return pagina('Listo', `${esc(nombre)} quedó conectado. Ya podés cerrar esta pestaña.`);
    } catch (e) {
      return pagina('No se pudo conectar', esc(e.message));
    }
  });

  // --- Entradas por webhook (formularios, otros sistemas). El secreto va en un header; el contenido es dato externo.
  app.post('/entrada/:id', async (c) => {
    const secreto = c.req.header('x-superagent-secreto') ?? (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const crudo = Buffer.from(await c.req.arrayBuffer());
    if (crudo.length > 64 * 1024) return c.json({ error: 'demasiado grande' }, 413);
    const r = nucleo.entradas.recibir(c.req.param('id'), secreto, crudo.toString('utf8'));
    if (r === 'ok') return c.json({ ok: true });
    if (r === 'no_existe' || r === 'secreto') return c.json({ error: 'no autorizado' }, 401);
    return c.json({ error: r === 'inactiva' ? 'entrada pausada' : 'sin destino' }, 409);
  });

  // --- Protección CSRF para la API del panel: JSON y mismo origen.
  app.use('/api/*', async (c, next) => {
    // Las apps del agente comparten origen con el panel: una página de /apps/ no usa la API del panel.
    try { if (new URL(c.req.header('referer') ?? '').pathname.startsWith('/apps/')) return c.json({ error: 'No permitido desde una app.' }, 403); } catch {}
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origen = c.req.header('origin');
      if (origen) {
        let host = null;
        try { host = new URL(origen).host; } catch {}
        if (host !== c.req.header('host')) return c.json({ error: 'Origen no permitido.' }, 403);
      }
      if (!String(c.req.header('content-type') ?? '').startsWith('application/json')) {
        return c.json({ error: 'Se espera JSON.' }, 415);
      }
    }
    await next();
  });

  const cuerpo = async (c) => { try { return await c.req.json(); } catch { return {}; } };

  app.get('/api/estado', (c) => {
    if (auth.enSetup()) return c.json({ modo: 'setup', codigoRequerido: !auth.setupSinCodigo?.(), version: VERSION });
    const s = auth.sesionDe(getCookie(c, COOKIE));
    if (!s) return c.json({ modo: 'login', version: VERSION });
    const secciones = Object.fromEntries(Object.entries(SECCIONES_PANEL).map(([k, v]) => [k, { nombre: v.nombre, detalle: v.detalle }]));
    return c.json({ modo: 'panel', version: VERSION, usuario: { email: s.email, nombre: s.nombre, rol: s.rol, accesos: accesosDe(s) }, secciones });
  });

  // --- Invitaciones al panel (sin sesión: el link es la credencial, de un solo uso).
  app.post('/api/invitacion/ver', async (c) => {
    const i = auth.verInvitacion((await cuerpo(c)).invitacion);
    const nombres = i.accesos === 'todo' ? ['Todo el panel'] : i.accesos.map((s) => SECCIONES_PANEL[s]?.nombre ?? s);
    return c.json({ nombre: i.nombre, accesos: nombres });
  });
  app.post('/api/invitacion/iniciar', async (c) => c.json(await auth.iniciarInvitacion(await cuerpo(c), ipDe(c))));
  app.post('/api/invitacion/confirmar', async (c) => {
    const { recuperacion, sesion } = auth.confirmarInvitacion(await cuerpo(c), meta(c));
    ponerCookie(c, sesion);
    return c.json({ recuperacion });
  });

  // --- Setup del Propietario.
  app.post('/api/setup/codigo', async (c) => {
    auth.verificarCodigoSetup((await cuerpo(c)).codigo, ipDe(c));
    return c.json({ ok: true });
  });
  app.post('/api/setup/iniciar', async (c) => c.json(await auth.iniciarSetup(await cuerpo(c), ipDe(c))));
  app.post('/api/setup/confirmar', async (c) => {
    const { recuperacion, sesion } = auth.confirmarSetup(await cuerpo(c), meta(c));
    ponerCookie(c, sesion);
    return c.json({ ok: true, recuperacion });
  });

  // --- Login.
  app.post('/api/auth/login', async (c) => {
    if (auth.enSetup()) return c.json({ error: 'Primero hay que completar el setup.' }, 409);
    ponerCookie(c, auth.login(await cuerpo(c), meta(c)));
    return c.json({ ok: true });
  });
  // --- Recuperación de acceso (TEORIA §4.4). Públicas, con límite de intentos y siempre con dos factores.
  app.post('/api/recuperar/contrasena', async (c) => c.json(auth.recuperarContrasena(await cuerpo(c), meta(c))));
  app.post('/api/recuperar/whatsapp/pedir', async (c) => c.json(await auth.pedirCodigoWhatsapp(await cuerpo(c), meta(c))));
  app.post('/api/recuperar/whatsapp/confirmar', async (c) => c.json(auth.recuperarContrasenaPorWhatsapp(await cuerpo(c), meta(c))));
  app.post('/api/recuperar/totp/iniciar', async (c) => c.json(await auth.iniciarNuevoTotp(await cuerpo(c), meta(c))));
  app.post('/api/recuperar/totp/confirmar', async (c) => c.json(auth.confirmarNuevoTotp(await cuerpo(c))));

  app.post('/api/auth/logout', (c) => {
    auth.cerrarSesion(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // --- De acá en adelante, solo con sesión web.
  const conSesion = async (c, next) => {
    const s = c.env?.sesionInterna ?? auth.sesionDe(getCookie(c, COOKIE));
    if (!s) return c.json({ error: 'Sesión vencida.' }, 401);
    c.set('sesion', s);
    await next();
  };
  // Cada usuario del panel ve lo suyo: el Propietario todo; un invitado, las secciones que le dieron.
  const soloPropietario = async (c, next) => {
    if (!puedeRuta(accesosDe(c.get('sesion')), c.req.path)) return c.json({ error: 'No tenés acceso a esta sección.' }, 403);
    await next();
  };
  app.use('/api/auth/sesiones', conSesion);
  app.use('/api/auth/cerrar-otras', conSesion);
  app.use('/api/whatsapp/*', conSesion, soloPropietario);
  app.use('/api/claude/*', conSesion, soloPropietario);
  for (const p of PREFIJOS_PANEL) {
    app.use(p, conSesion, soloPropietario);
    app.use(`${p}/*`, conSesion, soloPropietario);
  }
  for (const p of ['/api/invitaciones', '/api/usuarios-panel']) {
    app.use(p, conSesion, soloPropietario);
    app.use(`${p}/*`, conSesion, soloPropietario);
  }
  app.get('/api/invitaciones', (c) => c.json(auth.listarInvitaciones()));
  app.post('/api/invitaciones', async (c) => {
    const b = await cuerpo(c);
    const { id, token: t } = auth.crearInvitacion({ nombre: b.nombre, accesos: b.accesos, creadaPor: c.get('sesion').email });
    return c.json({ id, link: `${config.publicUrl}/#invitacion=${t}` });
  });
  app.delete('/api/invitaciones/:id', (c) => c.json({ ok: auth.revocarInvitacion(Number(c.req.param('id')), c.get('sesion').email) }));
  app.delete('/api/usuarios-panel/:id', (c) => {
    if (Number(c.req.param('id')) === c.get('sesion').usuario_id) return c.json({ error: 'No podés quitarte a vos.' }, 409);
    return c.json({ ok: auth.quitarUsuario(Number(c.req.param('id')), c.get('sesion').email) });
  });
  montarPanel(app, { db, nucleo, config, cuerpo });

  app.get('/api/auth/sesiones', (c) => {
    const s = c.get('sesion');
    return c.json({ sesiones: auth.listarSesiones(s.usuario_id, s.id), codigosRestantes: auth.codigosRestantes(s.usuario_id) });
  });
  app.post('/api/auth/cerrar-otras', (c) => {
    const s = c.get('sesion');
    return c.json({ cerradas: auth.cerrarOtras(s.usuario_id, s.id) });
  });

  // --- WhatsApp.
  let ultimoAsegurar = 0;
  app.get('/api/whatsapp/estado', async (c) => {
    let e = await waha.estado();
    if ((e.status === 'NO_CREADA' || e.status === 'STOPPED' || e.status === 'FAILED') && Date.now() - ultimoAsegurar > 10_000) {
      ultimoAsegurar = Date.now();
      await waha.asegurar();
      e = await waha.estado();
    }
    return c.json(e);
  });
  app.get('/api/whatsapp/qr', async (c) => {
    const { tipo, datos } = await waha.qr();
    return c.body(datos, 200, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  });
  app.post('/api/whatsapp/codigo', async (c) => {
    const tel = normalizarTelefono((await cuerpo(c)).telefono);
    if (!tel) return c.json({ error: 'Número inválido. Escribilo con código de país, por ejemplo 5491112345678.' }, 400);
    const r = await waha.pedirCodigo(tel);
    auditar(db, 'whatsapp.codigo_vinculacion', { actor: c.get('sesion').email, rol: 'Propietario' });
    return c.json(r);
  });
  app.post('/api/whatsapp/desvincular', async (c) => {
    await waha.desvincular();
    auditar(db, 'whatsapp.desvincular', { actor: c.get('sesion').email, rol: 'Propietario' });
    return c.json({ ok: true });
  });
  app.post('/api/whatsapp/reiniciar', async (c) => {
    await waha.reiniciar();
    return c.json({ ok: true });
  });

  // --- Otros números de WhatsApp. Acá solo se vinculan; qué hace cada uno se define conversando con el agente.
  const numeros = nucleo.numeros;
  const clienteDe = (c) => {
    const n = c.req.param('nombre');
    if (!numeros?.obtener(n)) throw Object.assign(new Error('Ese número no existe.'), { status: 404 });
    return numeros.cliente(n);
  };
  app.get('/api/whatsapp/numeros', async (c) => {
    const lista = await Promise.all(numeros.listar().map(async (f) => {
      let estado = null;
      try { estado = (await numeros.cliente(f.nombre).estado()).status; } catch {}
      return { nombre: f.nombre, etiqueta: f.etiqueta, numero: f.numero, principal: f.principal, estado, politica: f.politica, fuera_de_alcance: f.fuera_de_alcance };
    }));
    return c.json({ numeros: lista, compartidos: numeros.compartidos() });
  });
  // Sumar o quitar números es de quien tiene acceso total; con acceso a WhatsApp se pueden vincular los que hay.
  const soloTodo = (c) => (accesosDe(c.get('sesion')) === 'todo' ? null : c.json({ error: 'Sumar o quitar números es del Propietario.' }, 403));
  app.post('/api/whatsapp/numeros', async (c) => {
    const no = soloTodo(c); if (no) return no;
    const b = await cuerpo(c);
    const nombre = await numeros.crear({ nombre: b.nombre, etiqueta: b.etiqueta });
    auditar(db, 'whatsapp.numero.alta', { actor: c.get('sesion').email, rol: 'Propietario', detalle: { nombre } });
    return c.json({ nombre });
  });
  app.delete('/api/whatsapp/numeros/:nombre', async (c) => {
    const no = soloTodo(c); if (no) return no;
    await numeros.borrar(c.req.param('nombre'));
    return c.json({ ok: true });
  });
  app.get('/api/whatsapp/numeros/:nombre/estado', async (c) => {
    const w = clienteDe(c);
    let e = await w.estado();
    if (e.status === 'NO_CREADA' || e.status === 'STOPPED' || e.status === 'FAILED') { await w.asegurar(); e = await w.estado(); }
    if (e.status === 'WORKING') nucleo.alVincularNumero?.(c.req.param('nombre'));
    return c.json(e);
  });
  app.get('/api/whatsapp/numeros/:nombre/qr', async (c) => {
    const { tipo, datos } = await clienteDe(c).qr();
    return c.body(datos, 200, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  });
  app.post('/api/whatsapp/numeros/:nombre/codigo', async (c) => {
    const tel = normalizarTelefono((await cuerpo(c)).telefono);
    if (!tel) return c.json({ error: 'Número inválido. Escribilo con código de país, por ejemplo 5491112345678.' }, 400);
    return c.json(await clienteDe(c).pedirCodigo(tel));
  });
  app.post('/api/whatsapp/numeros/:nombre/desvincular', async (c) => {
    await clienteDe(c).desvincular();
    auditar(db, 'whatsapp.desvincular', { actor: c.get('sesion').email, rol: 'Propietario', detalle: { nombre: c.req.param('nombre') } });
    return c.json({ ok: true });
  });
  app.post('/api/whatsapp/numeros/:nombre/reiniciar', async (c) => {
    await clienteDe(c).reiniciar();
    return c.json({ ok: true });
  });

  // --- Claude.
  app.get('/api/claude/estado', async (c) => {
    const e = await claude.estado();
    if (e.conectado) nucleo.motor.desbloquear();
    return c.json(e);
  });
  app.get('/api/claude/uso', async (c) => c.json(await nucleo.consumo.resumen()));
  app.post('/api/claude/probar', async (c) => c.json(await claude.probar()));
  app.post('/api/claude/desconectar', async (c) => {
    claude.cerrarTerminal();
    const r = await claude.desconectar();
    auditar(db, 'claude.desconectar', { actor: c.get('sesion').email, rol: 'Propietario' });
    return c.json(r);
  });

  // Login guiado (sin terminal): link de autorización → la persona pega el código → token guardado.
  app.post('/api/claude/login', async (c) => {
    const actor = c.get('sesion').email;
    try {
      const r = await claude.iniciarLogin({
        alToken: () => { nucleo.motor.desbloquear(); auditar(db, 'claude.token_guardado', { actor, rol: 'Propietario' }); },
      });
      auditar(db, 'claude.login_guiado', { actor, rol: 'Propietario' });
      return c.json({ url: r.url });
    } catch (e) {
      return c.json({ error: e.message }, 502);
    }
  });
  app.post('/api/claude/login/codigo', async (c) => {
    try {
      return c.json(await claude.enviarCodigoLogin((await cuerpo(c)).codigo));
    } catch (e) {
      return c.json({ error: e.message }, 400);
    }
  });
  app.post('/api/claude/login/cancelar', (c) => { claude.cancelarLogin(); return c.json({ ok: true }); });

  if (upgradeWebSocket) {
    // Terminal web para `claude setup-token`. Mismo origen y sesión del Propietario.
    app.get('/api/claude/terminal', async (c, next) => {
      const origen = c.req.header('origin');
      let host = null;
      try { host = new URL(origen).host; } catch {}
      if (host !== c.req.header('host')) return c.json({ error: 'Origen no permitido.' }, 403);
      await next();
    }, upgradeWebSocket((c) => {
      const cols = Math.min(Math.max(Number(c.req.query('cols')) || 100, 20), 300);
      const rows = Math.min(Math.max(Number(c.req.query('rows')) || 30, 5), 120);
      const actor = c.get('sesion')?.email;
      let t = null;
      return {
        onOpen(_e, ws) {
          auditar(db, 'claude.terminal_login', { actor, rol: 'Propietario' });
          try {
            t = claude.abrirTerminal({
              cols, rows,
              alDatos: (d) => ws.send(JSON.stringify({ t: 'd', d })),
              alSalir: (codigo) => { ws.send(JSON.stringify({ t: 'fin', codigo })); ws.close(); },
              alToken: () => { nucleo.motor.desbloquear(); auditar(db, 'claude.token_guardado', { actor, rol: 'Propietario' }); },
            });
          } catch (e) {
            ws.send(JSON.stringify({ t: 'd', d: `\r\n${e.message}\r\n` }));
            ws.close();
          }
        },
        onMessage(e) {
          let m;
          try { m = JSON.parse(String(e.data)); } catch { return; }
          if (m.t === 'd' && typeof m.d === 'string') t?.escribir(m.d);
          if (m.t === 'r') t?.redimensionar(Math.min(Math.max(Number(m.cols) || 100, 20), 300), Math.min(Math.max(Number(m.rows) || 30, 5), 120));
        },
        onClose() { t?.cerrar(); },
      };
    }));
  }

  // --- La SPA del panel (compilada por Vite).
  const indice = path.join(config.webDist, 'index.html');
  if (fs.existsSync(indice)) {
    const raiz = config.webDist;
    app.use('/assets/*', serveStatic({ root: raiz, onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable') }));
    app.use('*', serveStatic({ root: raiz }));
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api/')) return c.json({ error: 'No existe.' }, 404);
      return c.html(fs.readFileSync(indice, 'utf8'));
    });
  } else {
    app.get('/', (c) => c.text('El panel no está compilado. Corré "npm run web:build".', 503));
  }

  // El agente usa la API del panel en nombre de un Propietario (herramienta panel). La sesión va en el entorno de la
  // petición interna: no hay cookie ni header que se pueda falsificar desde afuera.
  nucleo.usarPanel?.(async ({ personaId, metodo, ruta, cuerpo: datos = null }) => {
    const p = db.prepare(`SELECT p.id, p.nombre, r.nombre AS rol FROM personas p JOIN roles r ON r.id = p.rol_id
      WHERE p.id = ? AND p.activa = 1`).get(personaId);
    if (!p || p.rol !== 'Propietario') throw new Error('Solo un Propietario usa el panel a través del agente.');
    const sesionInterna = { id: null, usuario_id: null, email: `agente (por ${p.nombre ?? `persona ${p.id}`})`, persona_id: p.id, accesos: null, nombre: p.nombre, rol: 'Propietario', interna: true };
    const conCuerpo = metodo !== 'GET' && metodo !== 'HEAD';
    const res = await app.request(`http://interno${ruta}`, {
      method: metodo, headers: conCuerpo ? { 'content-type': 'application/json' } : {}, body: conCuerpo ? JSON.stringify(datos ?? {}) : undefined,
    }, { sesionInterna });
    const texto = await res.text();
    let json = texto;
    try { json = JSON.parse(texto); } catch {}
    return { status: res.status, datos: json };
  });

  return app;
}
