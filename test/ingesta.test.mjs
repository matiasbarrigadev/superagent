// Etapa 1: entrada y salida de WhatsApp con payloads grabados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { abrirBase } from '../src/db/index.mjs';
import { crearIngesta, normalizarJid, analizarGrupo } from '../src/wa/webhook.mjs';
import { crearSalida, partir } from '../src/wa/salida.mjs';
import { crearAjustes } from '../src/util.mjs';
import { armar, silencio } from './ayuda.mjs';

const payload = (n) => JSON.parse(fs.readFileSync(new URL(`./payloads/${n}.json`, import.meta.url), 'utf8'));

function wahaFalso() {
  const llamadas = [];
  return {
    llamadas,
    telefonoDeLid: async (lid) => { llamadas.push(['lid', lid]); return lid === '111122223333444@lid' ? '5491166667777' : lid === '222233334444555@lid' ? '5491188889999' : null; },
    lidDeTelefono: async () => '999988887777666@lid',
    descargar: async (url) => { llamadas.push(['descargar', url]); return { datos: Buffer.from('%PDF-1.4 prueba'), tipo: 'application/pdf' }; },
    enviarTexto: async (chatId, texto, o) => { llamadas.push(['texto', chatId, texto, o?.responderA ?? null]); return 'id'; },
  };
}

function montar({ dataDir = null, nombreAgente = null } = {}) {
  const db = abrirBase(':memory:');
  const ajustes = crearAjustes(db);
  if (nombreAgente) ajustes.set('nombre_agente', nombreAgente);
  const waha = wahaFalso();
  const avisados = [];
  const procesar = crearIngesta({ db, waha, ajustes, config: { dataDir }, alMensaje: (m) => avisados.push(m), log: silencio });
  return { db, waha, avisados, procesar, ajustes };
}

test('normaliza JIDs de GOWS: @s.whatsapp.net y :dispositivo', () => {
  assert.equal(normalizarJid('5491122223333:12@s.whatsapp.net'), '5491122223333@c.us');
  assert.equal(normalizarJid('120363000000000001@g.us'), '120363000000000001@g.us');
  assert.equal(normalizarJid('111@lid'), '111@lid');
});

test('directo: guarda una vez (UNIQUE session,id), crea chat activo y persona automática como Tercero', async () => {
  const { db, procesar, avisados } = montar();
  assert.equal(await procesar(payload('directo-texto')), 'guardado');
  assert.equal(await procesar(payload('directo-texto')), 'duplicado');
  const m = db.prepare('SELECT * FROM mensajes').all();
  assert.equal(m.length, 1);
  assert.equal(m[0].chat_id, '5491122223333@c.us');
  assert.equal(m[0].telefono, '5491122223333');
  assert.equal(m[0].nombre_remitente, 'Juan');
  assert.equal(m[0].procesado, 0);
  const chat = db.prepare('SELECT * FROM chats').get();
  assert.equal(chat.tipo, 'directo');
  assert.equal(chat.activo, 1);
  const p = db.prepare('SELECT p.*, r.nombre AS rol FROM personas p JOIN roles r ON r.id = p.rol_id').get();
  assert.equal(p.rol, 'Tercero');
  assert.equal(p.alta_manual, 0);
  assert.equal(avisados.length, 1, 'el motor se entera una sola vez');
});

test('LID: se resuelve a teléfono con WAHA y queda en caché', async () => {
  const { db, procesar, waha } = montar();
  await procesar(payload('directo-lid'));
  const otro = payload('directo-lid');
  otro.payload.id = 'false_111122223333444@lid_3EB0AAAA0099';
  await procesar(otro);
  assert.equal(waha.llamadas.filter((l) => l[0] === 'lid').length, 1, 'la segunda vez sale de la tabla lids');
  assert.equal(db.prepare('SELECT telefono FROM lids WHERE lid = ?').get('111122223333444@lid').telefono, '5491166667777');
  const p = db.prepare('SELECT telefono, lid FROM personas').get();
  assert.equal(p.telefono, '5491166667777');
  assert.equal(p.lid, '111122223333444@lid');
});

test('LID de alguien dado de alta: se reconoce a la persona por su número', async () => {
  const { db, procesar } = montar();
  const colab = db.prepare("SELECT id FROM roles WHERE nombre = 'Colaborador'").get().id;
  db.prepare('INSERT INTO personas (nombre, telefono, rol_id, alta_manual, creada) VALUES (?, ?, ?, 1, 0)').run('Ana', '541166667777', colab);
  await procesar(payload('directo-lid'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personas').get().n, 1, 'no crea otra persona');
  assert.equal(db.prepare('SELECT persona_id FROM mensajes').get().persona_id, 1);
});

test('grupo: nace inactivo; sin mención no es para el agente', async () => {
  const { db, procesar, avisados } = montar();
  await procesar(payload('grupo-sin-mencion'));
  assert.equal(db.prepare('SELECT activo FROM chats WHERE tipo = ?').get('grupo').activo, 0);
  const m = db.prepare('SELECT * FROM mensajes').get();
  assert.equal(m.remitente, '5491144445555@c.us');
  assert.equal(m.menciona, 0);
  assert.equal(m.responde_al_agente, 0);
  assert.equal(avisados[0].grupo, true);
});

test('grupo: mención por JID, por LID, respuesta a un mensaje del agente y por nombre', async () => {
  const { db, procesar } = montar({ nombreAgente: 'Nina' });
  await procesar(payload('grupo-mencion'));
  await procesar(payload('grupo-mencion-lid'));
  await procesar(payload('grupo-respuesta'));
  const porNombre = payload('grupo-sin-mencion');
  porNombre.payload.id = 'false_g_3EB0AAAA0010';
  porNombre.payload.body = 'Nina, ¿podés mirar esto?';
  await procesar(porNombre);
  const filas = db.prepare('SELECT body_id, menciona, responde_al_agente FROM (SELECT id AS body_id, menciona, responde_al_agente, seq FROM mensajes) ORDER BY seq').all();
  assert.deepEqual(filas.map((f) => [f.menciona, f.responde_al_agente]), [[1, 0], [1, 0], [0, 1], [1, 0]]);
  // El participante con LID también se resuelve.
  assert.equal(db.prepare("SELECT telefono FROM mensajes WHERE remitente = '222233334444555@lid'").get().telefono, '5491188889999');
});

test('grupo: el nombre del agente dentro de otra palabra no cuenta como mención', () => {
  const r = analizarGrupo({ body: 'Ninaaa jaja', _data: {} }, { meTelefono: '1@c.us', nombreAgente: 'Nina' });
  assert.equal(r.menciona, false);
});

test('mensaje propio (fromMe): nace procesado y no despierta al motor', async () => {
  const { db, procesar, avisados } = montar();
  await procesar(payload('propio'));
  const m = db.prepare('SELECT * FROM mensajes').get();
  assert.equal(m.chat_id, '5491122223333@c.us');
  assert.equal(m.from_me, 1);
  assert.equal(m.procesado, 1);
  assert.equal(avisados.length, 0);
});

test('adjunto: se descarga de WAHA (solo la ruta /api/files) a la carpeta de adjuntos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-adj-'));
  const { db, procesar, waha } = montar({ dataDir: dir });
  await procesar(payload('directo-adjunto'));
  await new Promise((r) => setTimeout(r, 30));
  const a = db.prepare('SELECT * FROM adjuntos').get();
  assert.equal(a.estado, 'listo');
  assert.equal(a.tipo, 'pdf');
  assert.ok(fs.readFileSync(a.ruta, 'utf8').startsWith('%PDF'));
  assert.ok(path.basename(a.ruta).endsWith('presupuesto_final.pdf'));
  assert.deepEqual(waha.llamadas.find((l) => l[0] === 'descargar'), ['descargar', 'http://localhost:3000/api/files/default/3EB0AAAA0007.pdf']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('session.status queda en eventos_wa', async () => {
  const { db, procesar } = montar();
  assert.equal(await procesar(payload('estado-working')), 'estado');
  assert.equal(db.prepare('SELECT estado FROM eventos_wa').get().estado, 'WORKING');
});

test('webhook HTTP: firma válida entra, firma inválida no', async () => {
  const { app, db, config } = armar();
  const cuerpo = JSON.stringify(payload('directo-texto'));
  const firma = crypto.createHmac('sha512', config.waha.hmacKey).update(cuerpo).digest('hex');
  const mal = await app.request('/webhook/waha', { method: 'POST', body: cuerpo, headers: { 'x-webhook-hmac': 'f'.repeat(128) } });
  assert.equal(mal.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mensajes').get().n, 0);
  const bien = await app.request('/webhook/waha', { method: 'POST', body: cuerpo, headers: { 'x-webhook-hmac': firma } });
  assert.equal(bien.status, 200);
  assert.equal((await bien.json()).resultado, 'guardado');
});

test('salida: parte textos largos y reintenta si WAHA falla', async () => {
  assert.equal(partir('a'.repeat(9000)).length, 3);
  const db = abrirBase(':memory:');
  let falla = true;
  const enviados = [];
  let ahora = 1_000_000;
  const salida = crearSalida({
    db, ajustes: crearAjustes(db), reloj: () => ahora, log: silencio,
    waha: { enviarTexto: async (c, t) => { if (falla) throw new Error('caído'); enviados.push(t); } },
  });
  salida.encolar({ chatId: '1@c.us', texto: 'hola' });
  assert.equal(await salida.procesar(), 0);
  falla = false;
  assert.equal(await salida.procesar(), 0, 'espera el reintento');
  ahora += 60_000;
  assert.equal(await salida.procesar(), 1);
  assert.deepEqual(enviados, ['hola']);
});

test('salida: ritmo suave solo para contactos nuevos; las respuestas no esperan', async () => {
  const db = abrirBase(':memory:');
  const ajustes = crearAjustes(db);
  ajustes.set('ritmo_por_hora', 2);
  ajustes.set('ritmo_espaciado_min', 5);
  let ahora = 10_000_000;
  const enviados = [];
  const salida = crearSalida({ db, ajustes, reloj: () => ahora, log: silencio, waha: { enviarTexto: async (c) => { enviados.push(c); } } });
  salida.encolar({ chatId: 'n1@c.us', texto: 'hola', contactoNuevo: true });
  salida.encolar({ chatId: 'n2@c.us', texto: 'hola', contactoNuevo: true });
  salida.encolar({ chatId: 'r1@c.us', texto: 'respuesta' });
  await salida.procesar();
  assert.deepEqual(enviados, ['n1@c.us', 'r1@c.us'], 'el segundo contacto nuevo espera; la respuesta sale igual');
  ahora += 5 * 60_000;
  await salida.procesar();
  assert.deepEqual(enviados, ['n1@c.us', 'r1@c.us', 'n2@c.us']);
  salida.encolar({ chatId: 'n3@c.us', texto: 'hola', contactoNuevo: true });
  ahora += 10 * 60_000;
  await salida.procesar();
  assert.equal(enviados.length, 3, 'tope de 2 por hora: el tercero queda en espera');
  ahora += 60 * 60_000;
  await salida.procesar();
  assert.equal(enviados.at(-1), 'n3@c.us');
});

test('salida al panel: queda como mensaje propio del chat del panel', async () => {
  const db = abrirBase(':memory:');
  const salida = crearSalida({ db, ajustes: crearAjustes(db), waha: {}, log: silencio });
  salida.encolar({ chatId: 'panel:1', texto: 'hola desde el agente' });
  await salida.procesar();
  const m = db.prepare("SELECT * FROM mensajes WHERE chat_id = 'panel:1'").get();
  assert.equal(m.from_me, 1);
  assert.equal(m.canal, 'panel');
});

test('LID: el directo queda en el chat del teléfono, junto con lo que ya había por @c.us', async () => {
  const { db, procesar } = montar();
  db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, nombre, creado) VALUES ('5491166667777@c.us', 'directo', 1, 1, '', 0)").run();
  await procesar(payload('directo-lid'));
  assert.deepEqual(db.prepare('SELECT id FROM chats').all().map((c) => c.id), ['5491166667777@c.us']);
  assert.equal(db.prepare('SELECT chat_id FROM mensajes').get().chat_id, '5491166667777@c.us');
});

test('al arrancar, un chat @lid viejo se fusiona con el del teléfono (mensajes y leídos incluidos)', async () => {
  const { unificarChatsLid } = await import('../src/wa/unificar.mjs');
  const db = abrirBase(':memory:');
  const ins = db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, nombre, creado) VALUES (?, 'directo', 1, ?, ?, 0)");
  ins.run('777@lid', 1, 'Matías');
  ins.run('5491100001111@c.us', 0, '');
  db.prepare("INSERT INTO lids (lid, telefono, actualizado) VALUES ('777@lid', '5491100001111', 0)").run();
  db.prepare(`INSERT INTO mensajes (session, id, chat_id, from_me, tipo, cuerpo, tiene_adjunto, ts, procesado, recibido)
    VALUES ('default', 'x1', '777@lid', 0, 'chat', 'hola', 0, 1, 1, 1)`).run();
  db.prepare("INSERT INTO ajustes (clave, valor) VALUES ('inbox_leido:777@lid', '5')").run();
  assert.equal(unificarChatsLid(db, silencio), 1);
  const chats = db.prepare('SELECT * FROM chats').all();
  assert.equal(chats.length, 1);
  assert.equal(chats[0].id, '5491100001111@c.us');
  assert.equal(chats[0].activo, 1);
  assert.equal(chats[0].nombre, 'Matías');
  assert.equal(db.prepare('SELECT chat_id FROM mensajes').get().chat_id, '5491100001111@c.us');
  assert.equal(db.prepare("SELECT valor FROM ajustes WHERE clave = 'inbox_leido:5491100001111@c.us'").get().valor, '5');
});

test('mensaje propio en un grupo: queda en el grupo aunque GOWS ponga el propio número como destino', async () => {
  const { db, procesar } = montar();
  await procesar({
    event: 'message.any', session: 'default', me: { id: '5491100000001@c.us' },
    payload: { id: 'true_g_1', fromMe: true, from: '5491100000001@c.us', to: '5491100000001@c.us', body: 'Hola a todos', timestamp: 1,
      _data: { Info: { Chat: '120363000000000011@g.us', IsFromMe: true } } },
  });
  assert.equal(db.prepare('SELECT chat_id FROM mensajes').get().chat_id, '120363000000000011@g.us');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chats WHERE id = '5491100000001@c.us'").get().n, 0);
});

test('reparación: lo propio guardado en el chat del propio número vuelve a su chat según la salida', async () => {
  const { repararChatPropio } = await import('../src/wa/unificar.mjs');
  const db = abrirBase(':memory:');
  db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, nombre, creado) VALUES ('5491100000001@c.us', 'directo', 1, 1, '', 0), ('120363000000000011@g.us', 'grupo', 1, 1, 'Equipo', 0)").run();
  db.prepare("INSERT INTO salida (chat_id, contenido, estado, creado) VALUES ('120363000000000011@g.us', 'Hola a todos', 'enviado', 0)").run();
  db.prepare(`INSERT INTO mensajes (session, id, chat_id, from_me, tipo, cuerpo, tiene_adjunto, ts, procesado, recibido)
    VALUES ('default', 'x1', '5491100000001@c.us', 1, 'chat', 'Hola a todos', 0, 1, 1, 1)`).run();
  assert.equal(repararChatPropio(db, '5491100000001@c.us', silencio), 1);
  assert.equal(db.prepare('SELECT chat_id FROM mensajes').get().chat_id, '120363000000000011@g.us');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chats WHERE id = '5491100000001@c.us'").get().n, 0);
});
