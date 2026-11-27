// OAuth para conectores MCP remotos (especificación de autorización de MCP): descubrimiento del recurso protegido
// (RFC 9728) y del servidor de autorización (RFC 8414), registro dinámico del cliente (RFC 7591), PKCE S256 y el
// parámetro resource (RFC 8707). El gateway es el cliente; el agente nunca ve un token.
import crypto from 'node:crypto';

const b64url = (b) => Buffer.from(b).toString('base64url');

async function json(f, url, opciones = {}) {
  const r = await f(url, { ...opciones, headers: { Accept: 'application/json', ...(opciones.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) {
    const cuerpo = await r.json().catch(() => null);
    throw Object.assign(new Error(`${url} respondió ${r.status}${cuerpo?.error ? ` (${cuerpo.error}${cuerpo.error_description ? `: ${cuerpo.error_description}` : ''})` : ''}`), { status: r.status, codigo: cuerpo?.error ?? null });
  }
  return r.json();
}

/** Encuentra el servidor de autorización de un MCP remoto. Devuelve null si el MCP no usa OAuth. */
export async function descubrir(urlMcp, { fetch: f = globalThis.fetch } = {}) {
  const mcp = new URL(urlMcp);
  // 1) El 401 del MCP puede traer resource_metadata en WWW-Authenticate.
  let metaRecurso = null;
  let pideAuth = false;
  try {
    const r = await f(urlMcp, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"superagent","version":"1"}}}', signal: AbortSignal.timeout(20_000) });
    // Algunos MCP (Google) contestan initialize sin login y piden autorización recién al usar una herramienta: por eso
    // un 200 acá no alcanza, también se miran los metadatos del recurso protegido.
    pideAuth = r.status === 401;
    const m = /resource_metadata="([^"]+)"/.exec(r.headers.get('www-authenticate') ?? '');
    if (m) metaRecurso = await json(f, m[1]).catch(() => null);
  } catch {
    // Seguimos con las rutas conocidas.
  }
  // 2) Ruta conocida del recurso protegido (con y sin el path del MCP).
  if (!metaRecurso) {
    for (const ruta of [`/.well-known/oauth-protected-resource${mcp.pathname}`, '/.well-known/oauth-protected-resource']) {
      metaRecurso = await json(f, new URL(ruta, mcp.origin).href).catch(() => null);
      if (metaRecurso) break;
    }
  }
  if (!pideAuth && !metaRecurso?.authorization_servers?.length) return null; // no pide autorización
  const emisor = metaRecurso?.authorization_servers?.[0] ?? mcp.origin;
  const e = new URL(emisor);
  let meta = null;
  for (const ruta of [`/.well-known/oauth-authorization-server${e.pathname === '/' ? '' : e.pathname}`, '/.well-known/oauth-authorization-server', `/.well-known/openid-configuration${e.pathname === '/' ? '' : e.pathname}`]) {
    meta = await json(f, new URL(ruta, e.origin).href).catch(() => null);
    if (meta?.authorization_endpoint) break;
  }
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw new Error('El conector pide autorización pero no se encontró su servidor OAuth.');
  // Algunos (Vercel) publican el registro dinámico en el origen del MCP y no en el del servidor de autorización.
  if (!meta.registration_endpoint && e.origin !== mcp.origin) {
    const delMcp = await json(f, new URL('/.well-known/oauth-authorization-server', mcp.origin).href).catch(() => null);
    if (delMcp?.registration_endpoint) meta = { ...meta, registration_endpoint: delMcp.registration_endpoint };
  }
  // Los permisos (scopes) que pide el MCP, no los genéricos del servidor de autorización (que pueden ser solo openid).
  return { recurso: metaRecurso?.resource ?? urlMcp, meta, alcances: metaRecurso?.scopes_supported?.length ? metaRecurso.scopes_supported : null };
}

/** Registro dinámico como cliente público (PKCE, sin secreto). */
export async function registrar(meta, { redirectUri, fetch: f = globalThis.fetch }) {
  if (!meta.registration_endpoint) throw new Error('Este servicio no deja que esta instalación se registre sola (no tiene registro automático de clientes OAuth): hace falta un cliente OAuth propio del servicio (client_id y secreto), o usar su CLI o una clave de API si la ofrece.');
  try {
    return await json(f, meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Superagent', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
  } catch (e) {
    // Algunos servicios (Vercel) solo dejan registrarse a clientes que aprobaron: no es algo que se arregle reintentando.
    if (e.codigo === 'invalid_redirect_uri' || e.codigo === 'unapproved_client') {
      throw new Error('Este servicio solo deja conectar a aplicaciones que aprobó, y esta instalación no está entre ellas. Conectalo con su CLI en tu entorno (por ejemplo `vercel login`) o con una clave de API si el servicio la ofrece.');
    }
    throw e;
  }
}

export function pkce() {
  const verificador = b64url(crypto.randomBytes(32));
  return { verificador, desafio: b64url(crypto.createHash('sha256').update(verificador).digest()) };
}

export function urlAutorizacion({ meta, clientId, redirectUri, estado, desafio, recurso, alcance = null }) {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', estado);
  u.searchParams.set('code_challenge', desafio);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('resource', recurso);
  if (alcance ?? meta.scopes_supported?.length) u.searchParams.set('scope', alcance ?? meta.scopes_supported.join(' '));
  // Google entrega el token para renovar solo si se pide acceso "offline" y el consentimiento explícito.
  if (/accounts\.google\.com/.test(String(meta.issuer ?? meta.authorization_endpoint))) {
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
  }
  return u.href;
}

async function intentarToken(tokenEndpoint, cuerpo, f, { secreto = null, basico = false } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  let c = cuerpo;
  if (secreto && basico) {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(cuerpo.client_id)}:${encodeURIComponent(secreto)}`).toString('base64')}`;
  } else if (secreto) {
    c = { ...cuerpo, client_secret: secreto };
  }
  const r = await f(tokenEndpoint, { method: 'POST', headers, body: new URLSearchParams(c).toString(), signal: AbortSignal.timeout(20_000) });
  return { r, d: await r.json().catch(() => ({})) };
}

/**
 * Canje o renovación, para cualquier servidor OAuth: cliente público (solo PKCE) o, si el registro entregó un
 * client_secret, con el secreto en el cuerpo (client_secret_post) y, si el servidor rechaza al cliente, en el
 * encabezado (client_secret_basic).
 */
async function pedirToken(tokenEndpoint, cuerpo, f, clientSecret = null) {
  let { r, d } = await intentarToken(tokenEndpoint, cuerpo, f, { secreto: clientSecret });
  const clienteRechazado = r.status === 401 || d.error === 'invalid_client' || /client_secret|client authentication/i.test(String(d.message ?? d.error_description ?? ''));
  if (clientSecret && !d.access_token && clienteRechazado) ({ r, d } = await intentarToken(tokenEndpoint, cuerpo, f, { secreto: clientSecret, basico: true }));
  if (!r.ok || !d.access_token) {
    const motivo = d.error_description ?? d.error ?? d.message ?? '';
    throw new Error(`El servidor OAuth no entregó el token (${r.status}${motivo ? `: ${String(motivo).slice(0, 200)}` : ''}).`);
  }
  return { access_token: d.access_token, refresh_token: d.refresh_token ?? null, expiraEn: d.expires_in ? Number(d.expires_in) : null };
}

export function canjearCodigo({ meta, clientId, clientSecret = null, codigo, redirectUri, verificador, recurso, fetch: f = globalThis.fetch }) {
  return pedirToken(meta.token_endpoint, { grant_type: 'authorization_code', code: codigo, redirect_uri: redirectUri, client_id: clientId, code_verifier: verificador, resource: recurso }, f, clientSecret);
}

export function renovar({ meta, clientId, clientSecret = null, refreshToken, recurso, fetch: f = globalThis.fetch }) {
  return pedirToken(meta.token_endpoint, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: recurso }, f, clientSecret);
}
