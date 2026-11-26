// Varios números de WhatsApp: la política de cada uno se aplica antes del agente y la hace cumplir el gateway
// (un número que solo lee nunca envía), las respuestas salen por el número de llegada, un grupo visto desde dos
// números se guarda una vez y, si los dos pueden responder sin que el Propietario eligiera, no responde ninguno.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona } from './ayuda.mjs';

let n = 0;
/** Mensaje que entra por un número (sesión) dado. */
function entra(t, { sesion = 'default', me = '5491100000001', de, chat = null, texto, fromMe = false, id = null }) {
  n++;
  const c = chat ?? `${de}@c.us`;
  return t.nucleo.ingesta({
    event: 'message.any', session: sesion, me: { id: `${me}@c.us` },
    payload: {
      id: id ?? `false_${c}_MSG${n}`, timestamp: 1_800_000_000, from: c, fromMe,
      participant: c.endsWith('@g.us') ? `${de}@c.us` : null, body: texto, hasMedia: false, _data: { Info: { PushName: 'Alguien' } },
    },
  });
}

async function conDuena() {
  const t = armar({ guion: () => [{ herramienta: 'responder', args: { texto: 'hola!' } }] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  return t;
}

test('un número nuevo arranca mudo: no guarda, no despierta al agente', async () => {
  const t = await conDuena();
  await t.nucleo.numeros.crear({ nombre: 'personal', etiqueta: 'personal' });
  assert.equal(await entra(t, { sesion: 'personal', de: '5491122222222', texto: 'hola' }), 'fuera_de_alcance');
  await t.avanzar(46_000);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM mensajes WHERE session = 'personal'").get().n, 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM personas WHERE telefono = '5491122222222'").get().n, 0, 'ni siquiera crea la persona');
  assert.equal(t.corridas.length, 0);
  assert.equal(t.nucleo.numeros.obtener('personal').fuera_de_alcance, 1);
  t.limpiar();
});

test('solo leer los chats de clientes: entra como contexto y el gateway bloquea cualquier envío', async () => {
  const t = await conDuena();
  const N = t.nucleo.numeros;
  await N.crear({ nombre: 'personal' });
  N.configurar('personal', { modo: 'leer', chats: 'clientes', guardar: true, dias: 30 });
  assert.equal(await entra(t, { sesion: 'personal', de: '5491133333333', texto: 'charla privada' }), 'fuera_de_alcance');
  const cli = Number(t.db.prepare("INSERT INTO clientes (nombre, tipo) VALUES ('Cliente Uno', 'cliente')").run().lastInsertRowid);
  t.db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, creado) VALUES ('5491144444444@c.us', 'directo', ?, 1, 0)").run(cli);
  assert.equal(await entra(t, { sesion: 'personal', de: '5491144444444', texto: 'mandame el presupuesto' }), 'guardado');
  await t.avanzar(46_000);
  assert.equal(t.corridas.length, 0, 'no despierta al agente');
  assert.equal(t.db.prepare("SELECT procesado FROM mensajes WHERE session = 'personal'").get().procesado, 1);

  // Aunque algo intente mandar por ese número, no sale.
  t.nucleo.salida.encolar({ chatId: '5491144444444@c.us', texto: 'esto no tiene que salir', sesion: 'personal' });
  await t.nucleo.salida.procesar();
  assert.equal(t.otrosWa.get('personal').enviados.length, 0);
  assert.equal(t.waha.enviados.length, 0);
  assert.match(t.db.prepare("SELECT error FROM salida WHERE sesion = 'personal'").get().error, /Bloqueado por la política: .*solo lectura/);

  // Lo que escribe el dueño de ese teléfono es suyo, no del agente.
  N.anotarNumero('personal', { id: '5491155555555@c.us' });
  await entra(t, { sesion: 'personal', me: '5491155555555', chat: '5491144444444@c.us', texto: 'ya te lo mando', fromMe: true });
  const m = t.db.prepare("SELECT from_me, persona_id, procesado FROM mensajes WHERE cuerpo = 'ya te lo mando'").get();
  assert.equal(m.from_me, 0);
  assert.equal(m.procesado, 1);
  assert.equal(t.db.prepare('SELECT telefono FROM personas WHERE id = ?').get(m.persona_id).telefono, '5491155555555');
  t.limpiar();
});

test('la respuesta sale por el número por el que entró', async () => {
  const t = await conDuena();
  await t.nucleo.numeros.crear({ nombre: 'ventas' });
  t.nucleo.numeros.configurar('ventas', { modo: 'responder', chats: 'todos' });
  await entra(t, { sesion: 'ventas', me: '5491166666666', de: '5491177777777', texto: 'hola, precios?' });
  await t.avanzar(46_000);
  assert.equal(t.corridas.length, 1);
  assert.match(t.corridas[0].spec.prompt, /Entró por el número "ventas"/);
  assert.deepEqual(t.otrosWa.get('ventas').enviados.map((e) => e.texto), ['hola!']);
  assert.equal(t.waha.enviados.length, 0, 'no sale por el principal');
  t.limpiar();
});

test('grupo visto desde dos números: se guarda una vez; el agente recibe quién lo ve; elegido uno, responde ese', async () => {
  const t = await conDuena();
  const N = t.nucleo.numeros;
  await N.crear({ nombre: 'ventas' });
  N.configurar('ventas', { modo: 'responder', chats: 'todos' });
  N.anotarNumero('ventas', { id: '5491166666666@c.us' });
  const G = '120363000000000009@g.us';
  t.db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, nombre, creado) VALUES (?, 'grupo', 1, 1, 'Grupo compartido', 0)").run(G);

  // El principal lo ve primero (todavía solo él: responde).
  assert.equal(await entra(t, { chat: G, de: '5491188888888', texto: '@5491100000001 hola', id: `false_${G}_AAA111_5491188888888@c.us` }), 'guardado');
  // El mismo mensaje desde ventas: duplicado.
  assert.equal(await entra(t, { sesion: 'ventas', me: '5491166666666', chat: G, de: '5491188888888', texto: '@5491100000001 hola', id: `false_${G}_AAA111_5491188888888@c.us` }), 'duplicado');
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM mensajes WHERE chat_id = ?').get(G).n, 1);
  await t.avanzar(46_000);
  const antes = t.corridas.length;

  // Ahora los dos lo ven y los dos pueden responder: el código no decide; el agente recibe los datos y razona.
  await entra(t, { chat: G, de: '5491188888888', texto: '@5491100000001 ¿alguien?' });
  await t.avanzar(46_000);
  const c = t.corridas.slice(antes).find((x) => x.ctx.chatId === G);
  assert.match(c.spec.prompt, /Este chat lo ven: principal \(responder\), ventas \(responder\); el Propietario no definió cuál responde acá/);
  assert.deepEqual(N.compartidos().map((x) => [x.chat, x.pueden_responder.length, x.elegido]), [[G, 2, null]]);
  // Al Propietario le llegan los datos (sin veredicto) y la herramienta de consulta.
  await entra(t, { de: '5491111111111', texto: 'hola' });
  await t.avanzar(46_000);
  const dueno = t.corridas.at(-1);
  assert.match(dueno.spec.prompt, /Chats que ven varios números que pueden responder, sin número elegido: "Grupo compartido"/);
  assert.ok(dueno.spec.herramientasGateway.includes('numeros'));

  // Lo que escribe el otro número propio no despierta a nadie.
  assert.equal(await entra(t, { chat: G, de: '5491166666666', texto: 'soy ventas' }), 'propio');

  // El Propietario elige ventas: el principal deja de responder ahí y ventas responde.
  N.elegirEnChat(G, 'ventas');
  const principalAntes = t.waha.enviados.filter((e) => e.chatId === G).length;
  await entra(t, { chat: G, de: '5491188888888', texto: '@5491100000001 por el principal' });
  await entra(t, { sesion: 'ventas', me: '5491166666666', chat: G, de: '5491188888888', texto: '@5491166666666 por ventas' });
  await t.avanzar(46_000);
  const enGrupo = t.corridas.filter((c) => c.ctx.chatId === G).slice(-1)[0];
  assert.ok(enGrupo?.spec.prompt.includes('por ventas'));
  assert.ok(t.otrosWa.get('ventas').enviados.some((e) => e.chatId === G), JSON.stringify(t.db.prepare('SELECT chat_id, estado, error, sesion FROM salida').all()) + JSON.stringify(enGrupo.resultados));
  assert.equal(t.waha.enviados.filter((e) => e.chatId === G).length, principalAntes, 'el principal ya no responde ahí');
  t.limpiar();
});

test('configurar_sesion: ficha primero, aplica con confirmación en otro mensaje y queda en la bitácora', async () => {
  const pol = { modo: 'leer', chats: 'clientes', guardar: true, dias: 30, notas: 'no comentar con terceros lo que leo' };
  const t = armar({
    guion: (spec) => {
      if (spec.prompt.includes('es mi personal')) return [
        { herramienta: 'configurar_sesion', args: { numero: 'personal', politica: pol } },
        { herramienta: 'configurar_sesion', args: { numero: 'personal', politica: pol, confirmado: true } },
      ];
      if (spec.prompt.includes('sí, dale')) return [{ herramienta: 'configurar_sesion', args: { numero: 'personal', politica: pol, confirmado: true } }];
      return [];
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await t.nucleo.numeros.crear({ nombre: 'personal' });
  await entra(t, { de: '5491111111111', texto: 'es mi personal, solo leé clientes' });
  await t.avanzar(46_000);
  const c = t.corridas.at(-1);
  assert.match(c.spec.prompt, /Números de WhatsApp[\s\S]*personal/);
  assert.match(c.resultados[0].r.content[0].text, /Todavía no se aplicó[\s\S]*solo lee: el gateway bloquea cualquier envío[\s\S]*30 días[\s\S]*Instrucción \(la cumplo yo, no es un bloqueo\)/);
  assert.match(c.resultados[1].r.content[0].text, /todavía no vio la ficha/);
  assert.equal(t.nucleo.numeros.politicaDe('personal').modo, 'nada');
  await entra(t, { de: '5491111111111', texto: 'sí, dale' });
  await t.avanzar(46_000);
  assert.equal(t.nucleo.numeros.politicaDe('personal').modo, 'leer');
  assert.ok(t.db.prepare("SELECT 1 FROM bitacora WHERE que LIKE 'Política del número%'").get());
  t.limpiar();
});

test('vincular un número nuevo: el agente le pregunta al Propietario qué hacer con él', async () => {
  const t = await conDuena();
  await t.nucleo.numeros.crear({ nombre: 'empresa', etiqueta: 'empresa' });
  t.otrosWa.get('empresa').estado = async () => ({ status: 'WORKING', me: { id: '5491199999999@c.us' } });
  await t.nucleo.alVincularNumero('empresa');
  const ev = t.db.prepare("SELECT cuerpo FROM mensajes WHERE chat_id = '5491111111111@c.us' AND tipo = 'evento'").all().map((x) => x.cuerpo);
  assert.ok(ev.some((e) => /^\[número nuevo vinculado\] "empresa" \(\+5491199999999\)/.test(e)));
  await t.nucleo.alVincularNumero('empresa');
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM mensajes WHERE tipo = 'evento' AND cuerpo LIKE '[número nuevo%'").get().n, 1, 'una sola vez');
  t.limpiar();
});
