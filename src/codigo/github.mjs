// GitHub: login por dispositivo (el link y el código se mandan por WhatsApp) y la API mínima para PRs.
// El token queda cifrado en `conexiones` (app "github") y solo lo usa el gateway.
import { cifrar, descifrar } from '../auth/cripto.mjs';
import { auditar } from '../db/index.mjs';

export class ErrorGithub extends Error {
  constructor(mensaje, status = 502) { super(mensaje); this.status = status; }
}

export function crearGithub({ db, config, salida, tokenRespaldo = () => null, fetch: f = globalThis.fetch, reloj = () => Date.now(), esperar = (ms) => new Promise((r) => setTimeout(r, ms)), log = console }) {
  const web = config.github?.web ?? 'https://github.com';
  const api = config.github?.api ?? 'https://api.github.com';
  const clientId = () => config.github?.clientId ?? null;

  const fila = () => db.prepare("SELECT * FROM conexiones WHERE app = 'github' AND alcance = 'instalacion' ORDER BY id DESC LIMIT 1").get();
  function tokenPropio() {
    const c = fila();
    if (!c?.credencial || c.estado !== 'activa') return null;
    try { return JSON.parse(descifrar(config.sessionSecret, c.credencial, 'github')).token; } catch { return null; }
  }
  // El del sistema (token pegado o login por WhatsApp) o, si no hay, el "gh auth login" del entorno del Propietario.
  function token() {
    return tokenPropio() ?? (() => { try { return tokenRespaldo(); } catch { return null; } })();
  }
  function guardarToken(t, { conectadaPor, metodo }) {
    const sobre = cifrar(config.sessionSecret, JSON.stringify({ token: t, metodo }), 'github');
    const c = fila();
    if (c) db.prepare("UPDATE conexiones SET credencial = ?, estado = 'activa', conectada_por = ? WHERE id = ?").run(sobre, conectadaPor, c.id);
    else db.prepare("INSERT INTO conexiones (app, alcance, proveedor, credencial, estado, conectada_por) VALUES ('github', 'instalacion', 'directo', ?, 'activa', ?)").run(sobre, conectadaPor);
    auditar(db, 'github.conectar', { actor: String(conectadaPor ?? ''), detalle: { metodo } });
  }

  async function form(url, cuerpo) {
    const r = await f(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(cuerpo).toString(), signal: AbortSignal.timeout(20_000) });
    return r.json().catch(() => ({}));
  }

  /**
   * Login por dispositivo. Manda el link oficial y el código al chat de quien lo pidió y espera la autorización
   * en segundo plano. Devuelve enseguida.
   */
  async function conectarPorDispositivo({ chatId, personaId }) {
    if (!clientId()) throw new ErrorGithub('Falta la aplicación OAuth de GitHub (GITHUB_OAUTH_CLIENT_ID). Mientras tanto, el Propietario puede pegar un token limitado en el panel.', 409);
    const d = await form(`${web}/login/device/code`, { client_id: clientId(), scope: 'repo' });
    if (!d.device_code) throw new ErrorGithub('GitHub no entregó el código de dispositivo.');
    salida.encolar({ chatId, texto: `Para conectar GitHub: abrí ${d.verification_uri} e ingresá el código *${d.user_code}* (vence en ${Math.round((d.expires_in ?? 900) / 60)} minutos).`, origen: 'github' });
    salida.procesar().catch(() => {});
    const esperarAutorizacion = async () => {
      let intervalo = (d.interval ?? 5) * 1000;
      const vence = reloj() + (d.expires_in ?? 900) * 1000;
      while (reloj() < vence) {
        await esperar(intervalo);
        const t = await form(`${web}/login/oauth/access_token`, { client_id: clientId(), device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
        if (t.access_token) {
          guardarToken(t.access_token, { conectadaPor: personaId, metodo: 'dispositivo' });
          salida.encolar({ chatId, texto: 'Listo: GitHub quedó conectado.', origen: 'github' });
          salida.procesar().catch(() => {});
          return true;
        }
        if (t.error === 'slow_down') intervalo += 5000;
        else if (t.error && t.error !== 'authorization_pending') break;
      }
      salida.encolar({ chatId, texto: 'No se completó la conexión con GitHub (venció o se rechazó). Podés pedirla de nuevo.', origen: 'github' });
      salida.procesar().catch(() => {});
      return false;
    };
    return { espera: esperarAutorizacion().catch((e) => { log.warn('[github]', e.message); return false; }) };
  }

  async function llamar(metodo, ruta, cuerpo = null, { accept = 'application/vnd.github+json' } = {}) {
    const t = token();
    if (!t) throw new ErrorGithub('GitHub no está conectado.', 409);
    const r = await f(`${api}${ruta}`, {
      method: metodo,
      headers: { Accept: accept, Authorization: `Bearer ${t}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'superagent', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const texto = await r.text();
    let d = null;
    try { d = JSON.parse(texto); } catch { d = texto; }
    if (!r.ok) throw new ErrorGithub(`GitHub respondió ${r.status}${d?.message ? `: ${d.message}` : ''}.`, r.status === 404 ? 404 : 502);
    return d;
  }

  return {
    token,
    conectado: () => !!token(),
    origen: () => (tokenPropio() ? 'sistema' : tokenRespaldo() ? 'entorno' : null),
    guardarToken,
    conectarPorDispositivo,
    crearPr: (repo, { titulo, rama, base, cuerpo }) => llamar('POST', `/repos/${repo}/pulls`, { title: titulo, head: rama, base, body: cuerpo ?? '' }),
    mergearPr: (repo, numero, { titulo } = {}) => llamar('PUT', `/repos/${repo}/pulls/${numero}/merge`, { merge_method: 'squash', ...(titulo ? { commit_title: titulo } : {}) }),
    pr: (repo, numero) => llamar('GET', `/repos/${repo}/pulls/${numero}`),
    desconectar: () => db.prepare("UPDATE conexiones SET estado = 'desconectada', credencial = NULL WHERE app = 'github'").run(),
  };
}
