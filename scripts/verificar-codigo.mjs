// Verifica el circuito de código con usuarios reales: clon del trabajo con su usuario, commit, bundle armado por
// ese usuario, subida de la rama y merge por el gateway. Dentro del contenedor, como root:
//   docker compose exec superagent node scripts/verificar-codigo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { abrirBase } from '../src/db/index.mjs';
import { crearAislamiento } from '../src/claude/aislamiento.mjs';
import { crearRepos } from '../src/codigo/repos.mjs';

const dir = '/tmp/verificar-codigo';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true, mode: 0o711 });
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=P', '-c', 'user.email=p@p', ...a], { cwd, encoding: 'utf8' }).trim();
const remoto = path.join(dir, 'remoto.git');
git(dir, 'init', '--bare', '--initial-branch=main', remoto);
git(dir, 'clone', remoto, path.join(dir, 'semilla'));
fs.writeFileSync(path.join(dir, 'semilla', 'index.html'), 'vieja\n');
git(path.join(dir, 'semilla'), 'add', '-A');
git(path.join(dir, 'semilla'), 'commit', '-m', 'inicio');
git(path.join(dir, 'semilla'), 'push', 'origin', 'HEAD:main');

const db = abrirBase(':memory:');
db.prepare("INSERT INTO proyectos (id, cliente_id, nombre, repo, rama_principal) VALUES (1, 1, 'sitio', ?, 'main')").run(remoto);
const dataDir = path.join(dir, 'data');
fs.mkdirSync(dataDir, { mode: 0o711 });
const ais = crearAislamiento({ db, config: { dataDir, uidBase: 29300 }, log: console });
const repos = crearRepos({ db, config: { dataDir }, aislamiento: ais, github: null });
const res = {};
const A = ais.preparar('trabajo:T-1'), B = ais.preparar('trabajo:T-2');
const clon = await repos.prepararClon(1, A, 'superagent/T-1');
res.clon_es_del_trabajo = fs.statSync(path.join(clon, 'index.html')).uid === A.usuario.uid && fs.statSync(path.join(clon, '.git')).uid === A.usuario.uid;
const como = (u, cwd, ...a) => spawnSync('git', a, { cwd, uid: u.uid, gid: u.gid, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd } });
fs.writeFileSync(path.join(clon, 'index.html'), 'nueva\n'); fs.chownSync(path.join(clon, 'index.html'), A.usuario.uid, A.usuario.gid);
como(A.usuario, clon, '-c', 'user.name=Agente', '-c', 'user.email=a@a', 'commit', '-am', 'Portada nueva');
res.otro_trabajo_no_ve_el_clon = como(B.usuario, B.trabajo, '-C', clon, 'log', '-1').status !== 0;
await repos.importarRama(1, { dirRepo: clon, usuario: A.usuario, rama: 'superagent/T-1' });
await repos.subirRama(1, 'superagent/T-1');
res.rama_en_el_remoto = git(dir, '--git-dir', remoto, 'show', 'superagent/T-1:index.html') === 'nueva';
res.main_sin_cambios = git(dir, '--git-dir', remoto, 'show', 'main:index.html') === 'vieja';
try { await repos.subirRama(1, 'main'); res.main_bloqueada = false; } catch { res.main_bloqueada = true; }
await repos.mergeLocal(1, 'superagent/T-1');
res.publicado = git(dir, '--git-dir', remoto, 'show', 'main:index.html') === 'nueva';
for (const l of [A, B]) { ais.terminar(l); spawnSync('userdel', [l.usuario.nombre]); }
fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(res, null, 1));
const ok = Object.values(res).every(Boolean);
console.log(ok ? 'OK: el circuito de código funciona aislado' : 'FALLA');
process.exit(ok ? 0 : 1);
