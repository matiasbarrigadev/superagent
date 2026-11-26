// Verifica una corrida de publicación real: clon limpio de la principal, pasos con /bin/sh y un usuario aislado,
// credencial solo en el entorno de esos comandos, salida tachada, verificación HTTP y limpieza.
// Dentro del contenedor, como root:  docker compose exec superagent node scripts/verificar-publicacion.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { abrirBase } from '../src/db/index.mjs';
import { crearAislamiento } from '../src/claude/aislamiento.mjs';
import { crearRepos } from '../src/codigo/repos.mjs';
import { crearProcedimientos } from '../src/codigo/procedimiento.mjs';

const dir = '/tmp/verificar-publicacion';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true, mode: 0o711 });
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=P', '-c', 'user.email=p@p', ...a], { cwd, encoding: 'utf8' }).trim();
const remoto = path.join(dir, 'remoto.git');
git(dir, 'init', '-q', '--bare', '--initial-branch=main', remoto);
git(dir, 'clone', '-q', remoto, path.join(dir, 's'));
fs.writeFileSync(path.join(dir, 's', 'index.html'), '<h1>Bienvenidos</h1>\n');
git(path.join(dir, 's'), 'add', '-A'); git(path.join(dir, 's'), 'commit', '-qm', 'i'); git(path.join(dir, 's'), 'push', '-q', 'origin', 'HEAD:main');

// "Producción": un servidor local que sirve lo que dejó el deploy.
const publicado = path.join(dir, 'publicado');
fs.mkdirSync(publicado, { mode: 0o777 }); fs.chmodSync(publicado, 0o777);
const srv = http.createServer((q, r) => { const f = path.join(publicado, 'index.html'); r.end(fs.existsSync(f) ? fs.readFileSync(f) : 'vacío'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;

const db = abrirBase(':memory:');
db.prepare("INSERT INTO proyectos (id, cliente_id, nombre, repo, rama_principal) VALUES (1, 1, 'sitio', ?, 'main')").run(remoto);
const dataDir = path.join(dir, 'data');
fs.mkdirSync(dataDir, { mode: 0o711 });
const config = { dataDir, sessionSecret: 'x'.repeat(48), uidBase: 29400, esperaVerificacionMs: 200 };
const ais = crearAislamiento({ db, config, log: console });
const repos = crearRepos({ db, config, aislamiento: ais, github: null });
const proc = crearProcedimientos({ db, config, aislamiento: ais, repos, log: console });
const TOKEN = 'tok_real_de_prueba_5f3a9c';
proc.guardar(1, {
  dominios: ['127.0.0.1'],
  procedimiento: {
    respaldo: 'echo "respaldo con $VERCEL_TOKEN" && id -un',
    ensayo: 'test -f index.html',
    migraciones: 'echo "sin migraciones"',
    deploy: `cp index.html ${publicado}/index.html && echo "deploy ok, token $VERCEL_TOKEN" && echo "VERCEL_TOKEN=$VERCEL_TOKEN" > .env`,
    verificacion: [{ url, contiene: 'Bienvenidos' }],
  },
});
proc.guardarCredencial(1, { proveedor: 'vercel', valor: TOKEN });
const r = await proc.publicar(1, { pedidaPor: null });
const fila = db.prepare('SELECT * FROM publicaciones').get();
const lugar = ais.rutas('publicacion:1');
const res = {
  ok: r.ok,
  pasos: r.pasos.map((p) => `${p.paso}:${p.estado}`).join(' '),
  corrio_con_usuario_aislado: /sa29401/.test(r.pasos[0].salida),
  token_tachado: !JSON.stringify(fila).includes(TOKEN) && r.pasos[0].salida.includes('[secreto]'),
  sin_restos: !fs.existsSync(path.join(lugar.trabajo, 'repo')) && fs.readdirSync(lugar.tmp).length === 0,
};
const cli = Object.fromEntries(['wrangler', 'vercel', 'supabase', 'gh'].map((c) => [c, spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 60_000 }).status === 0]));
srv.close();
ais.terminar({ usuario: ais.usuarioDe('publicacion:1'), base: lugar.base });
spawnSync('userdel', [ais.usuarioDe('publicacion:1').nombre]);
fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ ...res, cli }, null, 1));
const ok = res.ok && res.corrio_con_usuario_aislado && res.token_tachado && res.sin_restos && Object.values(cli).every(Boolean);
console.log(ok ? 'OK: la publicación funciona' : 'FALLA');
process.exit(ok ? 0 : 1);
