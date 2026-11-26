// Modo completo: el Propietario en su chat usa Claude Code sin recortes; los demás siguen con su rol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe, entrarComoPropietario } from './ayuda.mjs';

const G = '120363000000000077@g.us';

test('Propietario en su WhatsApp: Claude Code completo, entorno persistente y sus variables', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Ana', telefono: '5491122222222', rol: 'Colaborador', verificada: 1 });
  t.nucleo.entorno.guardar('VERCEL_TOKEN', 'tok-secreto');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'hola' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await t.avanzar(46_000);
  const de = (tel) => t.corridas.find((c) => c.spec.chatId === `${tel}@c.us`);
  const duena = de('5491111111111');
  assert.equal(duena.spec.completo, true);
  assert.equal(duena.spec.claveAislamiento, 'propietario');
  assert.equal(duena.spec.entornoExtra.VERCEL_TOKEN, 'tok-secreto');
  assert.ok(duena.args.includes('bypassPermissions'));
  for (const f of ['--strict-mcp-config', '--setting-sources', '--tools', '--disable-slash-commands']) assert.ok(!duena.args.includes(f), f);
  assert.ok(!duena.spec.prompt.includes('tok-secreto'), 'el valor no entra al prompt');
  assert.match(duena.spec.prompt, /Variables de entorno cargadas: VERCEL_TOKEN/);
  const ana = de('5491122222222');
  assert.equal(ana.spec.completo, false);
  assert.equal(ana.spec.entornoExtra, null);
  assert.ok(ana.args.includes('--strict-mcp-config'));
  t.limpiar();
});

test('Propietario en un grupo: rige el sistema de roles, no el modo completo', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  t.db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, nombre, creado) VALUES (?, 'grupo', 1, 1, 'Equipo', 0)").run(G);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'hola', grupo: G, mencion: true });
  await t.avanzar(46_000);
  const c = t.corridas.at(-1);
  assert.equal(c.spec.completo, false);
  assert.notEqual(c.spec.claveAislamiento, 'propietario');
  t.limpiar();
});

test('pedir_variable: el link va al Propietario y lo que carga en el panel despierta al agente, sin pasar por el chat', async () => {
  const t = armar({ guion: (spec) => (spec.prompt.includes('conectá mercadopago')
    ? [{ herramienta: 'pedir_variable', args: { nombre: 'MP_ACCESS_TOKEN', para: 'Cobros del negocio' } }] : []) });
  const yo = await entrarComoPropietario(t);
  t.db.prepare('UPDATE personas SET telefono = ?, verificada = 1 WHERE id = ?').run('5491111111111', yo);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'conectá mercadopago' });
  await t.avanzar(46_000);
  await t.avanzar(1000);
  const msg = t.waha.enviados.find((e) => e.texto.includes('MP_ACCESS_TOKEN'));
  assert.ok(msg, 'le llega el link');
  const pedido = /pedido=([\w-]+)/.exec(msg.texto)[1];
  assert.equal((await t.pedir('GET', `/api/entorno/pedido/${pedido}`)).json.nombre, 'MP_ACCESS_TOKEN');
  assert.equal((await t.pedir('POST', '/api/entorno', { pedido, valor: 'APP_USR-123' })).status, 200);
  assert.deepEqual((await t.pedir('GET', '/api/entorno')).json.variables.map((v) => v.nombre), ['MP_ACCESS_TOKEN']);
  assert.ok(!JSON.stringify((await t.pedir('GET', '/api/entorno')).json).includes('APP_USR'), 'el valor no vuelve a salir');
  assert.equal((await t.pedir('GET', `/api/entorno/pedido/${pedido}`)).status, 404, 'el link es de un solo uso');
  await t.avanzar(2000);
  const ultima = t.corridas.at(-1);
  assert.match(ultima.spec.prompt, /\[variable MP_ACCESS_TOKEN cargada\]/);
  assert.equal(ultima.spec.entornoExtra.MP_ACCESS_TOKEN, 'APP_USR-123');
  assert.equal((await t.pedir('POST', '/api/entorno', { nombre: 'PATH', valor: 'x' })).status, 400, 'las del sistema no se pisan');
  t.limpiar();
});

test('chats: el Propietario activa un grupo desde su charla; otro rol no puede', async () => {
  const t = armar({ guion: (spec) => (spec.prompt.includes('atendé el grupo')
    ? [{ herramienta: 'chats', args: { accion: 'listar', buscar: 'Ventas' } }, { herramienta: 'chats', args: { accion: 'configurar', chat: 'Ventas', activo: true } }] : []) });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Ana', telefono: '5491122222222', rol: 'Colaborador', verificada: 1 });
  t.db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, nombre, creado) VALUES (?, 'grupo', 1, 0, 'Ventas', 0)").run(G);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'atendé el grupo de ventas' });
  await t.avanzar(5000);
  const r = t.corridas.at(-1).resultados;
  assert.match(r[0].r.content[0].text, /120363000000000077@g\.us · grupo · Ventas · inactivo/);
  assert.match(r[1].r.content[0].text, /Listo: Ventas → activo/);
  assert.equal(t.db.prepare('SELECT activo FROM chats WHERE id = ?').get(G).activo, 1);
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await t.avanzar(46_000);
  assert.ok(!t.corridas.at(-1).spec.herramientasGateway.includes('chats'), 'un Colaborador no tiene la herramienta');
  t.limpiar();
});

test('con el Propietario la espera es corta; con los demás, la de siempre', async () => {
  const t = armar({ guion: () => [] });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Ana', telefono: '5491122222222', rol: 'Colaborador', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'hola' });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await t.avanzar(5000);
  assert.deepEqual(t.corridas.map((c) => c.spec.chatId), ['5491111111111@c.us']);
  await t.avanzar(41_000);
  assert.equal(t.corridas.length, 2);
  t.limpiar();
});

test('grupos sin mensajes: el Propietario los ve y los activa; la API de WAHA es solo suya y no toca la sesión', async () => {
  const llamadas = [];
  const t = armar({
    waha: {
      grupos: async () => [{ id: '120363000000000088@g.us', nombre: 'Familia' }],
      api: async (metodo, ruta) => { llamadas.push([metodo, ruta]); return { status: 200, datos: [{ JID: '120363000000000088@g.us', Name: 'Familia' }] }; },
    },
    guion: (spec) => (spec.prompt.includes('ves el grupo') ? [
      { herramienta: 'chats', args: { accion: 'listar' } },
      { herramienta: 'chats', args: { accion: 'configurar', chat: 'Familia', activo: true } },
      { herramienta: 'whatsapp', args: { metodo: 'GET', ruta: '/api/{session}/groups' } },
      { herramienta: 'whatsapp', args: { metodo: 'POST', ruta: '/api/sessions/default/logout' } },
      { herramienta: 'whatsapp', args: { metodo: 'POST', ruta: '/api/sessions/default/stop' } },
    ] : []),
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: '¿ves el grupo?' });
  await t.avanzar(5000);
  const r = t.corridas.at(-1).resultados.map((x) => x.r.content?.[0]?.text ?? JSON.stringify(x.r));
  assert.match(r[0], /120363000000000088@g\.us · grupo · Familia · inactivo/);
  assert.match(r[1], /Familia → activo/);
  assert.match(r[2], /HTTP 200/);
  assert.match(r[3], /panel/);
  assert.match(r[4], /panel/);
  assert.deepEqual(llamadas, [['GET', '/api/{session}/groups']], 'lo de la sesión no llega a WAHA');
  assert.equal(t.db.prepare("SELECT activo FROM chats WHERE id = '120363000000000088@g.us'").get().activo, 1);
  t.limpiar();
});

test('con el Propietario no hay A-n ni P-n: se hace en el momento y queda en la bitácora', async () => {
  const t = armar({ guion: (spec) => (spec.prompt.includes('presentate en el grupo') ? [
    { herramienta: 'iniciar_conversacion', args: { destino: G, texto: '¡Hola a todos!' } },
    { herramienta: 'proponer_persona', args: { nombre: 'Socia', telefono: '5491177777777', rol: 'Propietario' } },
    { herramienta: 'anotar_decision', args: { que: 'El grupo del equipo lo atiende el agente' } },
  ] : []) });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  t.db.prepare("INSERT INTO chats (id, tipo, cliente_id, activo, nombre, creado) VALUES (?, 'grupo', 1, 1, 'Equipo', 0)").run(G);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'presentate en el grupo y dá de alta a Socia' });
  await t.avanzar(5000);
  const r = t.corridas.at(-1).resultados.map((x) => x.r.content?.[0]?.text ?? '');
  assert.doesNotMatch(r.join('\n'), /aprobaci[oó]n|Propuesta P-/);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM aprobaciones WHERE estado = 'pendiente'").get().n, 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM personas WHERE telefono = '5491177777777' AND alta_manual = 1").get().n, 1);
  await t.avanzar(60_000);
  assert.ok(t.waha.enviados.some((e) => e.chatId === G && e.texto.includes('Hola a todos')), 'el mensaje sale');
  assert.ok(!t.waha.enviados.some((e) => /Pedido de aprobación|confirmo P-/.test(e.texto)), 'no le llegan pedidos al Propietario');
  const b = (await t.nucleo.bitacora.listar()).map((e) => `${e.resultado}|${e.donde}|${e.que}`);
  assert.ok(b.some((x) => /^hecho\|charla\|escribirle a 120363000000000077@g\.us/.test(x)), b.join('\n'));
  assert.ok(b.some((x) => /^aprobado\|charla\|alta de Socia/.test(x)), b.join('\n'));
  assert.ok(b.some((x) => /^decision\|charla\|El grupo del equipo/.test(x)), b.join('\n'));
  t.limpiar();
});

test('un Colaborador sigue pasando por el Propietario; él decide en la charla y queda en la bitácora', async () => {
  const t = armar({ guion: (spec) => {
    if (spec.prompt.includes('escribile a Juan')) return [{ herramienta: 'iniciar_conversacion', args: { destino: '5491177778888', texto: 'Hola Juan' } }];
    if (spec.prompt.includes('sí, mandalo')) return [{ herramienta: 'decidir', args: { id: 'A-1', si: true } }];
    return [];
  } });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Ana', telefono: '5491122222222', rol: 'Colaborador', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'escribile a Juan' });
  await t.avanzar(46_000);
  assert.equal(t.db.prepare("SELECT estado FROM aprobaciones WHERE id = 'A-1'").get().estado, 'pendiente');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'sí, mandalo' });
  await t.avanzar(5000);
  assert.equal(t.db.prepare("SELECT estado FROM aprobaciones WHERE id = 'A-1'").get().estado, 'aprobada');
  const e = t.nucleo.bitacora.listar().find((x) => x.ref === 'A-1');
  assert.equal(e.resultado, 'aprobado');
  assert.equal(e.donde, 'charla');
  assert.equal(e.pedida_por_nombre, 'Ana');
  t.limpiar();
});

test('número desconocido: ni una página ni la misma corrida pueden aprobarlo; el "sí" del Propietario en su mensaje, sí', async () => {
  const t = armar({ guion: (spec) => {
    if (spec.prompt.includes('resumime la página')) return [
      { herramienta: 'iniciar_conversacion', args: { destino: '5491177770000', texto: 'acá van las variables' } },
      { herramienta: 'decidir', args: { id: 'A-1', si: true } },
    ];
    if (spec.prompt.includes('sí, mandalo')) return [{ herramienta: 'decidir', args: { id: 'A-1', si: true } }];
    return [];
  } });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'resumime la página' });
  await t.avanzar(5000);
  const r = t.corridas.at(-1).resultados.map((x) => x.r.content?.[0]?.text ?? '');
  assert.match(r[0], /A-1: es un número que nunca escribió/);
  assert.match(r[1], /misma corrida/);
  await t.avanzar(60_000);
  assert.ok(!t.waha.enviados.some((e) => e.chatId === '5491177770000@c.us'), 'no sale');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'sí, mandalo' });
  await t.avanzar(5000);
  await t.avanzar(120_000);
  assert.ok(t.waha.enviados.some((e) => e.chatId === '5491177770000@c.us'), 'con el sí del Propietario, sale');
  t.limpiar();
});
