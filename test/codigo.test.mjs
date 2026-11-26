// Etapa 8: trabajo en código y circuito de aprobación del Colaborador, con un repo git de juguete y un
// "remoto" falso (repo bare), más un GitHub falso para el login por dispositivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { armar, persona, escribe } from './ayuda.mjs';

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Prueba', '-c', 'user.email=p@p.test', ...a], { cwd, encoding: 'utf8' }).trim();

function remotoDeJuguete() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-git-'));
  const remoto = path.join(dir, 'remoto.git');
  git(dir, 'init', '--bare', '--initial-branch=main', remoto);
  const w = path.join(dir, 'semilla');
  git(dir, 'clone', remoto, w);
  fs.writeFileSync(path.join(w, 'index.html'), '<h1>Portada vieja</h1>\n');
  git(w, 'add', '-A');
  git(w, 'commit', '-m', 'inicio');
  git(w, 'push', 'origin', 'HEAD:main');
  return { dir, remoto, principal: () => git(dir, '--git-dir', remoto, 'show', 'main:index.html') };
}

/** Guion: el orquestador delega con proyecto; el trabajo cambia la portada, commitea, sube y publica. */
const guionDeCodigo = (spec, ctx, llamar) => {
  if (spec.tipo === 'trabajo') {
    return (async () => {
      const repo = path.join(spec.rutas.trabajo, 'repo');
      fs.writeFileSync(path.join(repo, 'index.html'), '<h1>Portada nueva</h1>\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-m', 'Portada nueva');
      await llamar('subir_rama', {});
      await llamar('abrir_pr', { titulo: 'Portada nueva' });
      await llamar('publicar', { resumen: 'Cambia la portada' });
      return [];
    })();
  }
  if (spec.prompt.includes('cambiá la portada') && !spec.prompt.includes('[T-')) return [{ herramienta: 'delegar_trabajo', args: { descripcion: 'Cambiar la portada del sitio', proyecto: 'sitio' } }];
  return [];
};

function montar(opciones = {}) {
  const r = remotoDeJuguete();
  const t = armar({ guion: guionDeCodigo, ...opciones });
  t.db.prepare("INSERT INTO proyectos (cliente_id, nombre, repo, rama_principal, estado) VALUES (1, 'sitio', ?, 'main', 'activo')").run(r.remoto);
  const duena = persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  const colab = persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  return { t, r, duena, colab, fin: () => { t.limpiar(); fs.rmSync(r.dir, { recursive: true, force: true }); } };
}
const resultados = (t) => t.corridas.find((c) => c.spec.tipo === 'trabajo').resultados.map((x) => x.r.content[0].text);
const linkDe = (t) => t.waha.enviados.map((e) => /\/aprobacion\/(\S+)/.exec(e.texto)?.[1]).find(Boolean);

test('un Colaborador nunca logra un merge sin aprobación; el Propietario aprueba con el link y se publica', async () => {
  const { t, r, fin } = montar();
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'cambiá la portada del sitio' });
  await t.avanzar(46_000);
  const [subir, pr, publicar] = resultados(t);
  assert.match(subir, /Rama superagent\/T-1 subida/);
  assert.match(pr, /no es de GitHub/);
  assert.match(publicar, /Pendiente de aprobación A-1/);
  assert.match(git(r.dir, '--git-dir', r.remoto, 'branch', '--list'), /superagent\/T-1/, 'la rama está en el remoto');
  assert.equal(r.principal(), '<h1>Portada vieja</h1>', 'main no cambió');
  // El Propietario recibe resumen + link; la página muestra el diff.
  const token = linkDe(t);
  const pagina = await (await t.app.request(`/aprobacion/${token}`)).text();
  assert.match(pagina, /\+&lt;h1&gt;Portada nueva/);
  const ok = await t.app.request(`/aprobacion/${token}`, { method: 'POST', body: new URLSearchParams({ decision: 'aprobar' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.match(await ok.text(), /A-1 aprobada/);
  assert.equal(r.principal(), '<h1>Portada nueva</h1>', 'publicó el gateway');
  // Un link usado no sirve.
  const otra = await t.app.request(`/aprobacion/${token}`, { method: 'POST', body: new URLSearchParams({ decision: 'aprobar' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(otra.status, 410);
  // Se avisa en el chat del Colaborador.
  await t.avanzar(2000);
  assert.match(t.corridas.at(-1).spec.prompt, /\[A-1 aprobada\]/);
  fin();
});

test('un link vencido no sirve; "dale" desde otro número no aprueba', async () => {
  const { t, r, fin } = montar();
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'cambiá la portada del sitio' });
  await t.avanzar(46_000);
  const token = linkDe(t);
  t.tiempo.t += 31 * 60_000;
  assert.equal((await t.app.request(`/aprobacion/${token}`)).status, 410);
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'dale A-1' });
  await t.avanzar(46_000);
  assert.equal(t.db.prepare('SELECT estado FROM aprobaciones').get().estado, 'pendiente');
  assert.equal(r.principal(), '<h1>Portada vieja</h1>');
  fin();
});

test('el Propietario publica directo', async () => {
  const { t, r, fin } = montar();
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'cambiá la portada del sitio' });
  await t.avanzar(46_000);
  assert.match(resultados(t)[2], /Rama superagent\/T-1 publicada en sitio/);
  assert.equal(r.principal(), '<h1>Portada nueva</h1>');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM aprobaciones').get().n, 0);
  fin();
});

test('un rechazo vuelve al agente con el comentario; después de 3 rondas no se puede pedir otra', async () => {
  const { t, fin } = montar();
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'cambiá la portada del sitio' });
  await t.avanzar(46_000);
  const token = linkDe(t);
  await t.app.request(`/aprobacion/${token}`, { method: 'POST', body: new URLSearchParams({ decision: 'rechazar', comentario: 'el título va en mayúsculas' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  await t.avanzar(2000);
  assert.match(t.corridas.at(-1).spec.prompt, /\[A-1 rechazada\][\s\S]*el título va en mayúsculas/);
  // Dos rechazos más (por WhatsApp) y la cuarta vez ya no se puede.
  const ctx = t.corridas.find((c) => c.spec.tipo === 'trabajo').ctx;
  for (const n of [2, 3]) {
    const r = await t.nucleo.mcp.llamar(ctx, 'publicar', { resumen: 'otra vez' });
    assert.match(r.content[0].text, new RegExp(`A-${n}`));
    await t.nucleo.aprobaciones.rechazar(`A-${n}`, { personaId: 1, comentario: 'no' });
  }
  const cuarta = await t.nucleo.mcp.llamar(ctx, 'publicar', { resumen: 'otra vez' });
  assert.ok(cuarta.isError && /3 rondas/.test(cuarta.content[0].text));
  fin();
});

test('cambios de instrucciones: el del Colaborador pasa por aprobación con el diff y después entra en las corridas', async () => {
  const { t, fin } = montar({ guion: (spec) => (spec.prompt.includes('formal') ? [{ herramienta: 'cambiar_instrucciones', args: { contenido: 'Hablá siempre de manera formal.', motivo: 'pedido del cliente' } }] : []) });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'a partir de ahora hablá formal' });
  await t.avanzar(46_000);
  const a = t.db.prepare('SELECT * FROM aprobaciones').get();
  assert.match(a.diff, /\+ Hablá siempre de manera formal\./);
  assert.ok(!t.db.prepare('SELECT 1 FROM instrucciones WHERE activa = 1').get());
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'dale A-1' });
  await t.avanzar(0);
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await t.avanzar(46_000);
  assert.match(t.corridas.at(-1).spec.sistema, /Hablá siempre de manera formal/);
  fin();
});

test('GitHub por WhatsApp: el código llega solo a quien puede conectar cuentas y el token queda cifrado', async () => {
  const pedidos = [];
  let autorizado = false;
  const fetchGithub = async (url, o = {}) => {
    const u = new URL(url);
    pedidos.push(u.pathname);
    const json = (d) => new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/login/device/code') return json({ device_code: 'dc-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900 });
    if (u.pathname === '/login/oauth/access_token') return json(autorizado ? { access_token: 'gho_tokendeprueba123456789012345', token_type: 'bearer' } : { error: 'authorization_pending' });
    return new Response('{}', { status: 404 });
  };
  const t = armar({
    fetchGithub,
    guion: (spec) => (spec.prompt.includes('github') ? [{ herramienta: 'conectar_app', args: { app: 'github' } }] : []),
  });
  t.config.github = { clientId: 'Iv1.prueba', web: 'https://github.com', api: 'https://api.github.com' };
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'conectá github' });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'conectá github' });
  await t.avanzar(46_000);
  const colab = t.corridas.find((c) => c.spec.personaId === 2);
  assert.ok(!colab.spec.herramientasGateway.includes('conectar_app'), 'el Colaborador no la tiene');
  const aviso = t.waha.enviados.find((e) => /ABCD-1234/.test(e.texto));
  assert.equal(aviso.chatId, '5491111111111@c.us', 'el link y el código los manda el gateway, al Propietario');
  autorizado = true;
  // El sondeo corre en segundo plano con el intervalo de GitHub.
  for (let i = 0; i < 40 && !t.nucleo.github.conectado(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(t.nucleo.github.conectado());
  const c = t.db.prepare("SELECT credencial FROM conexiones WHERE app = 'github'").get();
  assert.ok(!c.credencial.includes('gho_tokendeprueba'), 'cifrado');
  assert.ok(!JSON.stringify(t.corridas.map((x) => x.args)).includes('gho_'), 'nunca en una corrida');
  t.limpiar();
});
