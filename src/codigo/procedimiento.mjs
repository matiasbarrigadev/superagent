// Publicación real (etapa 8c). Cada proyecto tiene un procedimiento versionado con cinco pasos obligatorios:
// respaldo, ensayo, migraciones, deploy y verificación. La corrida de publicación la ejecuta el gateway paso por
// paso (no el modelo), con un usuario aislado, sobre un clon limpio de la rama principal y con las credenciales
// del proyecto solo en el entorno de esos comandos. Todo lo que sale se tacha; al terminar se limpia.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cifrar, descifrar } from '../auth/cripto.mjs';
import { auditar } from '../db/index.mjs';
import { json } from '../util.mjs';

export const PASOS = ['respaldo', 'ensayo', 'migraciones', 'deploy', 'verificacion'];
const VARIABLES = { cloudflare: 'CLOUDFLARE_API_TOKEN', vercel: 'VERCEL_TOKEN', supabase: 'SUPABASE_ACCESS_TOKEN', github: 'GH_TOKEN' };

export class ErrorPublicacion extends Error {
  constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
}

/** Corre un paso con /bin/sh como el usuario de la publicación. Devuelve código y salida (stdout+stderr). */
export function correrPaso(comando, { cwd, env, usuario = null, timeoutMs = 15 * 60_000 }) {
  return new Promise((resolve) => {
    let hijo;
    try {
      hijo = spawn('/bin/sh', ['-c', `umask 077; ${comando}`], { cwd, env, ...(usuario ? { uid: usuario.uid, gid: usuario.gid } : {}), windowsHide: true });
    } catch (e) {
      resolve({ codigo: -1, salida: e.message });
      return;
    }
    let salida = '';
    const t = setTimeout(() => { try { hijo.kill('SIGKILL'); } catch {} }, timeoutMs);
    const sumar = (d) => { if (salida.length < 200_000) salida += d; };
    hijo.stdout.on('data', sumar);
    hijo.stderr.on('data', sumar);
    hijo.on('error', (e) => { clearTimeout(t); resolve({ codigo: -1, salida: `${salida}\n${e.message}` }); });
    hijo.on('close', (codigo) => { clearTimeout(t); resolve({ codigo, salida }); });
    hijo.stdin.end();
  });
}

/** Reemplaza cualquier aparición de un secreto (también en base64 o URL-encoded) por [secreto]. */
export function tachar(texto, secretos) {
  let t = String(texto ?? '');
  for (const s of secretos) {
    if (!s || s.length < 4) continue;
    for (const v of new Set([s, Buffer.from(s).toString('base64'), encodeURIComponent(s)])) t = t.split(v).join('[secreto]');
  }
  return t;
}

export function validarProcedimiento(proc, dominios) {
  const p = typeof proc === 'string' ? json(proc, null) : proc;
  if (!p || typeof p !== 'object') throw new ErrorPublicacion('El procedimiento no es válido.');
  for (const paso of PASOS.slice(0, 4)) {
    if (typeof p[paso] !== 'string' || !p[paso].trim()) throw new ErrorPublicacion(`Falta el paso "${paso}" (es obligatorio; si no aplica, escribí un comando que lo diga, por ejemplo: echo "sin migraciones").`);
  }
  if (!Array.isArray(p.verificacion) || !p.verificacion.length) throw new ErrorPublicacion('Falta la verificación: al menos una URL y el texto que tiene que aparecer.');
  for (const v of p.verificacion) {
    let u;
    try { u = new URL(v.url); } catch { throw new ErrorPublicacion(`URL de verificación inválida: ${v.url}`); }
    if (!dominios.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`))) throw new ErrorPublicacion(`La verificación solo puede ir contra los dominios del proyecto (${dominios.join(', ') || 'ninguno cargado'}).`);
    if (!String(v.contiene ?? '').trim()) throw new ErrorPublicacion('Cada verificación necesita el texto que tiene que aparecer: un 200 solo no alcanza.');
  }
  return { ...Object.fromEntries(PASOS.slice(0, 4).map((k) => [k, p[k].trim()])), verificacion: p.verificacion.map((v) => ({ url: v.url, contiene: String(v.contiene) })) };
}

export function crearProcedimientos({ db, config, aislamiento, repos, correr = correrPaso, fetch: f = globalThis.fetch, reloj = () => Date.now(), log = console }) {
  const proyecto = (id) => {
    const p = db.prepare('SELECT * FROM proyectos WHERE id = ?').get(Number(id));
    if (!p) throw new ErrorPublicacion('Ese proyecto no existe.', 404);
    return p;
  };

  function guardar(idProyecto, { procedimiento, dominios }, quien = null) {
    const p = proyecto(idProyecto);
    const doms = (Array.isArray(dominios) ? dominios : json(p.dominios, [])).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
    const proc = validarProcedimiento(procedimiento, doms);
    db.prepare('UPDATE proyectos SET procedimiento_publicacion = ?, dominios = ?, procedimiento_version = procedimiento_version + 1 WHERE id = ?')
      .run(JSON.stringify(proc), JSON.stringify(doms), p.id);
    auditar(db, 'proyecto.procedimiento', { actor: String(quien ?? ''), detalle: { proyecto: p.id, version: p.procedimiento_version + 1 } });
    return p.procedimiento_version + 1;
  }

  // --- Credenciales del proyecto (cifradas). Solo se muestran los nombres de las variables.
  function guardarCredencial(idProyecto, { proveedor, variable, valor, alcance }, quien = null) {
    proyecto(idProyecto);
    const v = String(variable || VARIABLES[proveedor] || '').trim();
    if (!/^[A-Z][A-Z0-9_]{1,60}$/.test(v)) throw new ErrorPublicacion('Nombre de variable inválido (por ejemplo VERCEL_TOKEN).');
    if (!String(valor ?? '').trim()) throw new ErrorPublicacion('Falta el valor.');
    const sobre = cifrar(config.sessionSecret, JSON.stringify({ variable: v, valor: String(valor).trim() }), 'credencial-proyecto');
    const previa = db.prepare('SELECT id FROM credenciales_proyecto WHERE proyecto_id = ? AND proveedor = ?').all(Number(idProyecto), String(proveedor))
      .find((c) => leer(c.id)?.variable === v);
    if (previa) db.prepare('UPDATE credenciales_proyecto SET credencial = ?, alcance = ?, rotada = ? WHERE id = ?').run(sobre, alcance ?? null, reloj(), previa.id);
    else db.prepare('INSERT INTO credenciales_proyecto (proyecto_id, proveedor, alcance, credencial, creada_por) VALUES (?, ?, ?, ?, ?)').run(Number(idProyecto), String(proveedor), alcance ?? null, sobre, quien);
    auditar(db, previa ? 'credencial.rotar' : 'credencial.crear', { actor: String(quien ?? ''), detalle: { proyecto: Number(idProyecto), variable: v } });
  }
  function leer(idCredencial) {
    const c = db.prepare('SELECT credencial FROM credenciales_proyecto WHERE id = ?').get(idCredencial);
    try { return JSON.parse(descifrar(config.sessionSecret, c.credencial, 'credencial-proyecto')); } catch { return null; }
  }
  function listarCredenciales(idProyecto) {
    return db.prepare('SELECT id, proveedor, alcance, rotada FROM credenciales_proyecto WHERE proyecto_id = ?').all(Number(idProyecto))
      .map((c) => ({ ...c, variable: leer(c.id)?.variable ?? '?' }));
  }

  async function verificar(v) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await f(v.url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
        const cuerpo = await r.text();
        if (r.ok && cuerpo.includes(v.contiene)) return { ok: true, detalle: `${v.url}: ${r.status}, contiene "${v.contiene}"` };
        if (i === 2) return { ok: false, detalle: `${v.url}: ${r.status}${r.ok ? `, pero no aparece "${v.contiene}"` : ''}` };
      } catch (e) {
        if (i === 2) return { ok: false, detalle: `${v.url}: ${e.message}` };
      }
      await new Promise((r) => setTimeout(r, config.esperaVerificacionMs ?? 5000));
    }
    return { ok: false, detalle: v.url };
  }

  /** Corre el procedimiento. Devuelve el resumen (ya tachado). */
  async function publicar(idProyecto, { pedidaPor = null, aprobacionId = null } = {}) {
    const p = proyecto(idProyecto);
    const proc = json(p.procedimiento_publicacion, null);
    if (!proc) throw new ErrorPublicacion(`${p.nombre} no tiene un procedimiento de publicación. Cargalo en el panel (Conexiones → Proyectos): respaldo, ensayo, migraciones, deploy y verificación.`, 409);
    const creds = db.prepare('SELECT id FROM credenciales_proyecto WHERE proyecto_id = ?').all(p.id).map((c) => leer(c.id)).filter(Boolean);
    const secretos = creds.map((c) => c.valor);
    const pubId = Number(db.prepare(`INSERT INTO publicaciones (proyecto_id, pedida_por, aprobacion_id, credenciales_usadas, pasos, estado, inicio, procedimiento_version)
      VALUES (?, ?, ?, ?, '[]', 'corriendo', ?, ?)`).run(p.id, pedidaPor, aprobacionId, JSON.stringify(creds.map((c) => c.variable)), reloj(), p.procedimiento_version).lastInsertRowid);
    const lugar = aislamiento.preparar(`publicacion:${p.id}`);
    const pasos = [];
    let fallo = null;
    try {
      // Clon limpio de la rama principal en cada publicación.
      fs.rmSync(path.join(lugar.trabajo, 'repo'), { recursive: true, force: true });
      if (p.repo) await repos.prepararClonPrincipal(p.id, lugar);
      const cwd = p.repo ? path.join(lugar.trabajo, 'repo') : lugar.trabajo;
      const env = { PATH: process.env.PATH, HOME: lugar.base, TMPDIR: lugar.tmp, LANG: 'C.UTF-8', CI: '1', ...Object.fromEntries(creds.map((c) => [c.variable, c.valor])) };
      for (const paso of PASOS) {
        if (fallo) { pasos.push({ paso, estado: 'omitido' }); continue; }
        if (paso === 'verificacion') {
          const r = [];
          for (const v of proc.verificacion) r.push(await verificar(v));
          const ok = r.every((x) => x.ok);
          pasos.push({ paso, estado: ok ? 'ok' : 'fallido', salida: tachar(r.map((x) => x.detalle).join('\n'), secretos) });
          if (!ok) fallo = paso;
          continue;
        }
        const r = await correr(proc[paso], { cwd, env, usuario: aislamiento.activo ? lugar.usuario : null });
        pasos.push({ paso, estado: r.codigo === 0 ? 'ok' : 'fallido', salida: tachar(r.salida, secretos).slice(-4000) });
        if (r.codigo !== 0) fallo = paso;
      }
    } catch (e) {
      fallo = fallo ?? 'preparacion';
      pasos.push({ paso: 'preparacion', estado: 'fallido', salida: tachar(e.message, secretos) });
    } finally {
      // Limpieza: procesos, clon (con cualquier .env que haya quedado), tmp y sesión.
      aislamiento.terminar(lugar);
      for (const d of [lugar.trabajo, lugar.tmp, lugar.config]) {
        for (const x of fs.existsSync(d) ? fs.readdirSync(d) : []) fs.rmSync(path.join(d, x), { recursive: true, force: true });
      }
    }
    const resultado = fallo
      ? `La publicación de ${p.nombre} falló en "${fallo}". Los pasos siguientes no corrieron.`
      : `${p.nombre} publicado: respaldo, ensayo, migraciones, deploy y verificación OK.`;
    db.prepare('UPDATE publicaciones SET pasos = ?, resultado = ?, estado = ?, fin = ? WHERE id = ?')
      .run(JSON.stringify(pasos), resultado, fallo ? 'fallida' : 'ok', reloj(), pubId);
    auditar(db, 'publicacion', { actor: String(pedidaPor ?? ''), decision: fallo ? 'fallida' : 'ok', detalle: { proyecto: p.id, publicacion: pubId, fallo } });
    return { ok: !fallo, resultado, publicacion: pubId, pasos };
  }

  return { guardar, guardarCredencial, listarCredenciales, publicar, borrarCredencial: (id) => db.prepare('DELETE FROM credenciales_proyecto WHERE id = ?').run(Number(id)).changes };
}
