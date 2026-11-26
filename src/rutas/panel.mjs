// API del panel para el núcleo: personas y roles, ajustes, chat (onboarding), propuestas, aprobaciones,
// avisos, trabajos, rutinas, entradas y reglas de contacto. Todo requiere sesión del Propietario.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PERMISOS, enPalabras } from '../roles/permisos.mjs';
import { zonaValida, proxima } from '../rutinas/cron.mjs';
import { SECCIONES } from '../servicios/memoria.mjs';
import { auditar } from '../db/index.mjs';
import { json } from '../util.mjs';
import { CATALOGO } from '../conectores/servicio.mjs';
import { CLAVES_PROVEEDOR } from '../engine/opencode.mjs';

const AJUSTES_EDITABLES = {
  nombre_agente: (v) => (v == null || v === '' ? null : String(v).trim().slice(0, 40)),
  zona_horaria: (v) => { if (!zonaValida(v)) throw Object.assign(new Error('Zona horaria inválida.'), { status: 400 }); return v; },
  espera_silencio_s: (v) => String(Math.min(Math.max(Number(v) || 45, 0), 600)),
  espera_maxima_s: (v) => String(Math.min(Math.max(Number(v) || 180, 5), 1800)),
  max_trabajos: (v) => String(Math.min(Math.max(Number(v) || 2, 1), 10)),
  max_corridas: (v) => String(Math.min(Math.max(Number(v) || 3, 1), 20)),
  ritmo_suave: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  ritmo_por_hora: (v) => String(Math.min(Math.max(Number(v) || 4, 1), 120)),
  ritmo_espaciado_min: (v) => String(Math.min(Math.max(Number(v) || 0, 0), 120)),
  instrucciones_extra: (v) => (v == null ? null : String(v).slice(0, 8000)),
  onboarding_hecho: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  navegador: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  describir_imagenes: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  enviar_audio: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
};
const ESFUERZOS = [null, 'low', 'medium', 'high', 'xhigh', 'max'];

export function montarPanel(app, { db, nucleo, config, cuerpo }) {
  const { roles, politica, ajustes, motor, propuestas, aprobaciones, avisos, entradas, verificacion } = nucleo;
  const actor = (c) => {
    const s = c.get('sesion');
    return { personaId: s.persona_id, permisos: politica.rolDe(s.persona_id, 1).permisos };
  };
  const id = (c) => c.req.param('id');

  // --- Resumen para Inicio.
  app.get('/api/resumen', (c) => {
    const s = c.get('sesion');
    const yo = db.prepare('SELECT id, nombre, telefono, verificada FROM personas WHERE id = ?').get(s.persona_id);
    return c.json({
      yo: { ...yo, verificada: !!yo?.verificada, pendiente: yo?.verificada ? null : verificacion.pendiente(s.persona_id) },
      onboardingHecho: ajustes.bool('onboarding_hecho', false),
      nombreAgente: ajustes.get('nombre_agente'),
      avisosSinLeer: db.prepare('SELECT COUNT(*) AS n FROM avisos WHERE leido = 0').get().n,
      propuestas: db.prepare("SELECT COUNT(*) AS n FROM propuestas WHERE estado = 'pendiente'").get().n,
      aprobaciones: db.prepare("SELECT COUNT(*) AS n FROM aprobaciones WHERE estado = 'pendiente'").get().n,
      motor: motor.estado(),
      pausada: motor.pausada(),
    });
  });

  // --- Personas y roles.
  app.get('/api/personas', (c) => c.json({
    personas: roles.listarPersonas(),
    duplicados: roles.duplicados().map(({ queda, quita }) => ({ queda: queda.id, quita: quita.id, nombre: queda.nombre ?? quita.nombre })),
    roles: roles.listarRoles().map((r) => ({ id: r.id, nombre: r.nombre })),
    responderSinAlta: !!db.prepare('SELECT responder_sin_alta FROM cuentas WHERE id = 1').get().responder_sin_alta,
  }));
  app.post('/api/personas', async (c) => {
    const b = await cuerpo(c);
    return c.json({ id: roles.altaPersona(actor(c), { nombre: b.nombre, telefono: b.telefono, rolId: b.rolId }) });
  });
  app.patch('/api/personas/:id', async (c) => {
    const b = await cuerpo(c);
    if (b.nombre !== undefined) roles.editarPersona(actor(c), id(c), { nombre: b.nombre });
    if (b.rolId !== undefined) roles.cambiarRol(actor(c), id(c), b.rolId);
    return c.json({ ok: true });
  });
  app.delete('/api/personas/:id', (c) => { roles.bajaPersona(actor(c), id(c)); return c.json({ ok: true }); });
  // Dos fichas de la misma persona (por ejemplo, una que escribió en un grupo sin número): queda una.
  app.post('/api/personas/:id/fusionar', async (c) => c.json({ id: roles.fusionarPersonas(actor(c), id(c), Number((await cuerpo(c)).con)) }));
  // Onboarding: el número se carga en el panel; el agente le escribe por WhatsApp (ahora o apenas se vincule) y
  // el Propietario confirma respondiendo con el código que se muestra acá.
  app.post('/api/personas/yo/numero', async (c) => {
    let conectado = false;
    try { conectado = (await nucleo.waha?.estado?.())?.status === 'WORKING'; } catch {}
    return c.json(await verificacion.pedirPorRespuesta(c.get('sesion').persona_id, (await cuerpo(c)).telefono, { conectado }));
  });
  app.post('/api/personas/yo/telefono', async (c) => c.json(await verificacion.pedir(c.get('sesion').persona_id, (await cuerpo(c)).telefono)));
  app.post('/api/personas/yo/verificar', async (c) => {
    const s = c.get('sesion');
    const r = verificacion.confirmar(s.persona_id, (await cuerpo(c)).codigo);
    // Recién verificado: el agente le escribe por WhatsApp para arrancar la configuración.
    try { nucleo.iniciarConfiguracion?.(s.persona_id); } catch {}
    return c.json(r);
  });
  app.post('/api/cuenta/pausa', async (c) => {
    const s = c.get('sesion');
    if ((await cuerpo(c)).pausada) motor.pausar(s.persona_id); else motor.reanudar(s.persona_id);
    return c.json({ pausada: motor.pausada() });
  });
  app.post('/api/cuenta/responder-sin-alta', async (c) => {
    const v = (await cuerpo(c)).valor ? 1 : 0;
    db.prepare('UPDATE cuentas SET responder_sin_alta = ? WHERE id = 1').run(v);
    auditar(db, 'cuenta.responder_sin_alta', { actor: c.get('sesion').email, detalle: { valor: v } });
    return c.json({ ok: true });
  });

  app.get('/api/roles', (c) => c.json({
    roles: roles.listarRoles().map((r) => ({ ...r, enPalabras: enPalabras(r.permisos) })),
    catalogo: Object.entries(PERMISOS).map(([k, d]) => ({ permiso: k, nombre: d.nombre, niveles: d.niveles })),
  }));
  app.post('/api/roles', async (c) => c.json({ id: roles.crearRol(actor(c), await cuerpo(c)) }));
  app.patch('/api/roles/:id', async (c) => { roles.editarRol(actor(c), id(c), await cuerpo(c)); return c.json({ ok: true }); });
  app.delete('/api/roles/:id', (c) => { roles.borrarRol(actor(c), id(c)); return c.json({ ok: true }); });

  // --- Ajustes del agente.
  app.get('/api/ajustes', (c) => c.json({
    ajustes: Object.fromEntries(Object.keys(AJUSTES_EDITABLES).map((k) => [k, ajustes.get(k)])),
    modelos: db.prepare('SELECT tipo_corrida, modelo, esfuerzo, permitidos FROM ajustes_modelo').all().map((m) => ({ ...m, permitidos: json(m.permitidos, null) })),
    equipo: db.prepare('SELECT nombre, para_que, modelo, herramientas, activo FROM equipo').all().map((e) => ({ ...e, herramientas: json(e.herramientas, []), activo: !!e.activo })),
  }));
  app.patch('/api/ajustes', async (c) => {
    const b = await cuerpo(c);
    for (const [k, v] of Object.entries(b)) if (AJUSTES_EDITABLES[k]) ajustes.set(k, AJUSTES_EDITABLES[k](v));
    auditar(db, 'ajustes.editar', { actor: c.get('sesion').email, detalle: Object.keys(b) });
    return c.json({ ok: true });
  });
  // --- Motores: qué motor corre cada tipo de conversación, respaldo, topes de gasto y credenciales.
  app.get('/api/motores', (c) => c.json({
    ...nucleo.motores.estado(),
    codex: nucleo.cuentaCodex?.estado() ?? null,
    // Las claves que usan los motores y si ya están cargadas (nunca el valor).
    claves: (() => {
      const hay = new Set(nucleo.entorno.nombres());
      const lista = [['ANTHROPIC_API_KEY', 'claude-api', 'Anthropic'], ['CODEX_API_KEY', 'codex', 'OpenAI'], ['GEMINI_API_KEY', 'gemini', 'Google AI Studio'],
        ...Object.entries(CLAVES_PROVEEDOR).filter(([p]) => p !== 'opencode').map(([p, v]) => [v, 'opencode', p])];
      return lista.map(([nombre, motor, proveedor]) => ({ nombre, motor, proveedor, cargada: hay.has(nombre) }));
    })(),
    modelosClaude: db.prepare('SELECT tipo_corrida, modelo, esfuerzo FROM ajustes_modelo').all(),
  }));
  app.put('/api/motores', async (c) => {
    try { nucleo.motores.configurar(await cuerpo(c)); } catch (e) { return c.json({ error: e.message }, 400); }
    auditar(db, 'motores.configurar', { actor: c.get('sesion').email });
    return c.json({ ok: true, ...nucleo.motores.estado() });
  });
  app.post('/api/motores/codex/login', async (c) => {
    try { return c.json(await nucleo.cuentaCodex.iniciarLogin()); } catch (e) { return c.json({ error: e.message }, 500); }
  });
  app.delete('/api/motores/codex', (c) => { nucleo.cuentaCodex.desconectar(); auditar(db, 'motores.codex_desconectar', { actor: c.get('sesion').email }); return c.json({ ok: true }); });

  app.patch('/api/modelos/:tipo', async (c) => {
    const { modelo, esfuerzo } = await cuerpo(c);
    const m = String(modelo ?? '').trim();
    if (!/^[a-z0-9][a-z0-9.\-[\]]{1,60}$/i.test(m)) return c.json({ error: 'Modelo inválido: usá un alias (opus, sonnet, haiku) o el nombre completo.' }, 400);
    if (!ESFUERZOS.includes(esfuerzo ?? null)) return c.json({ error: 'Esfuerzo inválido.' }, 400);
    const r = db.prepare('UPDATE ajustes_modelo SET modelo = ?, esfuerzo = ? WHERE tipo_corrida = ?').run(m, esfuerzo ?? null, c.req.param('tipo'));
    if (!r.changes) return c.json({ error: 'Tipo de corrida desconocido.' }, 404);
    return c.json({ ok: true });
  });
  app.patch('/api/equipo/:nombre', async (c) => {
    const b = await cuerpo(c);
    if (b.activo !== undefined) db.prepare('UPDATE equipo SET activo = ? WHERE nombre = ?').run(b.activo ? 1 : 0, c.req.param('nombre'));
    if (b.modelo) db.prepare('UPDATE equipo SET modelo = ? WHERE nombre = ?').run(String(b.modelo).slice(0, 60), c.req.param('nombre'));
    return c.json({ ok: true });
  });

  // --- Chats (grupos se activan uno por uno).
  app.get('/api/chats', (c) => c.json({
    chats: db.prepare(`SELECT ch.id, ch.tipo, ch.nombre, ch.activo, ch.cliente_id, p.nombre AS persona, p.telefono,
        (SELECT MAX(recibido) FROM mensajes m WHERE m.chat_id = ch.id) AS ultimo
      FROM chats ch LEFT JOIN personas p ON p.id = ch.persona_id WHERE ch.id NOT LIKE 'panel:%' ORDER BY ultimo DESC LIMIT 200`).all()
      .map((x) => ({ ...x, activo: !!x.activo })),
  }));
  app.patch('/api/chats/:id', async (c) => {
    const b = await cuerpo(c);
    if (b.activo !== undefined) db.prepare('UPDATE chats SET activo = ? WHERE id = ?').run(b.activo ? 1 : 0, id(c));
    if (b.cliente_id !== undefined) {
      if (!db.prepare('SELECT 1 FROM clientes WHERE id = ?').get(Number(b.cliente_id))) return c.json({ error: 'Ese cliente no existe.' }, 404);
      db.prepare('UPDATE chats SET cliente_id = ? WHERE id = ?').run(Number(b.cliente_id), id(c));
    }
    auditar(db, 'chat.activo', { actor: c.get('sesion').email, detalle: { id: id(c), activo: !!b.activo } });
    return c.json({ ok: true });
  });

  const telefonoDe = (ch) => (ch.tipo === 'directo' && /^\d+@c\.us$/.test(ch.id) ? ch.id.split('@')[0] : null);
  // --- Bandeja: las conversaciones de WhatsApp tal como las ve el agente (solo lectura).
  app.get('/api/inbox', (c) => {
    const filas = db.prepare(`SELECT ch.id, ch.tipo, ch.nombre, ch.activo, ch.cliente_id, cl.nombre AS cliente,
        p.nombre AS persona, p.telefono, r.nombre AS rol,
        (SELECT m.nombre_remitente FROM mensajes m WHERE m.chat_id = ch.id AND m.from_me = 0 AND m.nombre_remitente IS NOT NULL ORDER BY m.seq DESC LIMIT 1) AS contacto,
        u.cuerpo AS ultimo_texto, u.from_me AS ultimo_mio, u.tipo AS ultimo_tipo, u.tiene_adjunto AS ultimo_adjunto,
        u.nombre_remitente AS ultimo_remitente, u.recibido AS ultimo,
        (SELECT COUNT(*) FROM mensajes m WHERE m.chat_id = ch.id AND m.from_me = 0 AND m.tipo != 'evento'
           AND m.seq > COALESCE((SELECT CAST(valor AS INTEGER) FROM ajustes WHERE clave = 'inbox_leido:' || ch.id), 0)) AS sin_leer
      FROM chats ch
      LEFT JOIN personas p ON p.id = ch.persona_id
      LEFT JOIN roles r ON r.id = p.rol_id
      LEFT JOIN clientes cl ON cl.id = ch.cliente_id
      LEFT JOIN mensajes u ON u.seq = (SELECT MAX(seq) FROM mensajes m WHERE m.chat_id = ch.id AND m.tipo != 'evento')
      WHERE ch.id NOT LIKE 'panel:%'
      ORDER BY COALESCE(u.recibido, ch.creado, 0) DESC LIMIT 300`).all();
    return c.json({
      chats: filas.map((x) => ({
        ...x, telefono: x.telefono ?? telefonoDe(x), activo: !!x.activo, ultimo_mio: !!x.ultimo_mio, ultimo_adjunto: !!x.ultimo_adjunto,
        ultimo_texto: x.ultimo_texto ? String(x.ultimo_texto).slice(0, 160) : null,
        pensando: motor.corriendoEn(x.id),
      })),
    });
  });
  app.get('/api/inbox/mensajes', (c) => {
    const chatId = String(c.req.query('chat') ?? '');
    const chat = db.prepare(`SELECT ch.id, ch.tipo, ch.nombre, ch.activo, cl.nombre AS cliente, p.nombre AS persona, p.telefono, r.nombre AS rol,
      (SELECT m.nombre_remitente FROM mensajes m WHERE m.chat_id = ch.id AND m.from_me = 0 AND m.nombre_remitente IS NOT NULL ORDER BY m.seq DESC LIMIT 1) AS contacto
      FROM chats ch LEFT JOIN personas p ON p.id = ch.persona_id LEFT JOIN roles r ON r.id = p.rol_id LEFT JOIN clientes cl ON cl.id = ch.cliente_id
      WHERE ch.id = ? AND ch.id NOT LIKE 'panel:%'`).get(chatId);
    if (!chat) return c.json({ error: 'Esa conversación no existe.' }, 404);
    const desde = Number(c.req.query('desde') ?? 0) || 0;
    const mensajes = db.prepare(`SELECT m.seq, m.id AS wid, m.session, m.from_me, m.tipo, m.cuerpo, m.recibido, m.ts, m.nombre_remitente, m.telefono, m.tiene_adjunto, m.media_tipo,
        m.editado, m.borrado, p.nombre AS persona,
        a.id AS adj_id, a.tipo AS adj_tipo, a.mime AS adj_mime, a.nombre AS adj_nombre, a.tamano AS adj_tamano, a.estado AS adj_estado, a.texto AS adj_texto
      FROM mensajes m LEFT JOIN personas p ON p.id = m.persona_id LEFT JOIN adjuntos a ON a.id = (SELECT MIN(id) FROM adjuntos WHERE mensaje_seq = m.seq)
      WHERE m.chat_id = ? AND m.seq > ? AND m.tipo != 'evento' ORDER BY m.seq DESC LIMIT 300`).all(chatId, desde).reverse();
    // Reacciones de la charla, por mensaje (se cruzan por el id final de WhatsApp, que es igual en todos los motores).
    const corto = (id) => String(id ?? '').split('_').pop();
    const reacciones = new Map();
    for (const r of db.prepare("SELECT mensaje_id, de, emoji FROM reacciones WHERE chat_id = ? AND emoji != ''").all(chatId)) {
      const k = corto(r.mensaje_id);
      reacciones.set(k, [...(reacciones.get(k) ?? []), { emoji: r.emoji, propia: r.de === 'yo' }]);
    }
    const lista = mensajes.map(({ wid, session, adj_id: aid, adj_tipo: at, adj_mime: am, adj_nombre: an, adj_tamano: az, adj_estado: ae, adj_texto: ax, ...m }) => ({
      ...m, from_me: !!m.from_me, tiene_adjunto: !!m.tiene_adjunto, editado: !!m.editado, borrado: !!m.borrado,
      cuerpo: m.borrado ? null : m.cuerpo,
      adjunto: aid ? { id: aid, tipo: at, mime: am, nombre: an, tamano: az, estado: ae, texto: ax } : null,
      reacciones: reacciones.get(corto(wid)) ?? [],
    }));
    const pendientes = db.prepare("SELECT id, tipo, contenido, creado, estado FROM salida WHERE chat_id = ? AND estado = 'pendiente' ORDER BY id").all(chatId);
    // Abrir la conversación la marca como leída hasta el último mensaje.
    const tope = db.prepare('SELECT MAX(seq) AS s FROM mensajes WHERE chat_id = ?').get(chatId).s;
    if (tope) ajustes.set(`inbox_leido:${chatId}`, String(tope));
    return c.json({ chat: { ...chat, telefono: chat.telefono ?? telefonoDe(chat), activo: !!chat.activo }, mensajes: lista, pendientes, pensando: motor.corriendoEn(chatId) });
  });

  // Un adjunto de la bandeja. Se muestra en la página solo lo que el navegador no puede ejecutar (fotos sin SVG,
  // audio, video y PDF); lo demás se descarga. Así un archivo que mandó cualquiera no corre en el panel.
  const VISIBLES = /^(image\/(jpeg|png|gif|webp)|audio\/[\w.+-]+|video\/(mp4|webm|ogg|quicktime|3gpp)|application\/pdf)$/;
  app.get('/api/inbox/adjunto/:id', (c) => {
    const a = db.prepare("SELECT a.*, m.chat_id FROM adjuntos a JOIN mensajes m ON m.seq = a.mensaje_seq WHERE a.id = ? AND a.estado = 'listo'").get(Number(id(c)));
    if (!a?.ruta || !fs.existsSync(a.ruta)) return c.json({ error: 'Ese archivo ya no está.' }, 404);
    const mime = String(a.mime ?? '').split(';')[0].trim().toLowerCase();
    const enLinea = VISIBLES.test(mime) && c.req.query('descargar') !== '1';
    const nombre = a.nombre || path.basename(a.ruta).replace(/^\d+-/, '');
    return c.body(fs.readFileSync(a.ruta), 200, {
      'Content-Type': enLinea ? mime : 'application/octet-stream',
      'Content-Disposition': `${enLinea ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(nombre)}`,
      'Cache-Control': 'no-store',
      // Sin scripts ni nada que cargue de afuera; el PDF se puede mostrar dentro del panel.
      'Content-Security-Policy': `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'${mime === 'application/pdf' ? '' : '; sandbox'}`,
      'X-Frame-Options': 'SAMEORIGIN',
    });
  });

  // --- Chat del panel (onboarding y conversación con el agente).
  app.get('/api/chat', (c) => {
    const chatId = `panel:${c.get('sesion').persona_id}`;
    const desde = Number(c.req.query('desde') ?? 0) || 0;
    const mensajes = db.prepare(`SELECT seq, from_me, tipo, cuerpo, recibido FROM mensajes WHERE chat_id = ? AND seq > ? AND tipo != 'evento'
      ORDER BY seq DESC LIMIT 200`).all(chatId, desde).reverse();
    const b = motor.estado().bloqueo;
    return c.json({
      mensajes, pensando: motor.corriendoEn(chatId), onboardingHecho: ajustes.bool('onboarding_hecho', false),
      claudeEnPausa: b && b.hasta > Date.now() ? b.motivo : null,
    });
  });
  app.post('/api/chat', async (c) => {
    const s = c.get('sesion');
    const texto = String((await cuerpo(c)).texto ?? '').trim().slice(0, 8000);
    if (!texto) return c.json({ error: 'El mensaje está vacío.' }, 400);
    const chatId = `panel:${s.persona_id}`;
    const ahora = Date.now();
    db.prepare("INSERT INTO chats (id, tipo, persona_id, cliente_id, activo, nombre, creado) VALUES (?, 'directo', ?, 1, 1, 'Panel', ?) ON CONFLICT(id) DO NOTHING")
      .run(chatId, s.persona_id, ahora);
    const seq = Number(db.prepare(`INSERT INTO mensajes (session, id, chat_id, persona_id, from_me, tipo, cuerpo, ts, procesado, recibido, canal)
      VALUES ('panel', ?, ?, ?, 0, 'chat', ?, ?, 0, ?, 'panel')`).run(`p-${crypto.randomUUID()}`, chatId, s.persona_id, texto, Math.floor(ahora / 1000), ahora).lastInsertRowid);
    await motor.alMensaje({ seq, chatId, personaId: s.persona_id, grupo: false, cuerpo: texto });
    return c.json({ seq });
  });

  // --- Propuestas y aprobaciones.
  app.get('/api/propuestas', (c) => c.json({ propuestas: propuestas.listar({ estado: c.req.query('estado') ?? null }) }));
  app.post('/api/propuestas/:id/confirmar', (c) => c.json(propuestas.confirmar(id(c), actor(c))));
  app.post('/api/propuestas/:id/descartar', (c) => c.json(propuestas.descartar(id(c), actor(c))));
  app.get('/api/aprobaciones', (c) => c.json({ aprobaciones: aprobaciones.listar({ estado: c.req.query('estado') ?? null }) }));
  app.post('/api/aprobaciones/:id/aprobar', async (c) => c.json(await aprobaciones.aprobar(id(c), { personaId: c.get('sesion').persona_id })));
  app.post('/api/aprobaciones/:id/rechazar', async (c) => c.json(await aprobaciones.rechazar(id(c), { personaId: c.get('sesion').persona_id, comentario: String((await cuerpo(c)).comentario ?? '').slice(0, 500) || null })));

  app.get('/api/bitacora', (c) => c.json({ entradas: nucleo.bitacora.listar({ limite: Math.min(Number(c.req.query('limite') ?? 100), 500), antes: c.req.query('antes') ? Number(c.req.query('antes')) : null }) }));
  app.get('/api/avisos', (c) => c.json({ avisos: avisos.listar() }));
  app.post('/api/avisos/leidos', (c) => c.json({ marcados: avisos.marcarLeidos() }));
  app.post('/api/avisos/:id/resolver', (c) => c.json({ ok: !!avisos.resolver(id(c)) }));

  // --- Trabajos, rutinas, entradas y reglas de contacto.
  app.get('/api/trabajos', (c) => c.json({
    trabajos: db.prepare(`SELECT t.id, t.estado, t.descripcion, t.resultado, t.creado, t.inicio, t.fin, t.modelo, p.nombre AS pedido_por
      FROM trabajos t LEFT JOIN personas p ON p.id = t.pedido_por ORDER BY t.numero DESC LIMIT 50`).all(),
  }));
  app.get('/api/rutinas', (c) => c.json({
    rutinas: db.prepare(`SELECT r.*, p.nombre AS creador FROM rutinas r LEFT JOIN personas p ON p.id = r.creada_por ORDER BY r.id DESC`).all()
      .map((r) => ({ ...r, destinos: json(r.destinos, []), activa: !!r.activa, aprobada: !!r.aprobada })),
  }));
  // Alta directa (la hace el Propietario: queda aprobada). Destino: teléfono, JID o "propietario" (su chat).
  app.post('/api/rutinas', async (c) => {
    if (!esDueno(c)) return c.json({ error: 'Solo el Propietario.' }, 403);
    const b = await cuerpo(c);
    const tz = b.zona_horaria || nucleo.ajustes.get('zona_horaria', 'UTC') || 'UTC';
    if (!zonaValida(tz)) return c.json({ error: 'Zona horaria inválida.' }, 400);
    const instruccion = String(b.instruccion ?? '').trim().slice(0, 4000);
    if (!instruccion) return c.json({ error: 'Falta la instrucción.' }, 400);
    let prox;
    try { prox = proxima(String(b.cuando ?? ''), tz, Date.now()); } catch (e) { return c.json({ error: e.message }, 400); }
    const yo = c.get('sesion').persona_id;
    const tel = db.prepare('SELECT telefono FROM personas WHERE id = ?').get(yo)?.telefono;
    const d = String(b.destino ?? 'propietario').trim();
    const destino = d === 'propietario' ? (tel ? `${tel}@c.us` : `panel:${yo}`) : /@(g\.us|c\.us|lid)$/.test(d) ? d : (d.replace(/\D/g, '').length >= 8 ? `${d.replace(/\D/g, '')}@c.us` : null);
    if (!destino) return c.json({ error: 'Destino inválido: teléfono con código de país, JID o "propietario".' }, 400);
    const r = db.prepare(`INSERT INTO rutinas (cuando, zona_horaria, instruccion, creada_por, chat_destino, modelo, activa, proxima, destinos, aprobada, creada)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?)`).run(String(b.cuando), tz, instruccion, yo, destino, b.modelo ?? null, prox, JSON.stringify([destino]), Date.now());
    auditar(db, 'rutina.crear', { actor: c.get('sesion').email, detalle: { id: Number(r.lastInsertRowid) } });
    return c.json({ id: Number(r.lastInsertRowid), proxima: prox });
  });
  app.patch('/api/rutinas/:id', async (c) => {
    const b = await cuerpo(c);
    const r = db.prepare('SELECT * FROM rutinas WHERE id = ?').get(Number(id(c)));
    if (!r) return c.json({ error: 'No existe.' }, 404);
    if (b.activa !== undefined) {
      if (b.activa && !r.aprobada) return c.json({ error: 'Primero hay que aprobarla.' }, 409);
      db.prepare('UPDATE rutinas SET activa = ?, pausa_motivo = ? WHERE id = ?').run(b.activa ? 1 : 0, b.activa ? null : 'Pausada desde el panel.', r.id);
    }
    return c.json({ ok: true });
  });
  app.delete('/api/rutinas/:id', (c) => c.json({ ok: !!db.prepare('DELETE FROM rutinas WHERE id = ?').run(Number(id(c))).changes }));

  app.get('/api/entradas', (c) => c.json({ entradas: entradas.listar(), base: `${config.publicUrl}/entrada/` }));
  app.post('/api/entradas', async (c) => {
    const b = await cuerpo(c);
    const e = entradas.crear({ nombre: b.nombre, instruccion: b.instruccion, creadaPor: c.get('sesion').persona_id });
    return c.json({ ...e, url: `${config.publicUrl}/entrada/${e.id}` });
  });
  app.patch('/api/entradas/:id', async (c) => c.json({ ok: !!entradas.activar(id(c), (await cuerpo(c)).activa) }));
  app.delete('/api/entradas/:id', (c) => c.json({ ok: !!entradas.borrar(id(c)) }));

  app.get('/api/reglas', (c) => c.json({ reglas: db.prepare('SELECT * FROM reglas_contacto ORDER BY id DESC').all().map((r) => ({ ...r, activa: !!r.activa })) }));
  app.post('/api/reglas', async (c) => {
    const b = await cuerpo(c);
    const origen = String(b.origen ?? '').trim();
    if (!/^(\*|entrada:[\w-]+|rutina:\d+)$/.test(origen)) return c.json({ error: 'Origen inválido: "*", "entrada:<id>" o "rutina:<n>".' }, 400);
    const aQuien = b.a_quien === '*' ? '*' : JSON.stringify((Array.isArray(b.a_quien) ? b.a_quien : String(b.a_quien ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean));
    const r = db.prepare('INSERT INTO reglas_contacto (origen, a_quien, mensaje_base, aprobada_por, activa, creada) VALUES (?, ?, ?, ?, 1, ?)')
      .run(origen, aQuien, String(b.mensaje_base ?? '').slice(0, 2000) || null, c.get('sesion').persona_id, Date.now());
    auditar(db, 'regla_contacto.crear', { actor: c.get('sesion').email, detalle: { origen } });
    return c.json({ id: Number(r.lastInsertRowid) });
  });
  app.patch('/api/reglas/:id', async (c) => c.json({ ok: !!db.prepare('UPDATE reglas_contacto SET activa = ? WHERE id = ?').run((await cuerpo(c)).activa ? 1 : 0, Number(id(c))).changes }));
  app.delete('/api/reglas/:id', (c) => c.json({ ok: !!db.prepare('DELETE FROM reglas_contacto WHERE id = ?').run(Number(id(c))).changes }));

  app.get('/api/lecciones', (c) => c.json({ lecciones: db.prepare('SELECT l.*, p.nombre AS autor_nombre FROM lecciones l LEFT JOIN personas p ON p.id = l.autor ORDER BY l.id DESC').all().map((l) => ({ ...l, publica: !!l.publica })) }));
  app.post('/api/lecciones', async (c) => {
    const b = await cuerpo(c);
    const regla = String(b.regla ?? '').trim().slice(0, 500);
    if (regla.length < 3) return c.json({ error: 'La regla está vacía.' }, 400);
    const r = db.prepare("INSERT INTO lecciones (regla, porque, como_aplicar, publica, autor, estado, creada) VALUES (?, ?, ?, ?, ?, 'activa', ?)")
      .run(regla, String(b.porque ?? '').slice(0, 800) || null, String(b.como_aplicar ?? '').slice(0, 800) || null, b.publica ? 1 : 0, c.get('sesion').persona_id, Date.now());
    return c.json({ id: Number(r.lastInsertRowid) });
  });
  app.patch('/api/lecciones/:id', async (c) => {
    const b = await cuerpo(c);
    const l = db.prepare('SELECT * FROM lecciones WHERE id = ?').get(Number(id(c)));
    if (!l) return c.json({ error: 'No existe.' }, 404);
    db.prepare('UPDATE lecciones SET regla = ?, como_aplicar = ?, publica = ?, estado = ? WHERE id = ?').run(
      b.regla !== undefined ? String(b.regla).trim().slice(0, 500) : l.regla,
      b.como_aplicar !== undefined ? String(b.como_aplicar).slice(0, 800) : l.como_aplicar,
      b.publica !== undefined ? (b.publica ? 1 : 0) : l.publica,
      ['activa', 'desactivada'].includes(b.estado) ? b.estado : l.estado, l.id);
    auditar(db, 'leccion.editar', { actor: c.get('sesion').email, detalle: { id: l.id } });
    return c.json({ ok: true });
  });
  app.delete('/api/lecciones/:id', (c) => c.json({ ok: !!db.prepare('DELETE FROM lecciones WHERE id = ?').run(Number(id(c))).changes }));

  // --- Conectores MCP remotos.
  const { conectores } = nucleo;
  app.get('/api/conectores', (c) => { const entorno = nucleo.logins?.detectar() ?? []; return c.json({ conectores: conectores.listar({ resueltos: entorno.filter((e) => e.conectado).map((e) => e.servicio) }), entorno, catalogo: CATALOGO, roles: roles.listarRoles().map((r) => r.nombre) }); });
  app.post('/api/conectores', async (c) => {
    const b = await cuerpo(c);
    const s = c.get('sesion');
    const idc = conectores.crear({ nombre: b.nombre, url: b.url, auth: b.auth === 'clave' ? 'clave' : 'oauth', clave: b.clave, creadoPor: s.persona_id });
    if (b.auth === 'clave') { await conectores.actualizarHerramientas(idc).catch(() => {}); db.prepare("UPDATE conexiones SET estado = 'activa' WHERE id = ? AND estado = 'pendiente'").run(idc); return c.json({ id: idc }); }
    const link = await conectores.autorizar(idc, { chatAviso: `panel:${s.persona_id}` }).catch((e) => { throw Object.assign(new Error(`No se pudo iniciar la autorización: ${e.message}`), { status: 409 }); });
    return c.json({ id: idc, link });
  });
  app.post('/api/conectores/:id/autorizar', async (c) => c.json({ link: await conectores.autorizar(id(c), { chatAviso: `panel:${c.get('sesion').persona_id}` }) }));
  app.post('/api/conectores/:id/actualizar', async (c) => {
    try { return c.json({ herramientas: await conectores.actualizarHerramientas(id(c)) }); } catch (e) { return c.json({ error: e.message }, 502); }
  });
  app.patch('/api/conectores/:id', async (c) => { conectores.configurar(id(c), await cuerpo(c)); return c.json({ ok: true }); });
  app.delete('/api/conectores/:id', (c) => c.json({ ok: !!conectores.borrar(id(c)) }));

  // --- Proyectos (repos) y GitHub.
  const { github, publicador } = nucleo;
  app.get('/api/proyectos', (c) => c.json({
    proyectos: db.prepare('SELECT p.*, cl.nombre AS cliente FROM proyectos p LEFT JOIN clientes cl ON cl.id = p.cliente_id ORDER BY p.id').all(),
    github: { conectado: github.conectado(), origen: github.origen?.() ?? null, usuario: nucleo.logins?.usuarioGithub() ?? null, dispositivo: !!config.github?.clientId },
  }));
  app.post('/api/proyectos', async (c) => {
    const b = await cuerpo(c);
    const nombre = String(b.nombre ?? '').trim().slice(0, 60);
    const repo = String(b.repo ?? '').trim();
    if (nombre.length < 2) return c.json({ error: 'El proyecto necesita un nombre.' }, 400);
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return c.json({ error: 'El repo va como dueño/nombre (por ejemplo miorg/sitio).' }, 400);
    const rama = String(b.rama_principal ?? 'main').trim() || 'main';
    const r = db.prepare('INSERT INTO proyectos (cliente_id, nombre, repo, rama_principal, estado, creado) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Number(b.cliente_id) || 1, nombre, repo || null, rama, 'activo', Date.now());
    auditar(db, 'proyecto.crear', { actor: c.get('sesion').email, detalle: { nombre, repo } });
    return c.json({ id: Number(r.lastInsertRowid) });
  });
  // Procedimiento de publicación (versionado), credenciales (solo nombres) y publicaciones.
  const { procedimientos } = nucleo;
  app.get('/api/proyectos/:id/publicacion', (c) => {
    const p = db.prepare('SELECT id, nombre, procedimiento_publicacion, procedimiento_version, dominios FROM proyectos WHERE id = ?').get(Number(id(c)));
    if (!p) return c.json({ error: 'No existe.' }, 404);
    return c.json({
      procedimiento: json(p.procedimiento_publicacion, null), version: p.procedimiento_version, dominios: json(p.dominios, []),
      credenciales: procedimientos.listarCredenciales(p.id),
      publicaciones: db.prepare('SELECT id, estado, resultado, pasos, inicio, fin, procedimiento_version FROM publicaciones WHERE proyecto_id = ? ORDER BY id DESC LIMIT 20').all(p.id).map((x) => ({ ...x, pasos: json(x.pasos, []) })),
    });
  });
  app.put('/api/proyectos/:id/procedimiento', async (c) => {
    const b = await cuerpo(c);
    return c.json({ version: procedimientos.guardar(Number(id(c)), { procedimiento: b.procedimiento, dominios: b.dominios }, c.get('sesion').persona_id) });
  });
  app.post('/api/proyectos/:id/credenciales', async (c) => {
    procedimientos.guardarCredencial(Number(id(c)), await cuerpo(c), c.get('sesion').persona_id);
    return c.json({ ok: true });
  });
  app.delete('/api/credenciales/:id', (c) => c.json({ ok: !!procedimientos.borrarCredencial(id(c)) }));

  app.delete('/api/proyectos/:id',(c) => c.json({ ok: !!db.prepare('DELETE FROM proyectos WHERE id = ?').run(Number(id(c))).changes }));
  app.post('/api/github/token', async (c) => {
    const t = String((await cuerpo(c)).token ?? '').trim();
    if (!/^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}$/.test(t)) return c.json({ error: 'Eso no parece un token de GitHub.' }, 400);
    github.guardarToken(t, { conectadaPor: c.get('sesion').persona_id, metodo: 'token_pegado' });
    return c.json({ ok: true });
  });
  app.post('/api/github/dispositivo', async (c) => {
    const s = c.get('sesion');
    await github.conectarPorDispositivo({ chatId: nucleo.chatDePersona(s.persona_id) ?? `panel:${s.persona_id}`, personaId: s.persona_id });
    return c.json({ ok: true });
  });
  app.post('/api/github/desconectar', (c) => { github.desconectar(); return c.json({ ok: true }); });

  // --- Versiones de las instrucciones del agente.
  app.get('/api/instrucciones', (c) => c.json({ versiones: db.prepare('SELECT i.version, i.contenido, i.activa, p.nombre AS pedida_por FROM instrucciones i LEFT JOIN personas p ON p.id = i.pedida_por ORDER BY i.version DESC').all().map((v) => ({ ...v, activa: !!v.activa })) }));
  app.post('/api/instrucciones', async (c) => {
    const contenido = String((await cuerpo(c)).contenido ?? '').slice(0, 20_000);
    const v = (db.prepare('SELECT MAX(version) AS v FROM instrucciones').get().v ?? 0) + 1;
    db.prepare('INSERT INTO instrucciones (version, contenido, pedida_por, activa) VALUES (?, ?, ?, 0)').run(v, contenido, c.get('sesion').persona_id);
    return c.json({ version: v, mensaje: publicador.activarInstrucciones(v, c.get('sesion').persona_id) });
  });
  app.post('/api/instrucciones/:id/activar', (c) => c.json({ mensaje: publicador.activarInstrucciones(Number(id(c)), c.get('sesion').persona_id) }));

  // --- Archivos que el agente mandó al chat del panel.
  app.get('/api/archivos/:id', (c) => {
    const a = nucleo.archivos.obtener(id(c));
    if (!a || (a.chat_id && a.chat_id !== `panel:${c.get('sesion').persona_id}`)) return c.json({ error: 'No existe.' }, 404);
    return c.body(nucleo.archivos.leer(a), 200, {
      'Content-Type': a.mime ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(a.nombre)}"`,
      'Cache-Control': 'no-store',
    });
  });

  // --- Clientes (7e): grupos, proyectos, autonomía y roles por cliente.
  const AUTONOMIAS = ['via_libre', 'consultar_lo_importante', 'consultar_todo'];
  // --- Sesiones de proyecto (8d).
  app.get('/api/sesiones', (c) => c.json({ sesiones: nucleo.sesiones.listar() }));
  app.patch('/api/sesiones/:id', async (c) => { nucleo.sesiones.cambiarEstado(id(c), (await cuerpo(c)).estado); return c.json({ ok: true }); });
  app.get('/api/sesiones/:id/buzon', (c) => c.json({ buzon: db.prepare('SELECT id, de, tipo, contenido, estado, creado FROM buzon WHERE sesion_id = ? ORDER BY id DESC LIMIT 50').all(Number(id(c))) }));

  app.get('/api/clientes', (c) => c.json({
    clientes: db.prepare('SELECT * FROM clientes ORDER BY tipo DESC, id').all().map((cl) => ({
      ...cl,
      chats: db.prepare("SELECT id, nombre, tipo, activo FROM chats WHERE cliente_id = ? AND id NOT LIKE 'panel:%' ORDER BY nombre").all(cl.id),
      proyectos: db.prepare('SELECT id, nombre, repo FROM proyectos WHERE cliente_id = ? ORDER BY nombre').all(cl.id),
      roles: db.prepare('SELECT pc.persona_id, pc.rol_id, p.nombre, p.telefono, r.nombre AS rol FROM persona_cliente pc JOIN personas p ON p.id = pc.persona_id JOIN roles r ON r.id = pc.rol_id WHERE pc.cliente_id = ?').all(cl.id),
    })),
    grupos: db.prepare("SELECT id, nombre, cliente_id FROM chats WHERE tipo = 'grupo' ORDER BY nombre").all(),
  }));
  app.post('/api/clientes', async (c) => {
    const b = await cuerpo(c);
    const nombre = String(b.nombre ?? '').trim().slice(0, 80);
    if (nombre.length < 2) return c.json({ error: 'El cliente necesita un nombre.' }, 400);
    const r = db.prepare("INSERT INTO clientes (nombre, tipo, autonomia, estado, creado_por) VALUES (?, 'cliente', ?, 'activo', ?)")
      .run(nombre, AUTONOMIAS.includes(b.autonomia) ? b.autonomia : 'consultar_lo_importante', c.get('sesion').persona_id);
    auditar(db, 'cliente.crear', { actor: c.get('sesion').email, detalle: { nombre } });
    return c.json({ id: Number(r.lastInsertRowid) });
  });
  app.patch('/api/clientes/:id', async (c) => {
    const b = await cuerpo(c);
    const cl = db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(id(c)));
    if (!cl) return c.json({ error: 'No existe.' }, 404);
    db.prepare('UPDATE clientes SET nombre = ?, autonomia = ?, estado = ? WHERE id = ?').run(
      b.nombre ? String(b.nombre).trim().slice(0, 80) : cl.nombre,
      AUTONOMIAS.includes(b.autonomia) ? b.autonomia : cl.autonomia,
      ['activo', 'archivado'].includes(b.estado) && cl.tipo !== 'propio' ? b.estado : cl.estado, cl.id);
    auditar(db, 'cliente.editar', { actor: c.get('sesion').email, detalle: { id: cl.id } });
    return c.json({ ok: true });
  });
  // --- Variables de entorno del Propietario: se cargan acá, nunca por el chat. El valor no vuelve a salir.
  const esDueno = (c) => nucleo.politica.para({ personaId: c.get('sesion').persona_id, clienteId: 1 }).decidir('aprobar').decision === 'permitir';
  // --- Memoria: leer, agregar y borrar (por alcance y sección).
  app.get('/api/memoria', (c) => {
    if (!esDueno(c)) return c.json({ error: 'Solo el Propietario.' }, 403);
    const alcance = c.req.query('alcance');
    const filas = alcance
      ? db.prepare('SELECT * FROM memoria WHERE alcance = ? ORDER BY id').all(alcance)
      : db.prepare('SELECT * FROM memoria ORDER BY id').all();
    return c.json({ memoria: filas.map((m) => ({ ...m, publica: !!m.publica })), secciones: SECCIONES });
  });
  app.post('/api/memoria', async (c) => {
    if (!esDueno(c)) return c.json({ error: 'Solo el Propietario.' }, 403);
    const b = await cuerpo(c);
    if (!['cuenta', 'cliente', 'proyecto', 'contacto'].includes(b.alcance)) return c.json({ error: 'Alcance inválido.' }, 400);
    if (b.alcance !== 'cuenta' && !Number(b.alcance_id)) return c.json({ error: 'Falta alcance_id.' }, 400);
    const texto = String(b.contenido ?? '');
    if (texto.length > 4000) return c.json({ error: 'Cada nota va hasta 4000 caracteres: partila.' }, 400);
    try {
      return c.json({ id: nucleo.memoria.guardar({ alcance: b.alcance, alcanceId: b.alcance === 'cuenta' ? null : Number(b.alcance_id), seccion: b.seccion, contenido: texto, autor: c.get('sesion').persona_id, publica: !!b.publica }) });
    } catch (e) { return c.json({ error: e.message }, 400); }
  });
  app.delete('/api/memoria/:id', (c) => {
    if (!esDueno(c)) return c.json({ error: 'Solo el Propietario.' }, 403);
    return c.json({ ok: !!db.prepare('DELETE FROM memoria WHERE id = ?').run(Number(id(c))).changes });
  });

  // --- Paquetes: ensayar, importar y exportar (docs/IMPORTAR.md). Nunca llevan valores de secretos.
  const actorDueno = (c) => ({ personaId: c.get('sesion').persona_id, permisos: nucleo.politica.rolDe(c.get('sesion').persona_id, 1).permisos });
  const conPaquete = (fn) => async (c) => {
    if (!esDueno(c)) return c.json({ error: 'Solo el Propietario.' }, 403);
    const b = await cuerpo(c);
    try { const plan = fn(b.paquete ?? b, actorDueno(c)); return c.json({ plan, resumen: nucleo.paquetes.resumen(plan) }); }
    catch (e) { return c.json({ error: e.message, errores: e.errores ?? [] }, e.status ?? 400); }
  };
  app.post('/api/paquetes/ensayar', conPaquete((p, a) => nucleo.paquetes.ensayar(p, a)));
  app.post('/api/paquetes/importar', conPaquete((p, a) => nucleo.paquetes.importar(p, a)));
  app.get('/api/paquetes/exportar', (c) => {
    if (!esDueno(c)) return c.json({ error: 'Solo el Propietario.' }, 403);
    auditar(db, 'paquete.exportar', { actor: c.get('sesion').email });
    return c.json(nucleo.paquetes.exportar());
  });

  app.get('/api/entorno', (c) => {
    if (!esDueno(c)) return c.json({ error: 'Solo el Propietario.' }, 403);
    return c.json({ variables: nucleo.entorno.listar() });
  });
  app.get('/api/entorno/pedido/:id', (c) => {
    if (!esDueno(c)) return c.json({ error: 'Solo el Propietario.' }, 403);
    const p = nucleo.entorno.pedido(id(c));
    return p ? c.json({ nombre: p.nombre, para: p.para }) : c.json({ error: 'El pedido venció o ya se usó.' }, 404);
  });
  app.post('/api/entorno', async (c) => {
    if (!esDueno(c)) return c.json({ error: 'Solo el Propietario.' }, 403);
    const b = await cuerpo(c);
    const pedido = b.pedido ? nucleo.entorno.pedido(String(b.pedido)) : null;
    let nombre;
    try {
      nombre = nucleo.entorno.guardar(pedido?.nombre ?? b.nombre, b.valor, { descripcion: b.descripcion ?? pedido?.para ?? null, quien: c.get('sesion').persona_id });
    } catch (e) { return c.json({ error: e.message }, 400); }
    auditar(db, 'entorno.guardar', { actor: c.get('sesion').email, detalle: { nombre } });
    if (pedido) {
      nucleo.entorno.cerrarPedido(pedido.id);
      if (pedido.chatId) nucleo.motor.despertar({ chatId: pedido.chatId, personaId: c.get('sesion').persona_id, texto: `[variable ${nombre} cargada] Ya está en tu entorno. Seguí con lo que estabas haciendo.`, origen: 'entorno' });
    }
    return c.json({ ok: true, nombre });
  });
  app.delete('/api/entorno/:nombre', (c) => {
    if (!esDueno(c)) return c.json({ error: 'Solo el Propietario.' }, 403);
    try {
      const ok = nucleo.entorno.borrar(c.req.param('nombre'));
      auditar(db, 'entorno.borrar', { actor: c.get('sesion').email, detalle: { nombre: c.req.param('nombre') } });
      return c.json({ ok });
    } catch (e) { return c.json({ error: e.message }, 400); }
  });

  app.post('/api/clientes/:id/roles', async (c) => {
    const b = await cuerpo(c);
    roles.asignarEnCliente(actor(c), Number(b.personaId), Number(id(c)), b.rolId == null ? null : Number(b.rolId));
    return c.json({ ok: true });
  });
}

export const PREFIJOS_PANEL = ['/api/resumen', '/api/personas', '/api/roles', '/api/ajustes', '/api/modelos', '/api/equipo', '/api/chats', '/api/chat', '/api/inbox',
  '/api/propuestas', '/api/aprobaciones', '/api/avisos', '/api/trabajos', '/api/rutinas', '/api/entradas', '/api/reglas', '/api/clientes', '/api/cuenta', '/api/lecciones', '/api/conectores', '/api/proyectos', '/api/github', '/api/instrucciones', '/api/archivos', '/api/credenciales', '/api/sesiones', '/api/entorno', '/api/bitacora', '/api/memoria', '/api/paquetes', '/api/motores'];
