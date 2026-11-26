// Verifica el aislamiento entre conversaciones con usuarios reales. Correr dentro del contenedor, como root:
//   docker compose exec superagent node scripts/verificar-aislamiento.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { abrirBase } from '../src/db/index.mjs';
import { crearAislamiento } from '../src/claude/aislamiento.mjs';
const dataDir = '/tmp/prueba-aisl'; fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { mode: 0o711 });
const db = abrirBase(':memory:');
const ais = crearAislamiento({ db, config: { dataDir, uidBase: 29000 }, log: console });
const res = {};
const A = ais.preparar('chat:A'), B = ais.preparar('chat:B');
res.activo = ais.activo; res.uids = [A.usuario.uid, B.usuario.uid];
const como = (u, cmd, args) => spawnSync(cmd, args, { uid: u.uid, gid: u.gid, encoding: 'utf8', env: { PATH: process.env.PATH } });
// A escribe un secreto con umask 077 (como lo hace el comando de las corridas).
como(A.usuario, '/bin/sh', ['-c', `umask 077 && echo secreto-de-A > ${A.trabajo}/nota.txt`]);
res.A_lee_lo_suyo = como(A.usuario, 'cat', [`${A.trabajo}/nota.txt`]).stdout.trim();
res.B_lee_lo_de_A = como(B.usuario, 'cat', [`${A.trabajo}/nota.txt`]).status === 0;
res.B_lista_A = como(B.usuario, 'ls', [A.base]).status === 0;
res.B_lista_raiz = como(B.usuario, 'ls', [path.dirname(A.base)]).status === 0;
res.B_lee_base = como(B.usuario, 'cat', ['/data/superagent.db']).status === 0;
// Un proceso de A con un token en el entorno: B no lo puede leer.
const p = spawn('sleep', ['30'], { uid: A.usuario.uid, gid: A.usuario.gid, env: { TOKEN_A: 'xyz' } });
await new Promise((r) => setTimeout(r, 300));
res.B_lee_entorno_de_A = como(B.usuario, 'cat', [`/proc/${p.pid}/environ`]).status === 0;
// Enlace simbólico: A deja mcp.json apuntando a un archivo de root; el gateway no lo pisa.
fs.writeFileSync('/tmp/victima', 'original', { mode: 0o600 });
como(A.usuario, 'ln', ['-s', '/tmp/victima', `${A.base}/mcp.json`]);
como(A.usuario, 'ln', ['-s', '/etc', `${A.base}/tmp2`]);
ais.escribirArchivo(`${A.base}/mcp.json`, '{"token":"t"}', A.usuario);
res.victima_intacta = fs.readFileSync('/tmp/victima', 'utf8') === 'original';
res.mcp_es_archivo_de_A = (() => { const s = fs.lstatSync(`${A.base}/mcp.json`); return s.isFile() && s.uid === A.usuario.uid && (s.mode & 0o777) === 0o600; })();
// Carpeta reemplazada por un enlace: al preparar de nuevo se repara sin tocar /etc.
fs.rmSync(A.tmp, { recursive: true }); como(A.usuario, 'ln', ['-s', '/etc', A.tmp]);
const etcAntes = fs.statSync('/etc').uid;
ais.preparar('chat:A');
res.tmp_reparado = fs.lstatSync(A.tmp).isDirectory() && !fs.lstatSync(A.tmp).isSymbolicLink() && fs.statSync('/etc').uid === etcAntes;
// Antes de cada corrida se matan los procesos que quedaron de esa conversación.
res.proceso_de_A_muerto = await new Promise((r) => { p.on('exit', () => r(true)); setTimeout(() => r(false), 2000); });
// El mismo chat conserva su usuario.
res.uid_estable = ais.usuarioDe('chat:A').uid === A.usuario.uid;
console.log(JSON.stringify(res, null, 1));
p.kill();
for (const u of [A.usuario, B.usuario]) spawnSync('userdel', [u.nombre]);
fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync('/tmp/victima', { force: true });
const fallas = Object.entries({ B_lee_lo_de_A: false, B_lista_A: false, B_lista_raiz: false, B_lee_base: false, B_lee_entorno_de_A: false, victima_intacta: true, mcp_es_archivo_de_A: true, tmp_reparado: true, proceso_de_A_muerto: true, uid_estable: true })
  .filter(([k, v]) => res[k] !== v).map(([k]) => k);
console.log(fallas.length ? `FALLA: ${fallas.join(', ')}` : 'OK: el aislamiento funciona');
process.exit(fallas.length ? 1 : 0);
