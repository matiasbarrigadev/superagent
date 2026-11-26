// Repos de los proyectos. El gateway tiene un espejo por proyecto (/data/repos/<id>.git, solo root) y le da a
// cada trabajo un clon propio dentro de su carpeta aislada. El agente commitea en local; para subir, el gateway
// trae la rama con un bundle generado por el usuario del trabajo (nunca corre git como root sobre una carpeta
// del agente) y la empuja con su token. Solo ramas: la rama principal no se toca.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';

export class ErrorRepo extends Error {
  constructor(mensaje, status = 400) { super(mensaje); this.status = status; }
}

/** Corre git y devuelve stdout (Buffer). Siempre sin hooks. */
export function correrGit(args, { cwd, env = {}, usuario = null, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const hijo = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd, env: { PATH: process.env.PATH, HOME: env.HOME ?? cwd ?? os.tmpdir(), GIT_TERMINAL_PROMPT: '0', LANG: 'C.UTF-8', ...env, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
      ...(usuario ? { uid: usuario.uid, gid: usuario.gid } : {}), windowsHide: true,
    });
    const out = [];
    let err = '';
    const t = setTimeout(() => { try { hijo.kill('SIGKILL'); } catch {} }, timeoutMs);
    hijo.stdout.on('data', (d) => out.push(d));
    hijo.stderr.on('data', (d) => { if (err.length < 10_000) err += d; });
    hijo.on('error', (e) => { clearTimeout(t); reject(e); });
    hijo.on('close', (codigo) => {
      clearTimeout(t);
      if (codigo === 0) resolve(Buffer.concat(out));
      else reject(new ErrorRepo(`git ${args[0]} falló: ${err.trim().split('\n').slice(-2).join(' ')}`, 502));
    });
  });
}

const RAMA_VALIDA = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;

export function crearRepos({ db, config, aislamiento, github, git = correrGit, log = console }) {
  const base = path.join(config.dataDir, 'repos');
  const web = config.github?.web ?? 'https://github.com';

  const proyecto = (idONombre) => {
    const p = db.prepare('SELECT * FROM proyectos WHERE id = ? OR nombre = ? COLLATE NOCASE').get(Number(idONombre) || -1, String(idONombre ?? ''));
    if (!p) throw new ErrorRepo(`No existe el proyecto ${idONombre}.`, 404);
    if (!p.repo) throw new ErrorRepo(`El proyecto ${p.nombre} no tiene repo.`, 409);
    return p;
  };
  const esGithub = (p) => /^[\w.-]+\/[\w.-]+$/.test(p.repo);
  const urlRemota = (p) => (esGithub(p) ? `${web}/${p.repo}.git` : p.repo);
  const espejo = (p) => path.join(base, `${p.id}.git`);

  /** Token de GitHub por variables de entorno (solo las ve root), nunca en la URL ni en los argumentos. */
  function envRemoto(p) {
    const t = esGithub(p) ? github?.token() : null;
    if (!t) return {};
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${web}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${t}`).toString('base64')}`,
    };
  }

  async function actualizarEspejo(p) {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(espejo(p))) await git(['clone', '--mirror', '--', urlRemota(p), espejo(p)], { env: envRemoto(p) });
    else await git(['fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], { cwd: espejo(p), env: envRemoto(p) });
  }

  /** Dueño de todo lo que root dejó en la carpeta del trabajo (sin seguir enlaces). */
  function cederA(dir, u) {
    if (!aislamiento.activo) return;
    const pila = [dir];
    while (pila.length) {
      const d = pila.pop();
      fs.lchownSync(d, u.uid, u.gid);
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const ruta = path.join(d, e.name);
        if (e.isDirectory()) pila.push(ruta);
        else fs.lchownSync(ruta, u.uid, u.gid);
      }
    }
  }

  /** Clon del proyecto en la carpeta del trabajo, en una rama nueva. Se llama con la carpeta recién preparada. */
  async function prepararClon(idProyecto, lugar, rama) {
    const p = proyecto(idProyecto);
    if (!RAMA_VALIDA.test(rama) || rama === p.rama_principal) throw new ErrorRepo('Nombre de rama inválido.');
    const destino = path.join(lugar.trabajo, 'repo');
    if (fs.existsSync(destino)) return destino; // el trabajo se reanuda: el clon sigue ahí
    await actualizarEspejo(p);
    await git(['clone', '--no-hardlinks', '--branch', p.rama_principal, '--', espejo(p), destino]);
    await git(['checkout', '-b', rama], { cwd: destino });
    await git(['remote', 'remove', 'origin'], { cwd: destino });
    await git(['config', 'user.name', 'Superagent'], { cwd: destino });
    await git(['config', 'user.email', 'superagent@localhost'], { cwd: destino });
    cederA(destino, lugar.usuario);
    return destino;
  }

  /** Clon limpio de la rama principal (para la corrida de publicación). */
  async function prepararClonPrincipal(idProyecto, lugar) {
    const p = proyecto(idProyecto);
    const destino = path.join(lugar.trabajo, 'repo');
    await actualizarEspejo(p);
    await git(['clone', '--no-hardlinks', '--branch', p.rama_principal, '--', espejo(p), destino]);
    cederA(destino, lugar.usuario);
    return destino;
  }

  /** Trae la rama del clon del trabajo al espejo, con un bundle que arma el usuario del trabajo. */
  async function importarRama(idProyecto, { dirRepo, usuario, rama }) {
    const p = proyecto(idProyecto);
    if (!RAMA_VALIDA.test(rama) || rama === p.rama_principal) throw new ErrorRepo(`Solo se suben ramas de trabajo, nunca ${p.rama_principal}.`, 403);
    const bundle = await git(['bundle', 'create', '-', `refs/heads/${rama}`], { cwd: dirRepo, usuario: aislamiento.activo ? usuario : null, env: { HOME: dirRepo } })
      .catch((e) => { throw new ErrorRepo(`No se pudo leer la rama ${rama}: ${e.message}`, 409); });
    const tmp = path.join(base, `entrada-${crypto.randomUUID()}.bundle`);
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, bundle, { mode: 0o600 });
    try {
      await actualizarEspejo(p);
      await git(['fetch', tmp, `+refs/heads/${rama}:refs/heads/${rama}`], { cwd: espejo(p) });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return p;
  }

  /** Empuja la rama del espejo al remoto. Nunca la principal, nunca a la fuerza. */
  async function subirRama(idProyecto, rama) {
    const p = proyecto(idProyecto);
    if (!RAMA_VALIDA.test(rama) || rama === p.rama_principal) throw new ErrorRepo(`Solo se suben ramas de trabajo, nunca ${p.rama_principal}.`, 403);
    await git(['push', urlRemota(p), `refs/heads/${rama}:refs/heads/${rama}`], { cwd: espejo(p), env: envRemoto(p) });
    return p;
  }

  async function diff(idProyecto, rama) {
    const p = proyecto(idProyecto);
    const rango = `${p.rama_principal}...${rama}`;
    const stat = (await git(['diff', '--stat', rango], { cwd: espejo(p) })).toString();
    const cuerpo = (await git(['diff', rango], { cwd: espejo(p) })).toString();
    return { stat: stat.trim(), diff: cuerpo.length > 200_000 ? `${cuerpo.slice(0, 200_000)}\n… (recortado)` : cuerpo };
  }

  /** Merge local en el espejo y push de la principal (para repos que no son de GitHub, como el de las pruebas). */
  async function mergeLocal(idProyecto, rama) {
    const p = proyecto(idProyecto);
    const tmp = path.join(base, `merge-${crypto.randomUUID()}`);
    try {
      await git(['clone', '--branch', p.rama_principal, '--', espejo(p), tmp]);
      await git(['-c', 'user.name=Superagent', '-c', 'user.email=superagent@localhost', 'merge', '--no-ff', '-m', `Merge ${rama}`, `origin/${rama}`], { cwd: tmp });
      await git(['push', 'origin', p.rama_principal], { cwd: tmp });
      await git(['push', urlRemota(p), `refs/heads/${p.rama_principal}:refs/heads/${p.rama_principal}`], { cwd: espejo(p), env: envRemoto(p) });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return { proyecto, esGithub, prepararClon, prepararClonPrincipal, importarRama, subirRama, diff, mergeLocal, actualizarEspejo };
}
