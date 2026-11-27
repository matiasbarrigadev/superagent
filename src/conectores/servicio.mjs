// Conectores MCP remotos (etapa 7c). El gateway es el intermediario: guarda los tokens cifrados en `conexiones`,
// lista las herramientas de cada conector y, en cada corrida, le ofrece al agente solo las que su rol permite.
// Cada llamada pasa por el gateway, que agrega el token: el agente no lo ve ni en su entorno ni en su disco.
import crypto from 'node:crypto';
import { soloLectura } from './lectura.mjs';
import { cifrar, descifrar } from '../auth/cripto.mjs';
import { crearClienteMcp, ErrorConector } from './cliente.mjs';
import { descubrir, registrar, pkce, urlAutorizacion, canjearCodigo, renovar } from './oauth.mjs';
import { json } from '../util.mjs';
import { auditar } from '../db/index.mjs';

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const slug = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'conector';

// Sugerencias para el panel. Las URLs son las públicas de cada proveedor: verificarlas al conectar. Vercel no está:
// su MCP solo acepta aplicaciones que aprobó (se conecta con `vercel login` en el entorno del agente).
export const CATALOGO = [
  { nombre: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', auth: 'oauth' },
  { nombre: 'Supabase', url: 'https://mcp.supabase.com/mcp', auth: 'oauth' },
  { nombre: 'Stripe', url: 'https://mcp.stripe.com', auth: 'oauth' },
  { nombre: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth' },
  { nombre: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth' },
  { nombre: 'Sentry', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth' },
];

export class ErrorConexion extends Error {
  constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
}

export function crearConectores({ db, config, salida, alCaer = () => {}, alAutorizar = null, fetch: f = globalThis.fetch, reloj = () => Date.now(), log = console }) {
  const redirectUri = () => `${config.publicUrl}/oauth/callback`;
  const guardarCred = (id, cred) => db.prepare('UPDATE conexiones SET credencial = ? WHERE id = ?').run(cifrar(config.sessionSecret, JSON.stringify(cred), 'conector'), id);
  const leerCred = (c) => { try { return c.credencial ? JSON.parse(descifrar(config.sessionSecret, c.credencial, 'conector')) : null; } catch { return null; } };
  const obtener = (id) => {
    const c = db.prepare('SELECT * FROM conexiones WHERE id = ?').get(Number(id));
    if (!c) throw new ErrorConexion('Ese conector no existe.', 404);
    return c;
  };
  // El resultado de una autorización le llega al agente (que sigue la charla con eso); sin agente, un aviso directo.
  const avisar = (chatId, texto, evento) => {
    if (!chatId) return;
    if (alAutorizar && alAutorizar({ chatId, texto: evento })) return;
    salida.encolar({ chatId, texto, origen: 'conector' });
    salida.procesar().catch(() => {});
  };

  function crear({ nombre, url, auth = 'oauth', clave = null, alcance = 'instalacion', personaId = null, creadoPor = null }) {
    let u;
    try { u = new URL(String(url)); } catch { throw new ErrorConexion('La URL del conector no es válida.'); }
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname) && !u.hostname.endsWith('.test')) throw new ErrorConexion('El conector tiene que usar https.');
    const n = String(nombre ?? '').trim().slice(0, 40);
    if (n.length < 2) throw new ErrorConexion('El conector necesita un nombre.');
    const id = Number(db.prepare(`INSERT INTO conexiones (app, alcance, persona_id, proveedor, estado, conectada_por, url_mcp, habilitada_para, permisos)
      VALUES (?, ?, ?, 'directo', 'pendiente', ?, ?, ?, '[]')`)
      .run(n, alcance, alcance === 'persona' ? personaId : null, creadoPor, u.href, JSON.stringify({ roles: ['Propietario'], apagadas: [], auth })).lastInsertRowid);
    if (auth === 'clave') {
      if (!clave) throw new ErrorConexion('Falta la clave.');
      guardarCred(id, { tipo: 'clave', valor: String(clave).trim() });
    }
    auditar(db, 'conector.crear', { actor: String(creadoPor ?? ''), detalle: { id, nombre: n, alcance } });
    return id;
  }

  /** Arranca el OAuth y devuelve el link de autorización (que el gateway manda, no el agente). */
  async function autorizar(id, { chatAviso = null } = {}) {
    const c = obtener(id);
    const d = await descubrir(c.url_mcp, { fetch: f });
    if (!d) {
      // Ya se probó y el servicio pide autorización sin decir cómo: no se vuelve a marcar "conectado" (era un bucle).
      if (leerCred(c)?.sinOauth) throw new ErrorConexion('Este conector pide autorización pero no publica cómo obtenerla (no tiene OAuth que se pueda descubrir): no se puede conectar con un link. Usá otra vía: un servicio que haga de puente (por ejemplo Composio), su CLI en tu entorno o una clave de API si la ofrece.', 409);
      await activar(id, { tipo: 'ninguna' }, chatAviso);
      if (obtener(id).estado === 'error' && leerCred(obtener(id))?.sinOauth) throw new ErrorConexion('Este conector pide autorización pero no publica cómo obtenerla (no tiene OAuth que se pueda descubrir): no se puede conectar con un link. Usá otra vía: un servicio que haga de puente (por ejemplo Composio), su CLI en tu entorno o una clave de API si la ofrece.', 409);
      return null;
    }
    const reg = await registrar(d.meta, { redirectUri: redirectUri(), fetch: f });
    const { verificador, desafio } = pkce();
    const estado = crypto.randomBytes(24).toString('base64url');
    guardarCred(id, { tipo: 'pendiente', verificador, meta: d.meta, clientId: reg.client_id, clientSecret: reg.client_secret ?? null, recurso: d.recurso, chatAviso, vence: reloj() + 30 * 60_000 });
    db.prepare("UPDATE conexiones SET referencia = ?, estado = 'pendiente' WHERE id = ?").run(sha(estado), id);
    return urlAutorizacion({ meta: d.meta, clientId: reg.client_id, redirectUri: redirectUri(), estado, desafio, recurso: d.recurso, alcance: d.alcances?.join(' ') ?? null });
  }

  /** /oauth/callback: canjea el código y deja el conector activo. */
  async function callback(estado, codigo) {
    const c = db.prepare('SELECT * FROM conexiones WHERE referencia = ?').get(sha(estado ?? ''));
    const p = c ? leerCred(c) : null;
    if (!c || p?.tipo !== 'pendiente' || p.vence < reloj()) throw new ErrorConexion('El link de autorización no es válido o venció. Pedí uno nuevo.', 400);
    const t = conVencimiento(await canjearCodigo({ meta: p.meta, clientId: p.clientId, clientSecret: p.clientSecret, codigo, redirectUri: redirectUri(), verificador: p.verificador, recurso: p.recurso, fetch: f }));
    await activar(c.id, { tipo: 'oauth', ...t, tokenEndpoint: p.meta.token_endpoint, clientId: p.clientId, clientSecret: p.clientSecret ?? null, recurso: p.recurso }, p.chatAviso);
    return c.app;
  }

  const conVencimiento = ({ expiraEn, ...t }) => ({ ...t, expira: expiraEn ? reloj() + expiraEn * 1000 : null });

  async function activar(id, cred, chatAviso = null) {
    guardarCred(id, cred);
    db.prepare("UPDATE conexiones SET estado = 'activa', referencia = NULL WHERE id = ?").run(id);
    try {
      const n = await actualizarHerramientas(id);
      const app = obtener(id).app;
      // Antes de darlo por conectado, una llamada de verdad: listar herramientas no prueba que la autorización sirva.
      const p = await probar(id);
      if (p?.sinAutorizar) {
        db.prepare("UPDATE conexiones SET estado = 'error' WHERE id = ?").run(id);
        // Sin OAuth descubrible: queda marcado para no reintentar en bucle.
        if (cred.tipo === 'ninguna') guardarCred(id, { tipo: 'ninguna', sinOauth: true });
        avisar(chatAviso, `El conector ${app} no quedó autorizado: al probarlo, el servicio rechazó la autorización.`,
          `[conector ${app} sin autorización real] Respondió la lista de herramientas, pero al probar ${p.herramienta} el servicio rechazó la autorización (${p.error}). Seguramente necesita un login OAuth que no se completó o un cliente OAuth propio del servicio. Contáselo simple y proponé el camino (reautorizar, su CLI o una clave de API).`);
        return;
      }
      const prueba = p ? (p.ok ? ` Lo probé con ${p.herramienta} y respondió bien.` : ` Al probarlo con ${p.herramienta} dio un error (${p.error}); puede ser de esa consulta, no de la conexión.`) : ' No tiene una consulta de solo lectura para probarlo: confirmalo con la primera que hagas.';
      avisar(chatAviso, `Listo: el conector ${app} quedó conectado (${n} herramientas).`,
        `[conector ${app} conectado] La autorización se completó: ${n} herramientas listas.${prueba} Contáselo en una línea y seguí con lo que estaban haciendo (si ya lo diste por conectado, no lo repitas).`);
    } catch (e) {
      db.prepare("UPDATE conexiones SET estado = 'error' WHERE id = ?").run(id);
      const app = obtener(id).app;
      avisar(chatAviso, `El conector ${app} se autorizó pero no respondió: ${e.message}`,
        `[conector ${app} sin responder] Se autorizó pero el servicio no respondió: ${e.message}. Contáselo simple y ofrecé reintentar.`);
    }
  }

  /**
   * Prueba real: llama a una herramienta de solo lectura sin parámetros obligatorios (listar algo). Devuelve null si
   * no hay ninguna así, {ok}, {sinAutorizar} o {error}.
   */
  async function probar(id) {
    const c = obtener(id);
    const candidata = json(c.permisos, []).find((h) => !h.escribe && !(h.esquema?.required ?? []).length);
    if (!candidata) return null;
    try {
      const r = await (await cliente(c)).llamar(candidata.nombre, {});
      const texto = (r?.content ?? []).map((x) => (x.type === 'text' ? x.text : '')).join(' ');
      if (r?.isError && /auth|credential|token|unauthori[sz]ed|forbidden|permission denied|login/i.test(texto)) return { herramienta: candidata.nombre, sinAutorizar: true, error: texto.slice(0, 200) };
      return r?.isError ? { herramienta: candidata.nombre, error: texto.slice(0, 200) || 'error' } : { herramienta: candidata.nombre, ok: true };
    } catch (e) {
      return e.sinAutorizar ? { herramienta: candidata.nombre, sinAutorizar: true, error: e.message } : { herramienta: candidata.nombre, error: e.message };
    }
  }

  async function token(c) {
    const cred = leerCred(c);
    if (!cred) throw new ErrorConector('El conector no está autorizado.', { sinAutorizar: true });
    if (cred.tipo === 'clave') return { headers: { Authorization: cred.valor.startsWith('Bearer ') ? cred.valor : `Bearer ${cred.valor}` } };
    if (cred.tipo === 'ninguna') return {};
    if (cred.tipo !== 'oauth') throw new ErrorConector('El conector todavía no se autorizó.', { sinAutorizar: true });
    if (cred.expira && cred.expira < reloj() + 60_000 && cred.refresh_token) {
      const t = conVencimiento(await renovar({ meta: { token_endpoint: cred.tokenEndpoint }, clientId: cred.clientId, clientSecret: cred.clientSecret, refreshToken: cred.refresh_token, recurso: cred.recurso, fetch: f }));
      Object.assign(cred, { ...t, refresh_token: t.refresh_token ?? cred.refresh_token });
      guardarCred(c.id, cred);
    }
    return { token: cred.access_token };
  }

  async function cliente(c) {
    const a = await token(c);
    return crearClienteMcp({ url: c.url_mcp, token: a.token ?? null, headers: a.headers ?? {}, fetch: f });
  }

  async function actualizarHerramientas(id) {
    const c = obtener(id);
    const lista = await (await cliente(c)).herramientas();
    const herramientas = lista.slice(0, 200).map((t) => ({
      nombre: t.name, descripcion: String(t.description ?? '').slice(0, 1000), esquema: t.inputSchema ?? { type: 'object' },
      // Sin la marca de "solo lectura", se la trata como una herramienta que escribe.
      escribe: t.annotations?.readOnlyHint !== true,
    }));
    db.prepare('UPDATE conexiones SET permisos = ? WHERE id = ?').run(JSON.stringify(herramientas), id);
    return herramientas.length;
  }

  /**
   * Herramientas de conectores para una corrida: conectores activos habilitados para el rol (o propios de la persona),
   * filtradas por el nivel de herramientas_negocio (lectura: solo las que no escriben).
   */
  function paraCorrida({ personaId, rol }) {
    const nivel = rol.permisos.herramientas_negocio;
    if (nivel === 'ninguna') return [];
    const out = [];
    for (const c of db.prepare("SELECT * FROM conexiones WHERE estado = 'activa'").all()) {
      const hab = json(c.habilitada_para, { roles: [], apagadas: [] });
      const mio = c.alcance === 'persona' && c.persona_id === personaId;
      if (c.alcance === 'persona' ? !mio : !(hab.roles ?? []).includes(rol.nombre)) continue;
      const sl = soloLectura(c);
      for (const h of json(c.permisos, [])) {
        if ((hab.apagadas ?? []).includes(h.nombre)) continue;
        const escribe = h.escribe && !sl;
        if (escribe && nivel !== 'lectura_escritura') continue;
        out.push({
          nombre: `${slug(c.app)}__${h.nombre}`.slice(0, 64),
          descripcion: `[${c.app}${escribe ? ', escribe' : ''}] ${h.descripcion}`,
          esquema: h.esquema, conexionId: c.id, herramienta: h.nombre, escribe,
        });
      }
    }
    return out;
  }

  /** Conectores activos que existen pero este rol no puede usar (para que el agente diga eso y no invente una falla). */
  function fueraDeAlcance({ rol }) {
    const nivel = rol.permisos.herramientas_negocio;
    return [...new Set(habilitados().filter((c) => nivel === 'ninguna' || !c.roles.includes(rol.nombre)).map((c) => c.app))];
  }

  /** Conectores activos de la instalación y los roles que los tienen habilitados. */
  function habilitados() {
    return db.prepare("SELECT app, habilitada_para FROM conexiones WHERE estado = 'activa' AND alcance <> 'persona' ORDER BY id").all()
      .map((c) => ({ app: c.app, roles: json(c.habilitada_para, { roles: [] }).roles ?? [] }));
  }

  async function llamar(conexionId, herramienta, args) {
    const c = obtener(conexionId);
    try {
      const r = await (await cliente(c)).llamar(herramienta, args);
      const texto = (r?.content ?? []).map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n') || JSON.stringify(r?.structuredContent ?? r ?? {});
      return { texto: texto.slice(0, 50_000), esError: !!r?.isError };
    } catch (e) {
      if (e.sinAutorizar) {
        const cambio = db.prepare("UPDATE conexiones SET estado = 'error' WHERE id = ? AND estado != 'error'").run(c.id).changes;
        if (cambio) { try { alCaer(c); } catch (x) { log.warn('[conectores] alCaer', x.message); } }
      }
      throw e;
    }
  }

  /**
   * Autorizaciones que quedaron colgadas: la de un servicio que ya tiene otra conexión activa, o la que tiene el
   * link vencido hace más de una hora (se empezó y nunca se terminó, o se resolvió por otro camino).
   */
  function limpiar({ resueltos = [] } = {}) {
    const pendientes = db.prepare("SELECT * FROM conexiones WHERE estado = 'pendiente' AND app != 'github'").all();
    let n = 0;
    for (const c of pendientes) {
      const otraActiva = c.url_mcp && db.prepare("SELECT 1 FROM conexiones WHERE estado = 'activa' AND url_mcp = ? AND id != ?").get(c.url_mcp, c.id);
      const p = leerCred(c);
      const vencida = p?.tipo === 'pendiente' && p.vence < reloj() - 60 * 60_000;
      // O el servicio ya quedó conectado por otro camino (por ejemplo, el login de su CLI en el entorno del agente).
      const porOtroLado = resueltos.some((r) => `${c.app} ${c.url_mcp}`.toLowerCase().includes(String(r).toLowerCase()));
      if (otraActiva || vencida || porOtroLado) { db.prepare('DELETE FROM conexiones WHERE id = ?').run(c.id); n++; }
    }
    return n;
  }

  function listar({ resueltos = [] } = {}) {
    limpiar({ resueltos });
    return db.prepare('SELECT id, app, alcance, persona_id, estado, url_mcp, habilitada_para, permisos, conectada_por FROM conexiones ORDER BY id').all()
      .map((c) => ({ ...c, habilitada_para: json(c.habilitada_para, {}), herramientas: json(c.permisos, []), solo_lectura: soloLectura(c) }));
  }

  function configurar(id, { roles, apagadas, nombre, solo_lectura }) {
    const c = obtener(id);
    const hab = json(c.habilitada_para, {});
    if (Array.isArray(roles)) hab.roles = roles.map(String);
    if (Array.isArray(apagadas)) hab.apagadas = apagadas.map(String);
    if (typeof solo_lectura === 'boolean') hab.solo_lectura = solo_lectura;
    db.prepare('UPDATE conexiones SET habilitada_para = ?, app = ? WHERE id = ?').run(JSON.stringify(hab), nombre ? String(nombre).slice(0, 40) : c.app, c.id);
  }

  return {
    crear, autorizar, callback, actualizarHerramientas, paraCorrida, fueraDeAlcance, habilitados, llamar, listar, limpiar, configurar, obtener,
    borrar: (id) => db.prepare('DELETE FROM conexiones WHERE id = ?').run(Number(id)).changes,
  };
}
