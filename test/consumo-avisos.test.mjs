// Consumo de Claude visible para quien corresponde, avisos por umbral y avisos del entorno del Propietario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { armar, persona, escribe, silencio } from './ayuda.mjs';
import { crearConsumo } from '../src/servicios/consumo.mjs';

test('el Propietario ve el consumo en cada corrida; un Colaborador sin el permiso, no; con el permiso, sí', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  const ana = persona(t.db, { nombre: 'Ana', telefono: '5491122222222', rol: 'Colaborador', verificada: 1 });
  t.db.prepare("INSERT INTO corridas (tipo, chat_id, estado, inicio, tokens_entrada, tokens_cache, tokens_salida, costo_usd, contexto_tokens) VALUES ('orquestador', '5491111111111@c.us', 'ok', ?, 1000, 50000, 300, 0.42, 51000)").run(t.tiempo.t - 1000);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'hola' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await t.avanzar(46_000);
  const de = (tel) => t.corridas.filter((c) => c.spec.chatId === `${tel}@c.us`).at(-1).spec;
  assert.match(de('5491111111111').prompt, /Consumo de Claude: .*1 corridas, 51k tokens \(≈ US\$ 0\.42.*contexto de esta conversación: 51k tokens \(se compacta solo al 60%\)/);
  assert.ok(de('5491111111111').herramientasGateway.includes('consumo'));
  assert.equal(de('5491111111111').compactarPct, 60);
  assert.doesNotMatch(de('5491122222222').prompt, /Consumo de Claude/);
  const rolAna = t.db.prepare('SELECT rol_id FROM personas WHERE id = ?').get(ana).rol_id;
  const p = JSON.parse(t.db.prepare('SELECT permisos FROM roles WHERE id = ?').get(rolAna).permisos);
  t.db.prepare('UPDATE roles SET permisos = ? WHERE id = ?').run(JSON.stringify({ ...p, ver_consumo: true }), rolAna);
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'otra' });
  await t.avanzar(46_000);
  assert.match(de('5491122222222').prompt, /Consumo de Claude/);
  t.limpiar();
});

test('aviso de consumo: una vez por ventana, al Propietario y a quien tenga el permiso', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  let pct = 50;
  const c = crearConsumo({ db: t.db, ajustes: t.nucleo.ajustes, politica: t.nucleo.politica, salida: t.nucleo.salida, avisos: t.nucleo.avisos,
    plan: async () => ({ cincoHoras: { pct, reinicia: 1_800_018_000_000 }, semana: { pct: 20 } }), reloj: () => t.tiempo.t, log: silencio });
  assert.equal(await c.revisar(), null);
  pct = 85;
  await c.delPlan({ fresco: true });
  assert.match(await c.revisar(), /85% del plan \(ventana de 5 horas\)/);
  assert.equal(await c.revisar(), null, 'no repite en la misma ventana');
  assert.match(t.db.prepare("SELECT texto FROM avisos ORDER BY id DESC LIMIT 1").get().texto, /Aviso de consumo/);
  t.limpiar();
});

test('lo que termina en segundo plano en el entorno del Propietario lo despierta en su último chat', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'logueate en github' });
  await t.avanzar(5000);
  const lugar = t.nucleo.aislamiento.preparar('propietario');
  t.nucleo.aislamiento.terminar(lugar);
  fs.writeFileSync(path.join(lugar.base, 'avisos', 'gh.txt'), 'gh: Logged in to github.com');
  await t.avanzar(6000);
  await t.avanzar(2000);
  const ultima = t.corridas.at(-1);
  assert.equal(ultima.spec.chatId, '5491111111111@c.us');
  assert.match(ultima.spec.prompt, /\[aviso de tu entorno: gh\.txt\] gh: Logged in to github\.com/);
  assert.equal(fs.readdirSync(path.join(lugar.base, 'avisos')).length, 0, 'el aviso se consume');
  t.limpiar();
});
