// WhatsApp completo: el agente cita, reacciona, manda fotos como foto o como documento, ubicaciones, contactos y
// encuestas, edita y borra lo suyo, todo dentro de su conversación; llegan reacciones, ediciones, borrados y votos;
// y la bandeja muestra los adjuntos sin dejar que un archivo ajeno corra en el panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { armar, persona, entrarComoPropietario } from './ayuda.mjs';

let n = 0;
const entra = (t, de, texto, extra = {}) => {
  n++;
  return t.nucleo.ingesta({ event: 'message.any', session: 'default', me: { id: '5491100000001@c.us' }, payload: { id: `false_${de}@c.us_W${n}`, timestamp: 1_800_000_000 + n, from: `${de}@c.us`, fromMe: false, body: texto, hasMedia: false, _data: { Info: { PushName: 'Alguien' } }, ...extra } });
};
const ultimoM = (spec) => [...spec.prompt.matchAll(/M-(\d+)\]/g)].pop()?.[0].replace(']', '');

test('el agente reacciona, cita, manda ubicación, contacto y encuesta, y edita o borra solo lo suyo', async () => {
  const t = armar({
    guion: (spec) => {
      const m = ultimoM(spec);
      if (spec.prompt.includes('reaccioná')) return [{ herramienta: 'reaccionar', args: { mensaje: m, emoji: '👍' } }];
      if (spec.prompt.includes('citame')) return [{ herramienta: 'responder', args: { texto: 'te cito', citar: m } }];
      if (spec.prompt.includes('dónde quedan')) return [{ herramienta: 'enviar_ubicacion', args: { latitud: -34.6, longitud: -58.38, titulo: 'Oficina' } }, { herramienta: 'enviar_contacto', args: { nombre: 'Soporte', telefono: '+54 9 11 5555-0001' } }];
      if (spec.prompt.includes('votemos')) return [{ herramienta: 'enviar_encuesta', args: { pregunta: '¿Qué día?', opciones: ['Lunes', 'Martes'] } }];
      if (spec.prompt.includes('corregí')) {
        const s = `S-${t.db.prepare("SELECT id FROM salida WHERE contenido = 'te cito'").get().id}`;
        return [{ herramienta: 'editar_mensaje', args: { mensaje: s, texto: 'texto corregido' } }, { herramienta: 'borrar_mensaje', args: { mensaje: m } }];
      }
      return [];
    },
  });
  persona(t.db, { nombre: 'Ana', telefono: '5491122222222', rol: 'Colaborador' });
  const txt = (i = 0) => t.corridas.at(-1).resultados[i].r.content[0].text;

  await entra(t, '5491122222222', 'reaccioná a esto');
  await t.avanzar(46_000);
  assert.match(t.corridas.at(-1).spec.prompt, / · M-\d+\] Ana \(Colaborador\): reaccioná a esto/);
  assert.match(txt(), /Reaccionaste 👍 a M-\d+/);
  const r = t.waha.enviados.find((e) => e.reaccion);
  assert.deepEqual([r.reaccion, r.mensajeId.startsWith('false_5491122222222@c.us_W')], ['👍', true]);

  await entra(t, '5491122222222', 'citame por favor');
  await t.avanzar(46_000);
  assert.match(txt(), /Enviado \(S-\d+\)/);
  assert.match(t.waha.enviados.find((e) => e.texto === 'te cito').responderA, /^false_5491122222222@c\.us_W/);

  await entra(t, '5491122222222', '¿dónde quedan?');
  await t.avanzar(46_000);
  assert.deepEqual(t.waha.enviados.find((e) => e.ubicacion).ubicacion, { latitud: -34.6, longitud: -58.38, titulo: 'Oficina' });
  assert.equal(t.waha.enviados.find((e) => e.contacto).contacto.telefono, '5491155550001');

  await entra(t, '5491122222222', 'votemos');
  await t.avanzar(46_000);
  const enc = t.waha.enviados.find((e) => e.encuesta);
  assert.deepEqual(enc.encuesta.opciones, ['Lunes', 'Martes']);
  // Llega un voto: el agente se entera en esa charla.
  const idEncuesta = t.db.prepare("SELECT waha_id FROM salida WHERE tipo = 'encuesta'").get().waha_id;
  await t.nucleo.ingesta({ event: 'poll.vote', session: 'default', payload: { vote: { id: 'v1', from: '5491122222222@c.us', selectedOptions: ['Martes'] }, poll: { id: idEncuesta } } });
  await t.avanzar(46_000);
  assert.match(t.corridas.at(-1).spec.prompt, /\[voto en tu encuesta\] Ana eligió: Martes\. La encuesta: ¿Qué día\? \(Lunes \/ Martes\)/);

  await entra(t, '5491122222222', 'corregí lo que dijiste');
  await t.avanzar(46_000);
  assert.match(txt(0), /Editado/);
  assert.equal(t.waha.enviados.find((e) => e.editar)?.texto, 'texto corregido');
  // Borrar un mensaje que no es del agente no se puede.
  assert.match(txt(1), /Solo podés editar o borrar mensajes que mandaste vos/);
  assert.ok(!t.waha.enviados.some((e) => e.borrar));
  t.limpiar();
});

test('las marcas M-n son de la conversación: con la de otro chat no se puede reaccionar ni citar', async () => {
  let ajena = null;
  const t = armar({
    guion: (spec) => {
      if (spec.prompt.includes('ZXPRIMERO')) { ajena = ultimoM(spec); return []; }
      return [{ herramienta: 'reaccionar', args: { mensaje: ajena, emoji: '❤️' } }, { herramienta: 'responder', args: { texto: 'x', citar: ajena } }];
    },
  });
  persona(t.db, { nombre: 'Ana', telefono: '5491122222222', rol: 'Colaborador' });
  persona(t.db, { nombre: 'Beto', telefono: '5491133333333', rol: 'Colaborador' });
  await entra(t, '5491122222222', 'ZXPRIMERO');
  await t.avanzar(46_000);
  await entra(t, '5491133333333', 'segundo');
  await t.avanzar(46_000);
  const res = t.corridas.at(-1).resultados.map((x) => x.r.content[0].text);
  assert.match(res[0], /no es un mensaje de WhatsApp de esta conversación/);
  assert.match(res[1], /no es un mensaje de WhatsApp de esta conversación/);
  assert.ok(!t.waha.enviados.some((e) => e.reaccion));
  t.limpiar();
});

test('fotos como foto común o como documento; el sticker tiene que ser WebP; un Tercero solo reacciona', async () => {
  const t = armar({
    guion: async (spec, ctx) => {
      if (spec.prompt.includes('mandá la foto')) {
        fs.mkdirSync(ctx.rutas.salida, { recursive: true });
        fs.writeFileSync(path.join(ctx.rutas.salida, 'local.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]));
        return [{ herramienta: 'enviar_archivo', args: { archivo: 'local.jpg', epigrafe: 'Así quedó' } }, { herramienta: 'enviar_archivo', args: { archivo: 'local.jpg', como: 'documento' } }, { herramienta: 'enviar_archivo', args: { archivo: 'local.jpg', como: 'sticker' } }];
      }
      return [];
    },
  });
  persona(t.db, { nombre: 'Ana', telefono: '5491122222222', rol: 'Colaborador' });
  await entra(t, '5491122222222', 'mandá la foto');
  await t.avanzar(46_000);
  const res = t.corridas.at(-1).resultados.map((x) => x.r.content[0].text);
  assert.match(res[0], /enviado como foto/);
  assert.match(res[1], /enviado como documento/);
  assert.match(res[2], /tiene que ser WebP/);
  assert.ok(t.waha.enviados.some((e) => e.imagen === 'local.jpg' && e.epigrafe === 'Así quedó'), 'la foto va como foto de WhatsApp');
  assert.ok(t.waha.enviados.some((e) => e.archivo === 'local.jpg'), 'y como documento si se pide');

  await entra(t, '5491144444444', 'hola, ¿tienen stock?');
  await t.avanzar(46_000);
  const g = t.corridas.at(-1).spec.herramientasGateway;
  assert.ok(g.includes('reaccionar') && !g.includes('enviar_encuesta') && !g.includes('borrar_mensaje'), g.join(','));
  t.limpiar();
});

test('llegan reacciones, ediciones y borrados; la bandeja muestra adjuntos y solo deja ver en la página lo seguro', async () => {
  const t = armar();
  await entrarComoPropietario(t);
  await entra(t, '5491122222222', 'mensaje original');
  await entra(t, '5491122222222', 'esto lo borro');
  const ids = t.db.prepare("SELECT seq, id FROM mensajes WHERE chat_id = '5491122222222@c.us' ORDER BY seq").all();
  await t.nucleo.ingesta({ event: 'message.reaction', session: 'default', payload: { id: 'r1', from: '5491122222222@c.us', fromMe: false, reaction: { text: '🙏', messageId: ids[0].id } } });
  await t.nucleo.ingesta({ event: 'message.edited', session: 'default', payload: { id: 'e1', body: 'mensaje corregido', editedMessageId: ids[0].id } });
  await t.nucleo.ingesta({ event: 'message.revoked', session: 'default', payload: { before: { id: ids[1].id }, after: { id: ids[1].id } } });
  // Adjuntos: una foto, un SVG (podría tener scripts) y un ejecutable.
  const dir = fs.mkdtempSync(path.join(t.config.dataDir, 'adj-'));
  const adj = (seq, mime, nombre) => {
    const ruta = path.join(dir, nombre); fs.writeFileSync(ruta, '<svg onload="alert(1)"/>');
    return Number(t.db.prepare("INSERT INTO adjuntos (mensaje_seq, tipo, mime, nombre, ruta, tamano, estado, creado) VALUES (?, 'document', ?, ?, ?, 10, 'listo', 0)").run(seq, mime, nombre, ruta).lastInsertRowid);
  };
  const foto = adj(ids[0].seq, 'image/jpeg', 'a.jpg');
  const svg = adj(ids[0].seq, 'image/svg+xml', 'b.svg');
  const exe = adj(ids[0].seq, 'application/x-msdownload', 'c.exe');

  const r = await t.pedir('GET', '/api/inbox/mensajes?chat=5491122222222%40c.us');
  const [m1, m2] = r.json.mensajes;
  assert.deepEqual([m1.cuerpo, m1.editado, m1.reacciones], ['mensaje corregido', true, [{ emoji: '🙏', propia: false }]]);
  assert.deepEqual([m2.cuerpo, m2.borrado], [null, true], 'lo borrado no se sigue mostrando');
  assert.equal(m1.adjunto.id, foto);

  const ver = async (id, q = '') => {
    const res = await t.pedirCrudo('GET', `/api/inbox/adjunto/${id}${q}`);
    return { tipo: res.headers.get('content-type'), disp: res.headers.get('content-disposition').split(';')[0], csp: res.headers.get('content-security-policy') };
  };
  assert.deepEqual(await ver(foto), { tipo: 'image/jpeg', disp: 'inline', csp: "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox" });
  assert.deepEqual((await ver(svg)).disp, 'attachment', 'un SVG se descarga, no se muestra');
  assert.deepEqual((await ver(svg)).tipo, 'application/octet-stream');
  assert.deepEqual((await ver(exe)).disp, 'attachment');
  assert.deepEqual((await ver(foto, '?descargar=1')).disp, 'attachment');
  t.olvidarCookie();
  assert.equal((await t.pedir('GET', `/api/inbox/adjunto/${foto}`)).status, 401);
  t.limpiar();
});

test('cliente WAHA: foto, reacción y edición con el formato de GOWS; una sesión vieja recibe los eventos nuevos una vez', async () => {
  const { crearWaha } = await import('../src/wa/waha.mjs');
  const pedidos = [];
  let eventos = ['message.any', 'session.status'];
  const fetch = async (u, o = {}) => {
    const ruta = u.replace('http://waha:3000', '');
    const cuerpo = o.body ? JSON.parse(o.body) : null;
    pedidos.push({ metodo: o.method ?? 'GET', ruta, cuerpo });
    if (ruta === '/api/sessions/default' && (o.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ status: 'WORKING', config: { webhooks: [{ url: 'http://gw/webhook', events: eventos }] } }));
    if (ruta === '/api/sessions/default' && o.method === 'PUT') { eventos = cuerpo.config.webhooks[0].events; return new Response('{}'); }
    return new Response(JSON.stringify({ id: 'true_x@c.us_ABC' }));
  };
  const w = crearWaha({ url: 'http://waha:3000', apiKey: 'k', session: 'default', hookUrl: 'http://gw/webhook', hmacKey: 'h', fetch });
  assert.equal(await w.enviarImagen('1@c.us', { mimetype: 'image/jpeg', filename: 'a.jpg', data: 'QQ==' }, { epigrafe: 'hola' }), 'true_x@c.us_ABC');
  assert.deepEqual(pedidos.at(-1), { metodo: 'POST', ruta: '/api/sendImage', cuerpo: { session: 'default', chatId: '1@c.us', file: { mimetype: 'image/jpeg', filename: 'a.jpg', data: 'QQ==' }, caption: 'hola' } });
  await w.reaccionar('false_1@c.us_A', '👍');
  assert.deepEqual(pedidos.at(-1), { metodo: 'PUT', ruta: '/api/reaction', cuerpo: { session: 'default', messageId: 'false_1@c.us_A', reaction: '👍' } });
  await w.editarMensaje('1@c.us', 'true_1@c.us_B', 'nuevo');
  assert.deepEqual(pedidos.at(-1), { metodo: 'PUT', ruta: '/api/default/chats/1%40c.us/messages/true_1%40c.us_B', cuerpo: { text: 'nuevo' } });
  await w.asegurar();
  await w.asegurar();
  assert.equal(pedidos.filter((p) => p.metodo === 'PUT' && p.ruta === '/api/sessions/default').length, 1, 'se actualiza una sola vez');
  assert.ok(['message.reaction', 'message.edited', 'message.revoked', 'poll.vote'].every((e) => eventos.includes(e)));
});
