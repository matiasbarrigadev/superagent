// Etapa 8c: publicación real con procedimiento por proyecto y credenciales solo dentro de la corrida de publicación.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { armar, persona, escribe, entrarComoPropietario } from './ayuda.mjs';

const TOKEN = 'vcl_token_super_secreto_987654321';
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=P', '-c', 'user.email=p@p.test', ...a], { cwd, encoding: 'utf8' }).trim();

function montar({ falla = null, contenido = 'Bienvenidos a Sitio' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pub-'));
  const remoto = path.join(dir, 'remoto.git');
  git(dir, 'init', '--bare', '--initial-branch=main', remoto);
  git(dir, 'clone', remoto, path.join(dir, 's'));
  fs.writeFileSync(path.join(dir, 's', 'index.html'), 'hola\n');
  git(path.join(dir, 's'), 'add', '-A'); git(path.join(dir, 's'), 'commit', '-m', 'i'); git(path.join(dir, 's'), 'push', 'origin', 'HEAD:main');
  const pasos = [];
  const t = armar({
    correrPasos: async (cmd, o) => {
      pasos.push({ cmd, env: o.env, cwd: o.cwd });
      if (falla && cmd.includes(falla)) return { codigo: 1, salida: `error en ${falla}, token=${o.env.VERCEL_TOKEN}` };
      return { codigo: 0, salida: `ok ${cmd} con ${o.env.VERCEL_TOKEN} y ${Buffer.from(o.env.VERCEL_TOKEN).toString('base64')}` };
    },
    fetchVerificacion: async () => new Response(`<h1>${contenido}</h1>`, { status: 200 }),
    guion: (spec) => (spec.prompt.includes('publicá el sitio') ? [{ herramienta: 'publicar', args: { proyecto: 'sitio', resumen: 'deploy de la portada' } }] : []),
  });
  t.config.esperaVerificacionMs = 1;
  t.db.prepare("INSERT INTO proyectos (cliente_id, nombre, repo, rama_principal) VALUES (1, 'sitio', ?, 'main')").run(remoto);
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  const proc = t.nucleo.procedimientos;
  proc.guardar(1, {
    dominios: ['sitio.test'],
    procedimiento: { respaldo: 'respaldar-base', ensayo: 'npm test', migraciones: 'migrar', deploy: 'vercel deploy --prod', verificacion: [{ url: 'https://www.sitio.test/', contiene: 'Bienvenidos' }] },
  });
  proc.guardarCredencial(1, { proveedor: 'vercel', valor: TOKEN, alcance: 'solo el proyecto sitio' });
  return { t, pasos, fin: () => { t.limpiar(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const pub = (t) => t.db.prepare('SELECT * FROM publicaciones ORDER BY id DESC').get();

test('el Propietario publica: los cinco pasos en orden, con la credencial solo en esos comandos, y el token tachado en todo', async () => {
  const { t, pasos, fin } = montar();
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'publicá el sitio' });
  await t.avanzar(46_000);
  assert.deepEqual(pasos.map((p) => p.cmd), ['respaldar-base', 'npm test', 'migrar', 'vercel deploy --prod']);
  assert.ok(pasos.every((p) => p.env.VERCEL_TOKEN === TOKEN && path.basename(p.cwd) === 'repo'));
  const p = pub(t);
  assert.equal(p.estado, 'ok');
  assert.deepEqual(JSON.parse(p.credenciales_usadas), ['VERCEL_TOKEN'], 'solo el nombre de la variable');
  const resultado = t.corridas[0].resultados[0].r.content[0].text;
  assert.match(resultado, /sitio publicado/);
  const todo = JSON.stringify([
    t.db.prepare('SELECT * FROM publicaciones').all(), t.db.prepare('SELECT * FROM auditoria').all(),
    t.db.prepare('SELECT * FROM memoria').all(), resultado, t.waha.enviados,
  ]);
  assert.ok(!todo.includes(TOKEN) && !todo.includes(Buffer.from(TOKEN).toString('base64')), 'el token no aparece en ningún lado');
  assert.match(JSON.parse(p.pasos)[3].salida, /\[secreto\]/);
  // Las corridas que no son de publicación no tienen la credencial.
  assert.ok(!JSON.stringify(t.corridas.map((c) => ({ args: c.args, prompt: c.spec.prompt, sistema: c.spec.sistema }))).includes(TOKEN));
  fin();
});

test('un paso que falla frena los siguientes', async () => {
  const { t, pasos, fin } = montar({ falla: 'npm test' });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'publicá el sitio' });
  await t.avanzar(46_000);
  assert.deepEqual(pasos.map((p) => p.cmd), ['respaldar-base', 'npm test']);
  const p = pub(t);
  assert.equal(p.estado, 'fallida');
  assert.deepEqual(JSON.parse(p.pasos).map((x) => x.estado), ['ok', 'fallido', 'omitido', 'omitido', 'omitido']);
  assert.match(t.corridas[0].resultados[0].r.content[0].text, /falló en "ensayo"/);
  assert.ok(!JSON.stringify(p).includes(TOKEN));
  fin();
});

test('una verificación que solo recibe un 200, sin el contenido esperado, se marca como fallida', async () => {
  const { t, fin } = montar({ contenido: 'Página en mantenimiento' });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'publicá el sitio' });
  await t.avanzar(46_000);
  const p = pub(t);
  assert.equal(p.estado, 'fallida');
  assert.match(JSON.parse(p.pasos)[4].salida, /200, pero no aparece "Bienvenidos"/);
  fin();
});

test('un Colaborador no publica sin aprobación; al aprobar corre el procedimiento', async () => {
  const { t, pasos, fin } = montar();
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'publicá el sitio' });
  await t.avanzar(46_000);
  assert.match(t.corridas[0].resultados[0].r.content[0].text, /Pendiente de aprobación A-1/);
  assert.equal(pasos.length, 0);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'dale A-1' });
  await t.avanzar(0);
  assert.equal(pasos.length, 4, JSON.stringify(t.waha.enviados.map((e) => e.texto)));
  assert.equal(pub(t).aprobacion_id, 'A-1');
  assert.equal(t.db.prepare('SELECT estado FROM aprobaciones').get().estado, 'aprobada');
  fin();
});

test('procedimiento: los cinco pasos son obligatorios y la verificación va contra los dominios del proyecto', async () => {
  const { t, fin } = montar();
  await entrarComoPropietario(t);
  const malo = await t.pedir('PUT', '/api/proyectos/1/procedimiento', { dominios: ['sitio.test'], procedimiento: { respaldo: 'x', ensayo: 'y', deploy: 'z', verificacion: [{ url: 'https://sitio.test', contiene: 'a' }] } });
  assert.match(malo.json.error, /Falta el paso "migraciones"/);
  const afuera = await t.pedir('PUT', '/api/proyectos/1/procedimiento', { dominios: ['sitio.test'], procedimiento: { respaldo: 'x', ensayo: 'y', migraciones: 'm', deploy: 'z', verificacion: [{ url: 'https://evil.test', contiene: 'a' }] } });
  assert.match(afuera.json.error, /dominios del proyecto/);
  const ok = await t.pedir('PUT', '/api/proyectos/1/procedimiento', { procedimiento: { respaldo: 'x', ensayo: 'y', migraciones: 'm', deploy: 'z', verificacion: [{ url: 'https://sitio.test', contiene: 'a' }] } });
  assert.equal(ok.json.version, 2, 'versionado');
  const info = (await t.pedir('GET', '/api/proyectos/1/publicacion')).json;
  assert.deepEqual(info.credenciales.map((c) => c.variable), ['VERCEL_TOKEN']);
  assert.ok(!JSON.stringify(info).includes(TOKEN), 'el panel nunca devuelve el valor');
  // Rotación: mismo nombre de variable, valor nuevo.
  await t.pedir('POST', '/api/proyectos/1/credenciales', { proveedor: 'vercel', valor: 'otro-token-1234' });
  assert.equal((await t.pedir('GET', '/api/proyectos/1/publicacion')).json.credenciales.length, 1);
  assert.ok(t.db.prepare('SELECT rotada FROM credenciales_proyecto').get().rotada);
  fin();
});

test('sin procedimiento, publicar falla con un mensaje claro', async () => {
  const { t, fin } = montar();
  t.db.prepare('UPDATE proyectos SET procedimiento_publicacion = NULL').run();
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'publicá el sitio' });
  await t.avanzar(46_000);
  const r = t.corridas[0].resultados[0].r;
  assert.ok(r.isError && /no tiene un procedimiento de publicación/.test(r.content[0].text));
  fin();
});
