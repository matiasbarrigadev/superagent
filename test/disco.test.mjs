// Disco: la limpieza borra solo lo que ya cumplió su función (trabajos terminados, adjuntos y archivos viejos,
// temporales), avisa una vez al pasar el umbral, y el agente lo ve y lo configura con confirmación.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { armar, persona, entrarComoPropietario } from './ayuda.mjs';
import { crearDisco } from '../src/servicios/disco.mjs';

const DIA = 86_400_000;
const escribir = (ruta, kb = 10) => { fs.mkdirSync(path.dirname(ruta), { recursive: true }); fs.writeFileSync(ruta, Buffer.alloc(kb * 1024)); return ruta; };

test('limpieza: trabajos terminados de ayer, adjuntos y enviados viejos (queda el texto) y temporales; lo demás no se toca', async () => {
  const t = armar();
  const ahora = t.tiempo.t;
  const ais = t.nucleo.aislamiento;
  const disco = t.nucleo.disco;
  // Trabajos: uno terminado hace dos días, uno terminado hace una hora, uno corriendo.
  t.db.prepare("INSERT INTO trabajos (id, descripcion, estado, fin) VALUES ('T-1', 'viejo', 'terminado', ?), ('T-2', 'reciente', 'terminado', ?), ('T-3', 'en curso', 'corriendo', NULL)").run(ahora - 2 * DIA, ahora - 3_600_000);
  for (const id of ['T-1', 'T-2', 'T-3']) { const l = ais.preparar(`trabajo:${id}`); escribir(path.join(l.trabajo, 'repo', 'node_modules', 'pesado.bin'), 200); ais.terminar(l); }
  // El entorno del Propietario y una charla, con un temporal viejo y uno nuevo.
  const p = ais.preparar('propietario'); escribir(path.join(p.trabajo, 'mi-app', 'datos.db'), 50);
  const ch = ais.preparar('chat:5491122222222@c.us');
  const tmpViejo = escribir(path.join(ch.tmp, 'viejo.tmp'));
  fs.utimesSync(tmpViejo, new Date(Date.now() - 3 * DIA), new Date(Date.now() - 3 * DIA));
  const tmpNuevo = escribir(path.join(ch.tmp, 'nuevo.tmp'));
  // Adjuntos: uno de hace 100 días (con texto) y uno de ayer.
  t.db.prepare("INSERT INTO mensajes (session, id, chat_id, from_me, tipo, cuerpo, ts, procesado, recibido) VALUES ('default', 'm1', '5491122222222@c.us', 0, 'ptt', '', 1, 1, 1)").run();
  const seq = t.db.prepare("SELECT seq FROM mensajes WHERE id = 'm1'").get().seq;
  const adjViejo = escribir(path.join(t.config.dataDir, 'adjuntos', 'viejo.ogg'));
  const adjNuevo = escribir(path.join(t.config.dataDir, 'adjuntos', 'nuevo.ogg'));
  t.db.prepare("INSERT INTO adjuntos (mensaje_seq, tipo, ruta, estado, creado, texto) VALUES (?, 'ptt', ?, 'listo', ?, 'hola, te dejo el audio'), (?, 'ptt', ?, 'listo', ?, null)").run(seq, adjViejo, ahora - 100 * DIA, seq, adjNuevo, ahora - DIA);
  // Un archivo enviado viejo.
  const fid = t.nucleo.archivos.guardar({ chatId: '5491122222222@c.us', nombre: 'informe.pdf', datos: Buffer.alloc(20 * 1024) });
  t.db.prepare('UPDATE archivos SET creado = ? WHERE id = ?').run(ahora - 100 * DIA, fid);

  const sim = disco.limpiar({ simular: true });
  assert.equal(sim.acciones.length, 4, sim.acciones.join(' | '));
  assert.ok(fs.existsSync(ais.rutas('trabajo:T-1').base), 'simular no borra');

  const r = disco.limpiar();
  assert.ok(r.liberado >= 200 * 1024, String(r.liberado));
  assert.ok(!fs.existsSync(ais.rutas('trabajo:T-1').base), 'trabajo terminado hace dos días: borrado');
  assert.ok(fs.existsSync(ais.rutas('trabajo:T-2').base), 'terminado hace una hora: queda');
  assert.ok(fs.existsSync(ais.rutas('trabajo:T-3').base), 'corriendo: queda');
  assert.ok(fs.existsSync(path.join(p.trabajo, 'mi-app', 'datos.db')), 'el entorno del Propietario no se toca');
  assert.ok(!fs.existsSync(tmpViejo) && fs.existsSync(tmpNuevo));
  assert.ok(!fs.existsSync(adjViejo) && fs.existsSync(adjNuevo));
  assert.deepEqual(t.db.prepare('SELECT estado, ruta, texto FROM adjuntos ORDER BY id').all().map((a) => ({ ...a })), [
    { estado: 'vencido', ruta: null, texto: 'hola, te dejo el audio' },
    { estado: 'listo', ruta: adjNuevo, texto: null },
  ]);
  assert.ok(!fs.existsSync(t.nucleo.archivos.obtener(fid).ruta));
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM trabajos').get().n, 3, 'la base no se toca');
  // El desglose nombra cada carpeta.
  const nombres = disco.desglose({ fresco: true }).map((x) => x.nombre);
  assert.ok(nombres.includes('Tu entorno (Propietario)') && nombres.includes('Trabajo T-2 (terminado)') && nombres.some((n) => n.startsWith('Charla:')), nombres.join(', '));
  t.limpiar();
});

test('aviso al pasar el umbral: una vez por día, al Propietario y al agente para que proponga qué liberar', () => {
  const t = armar();
  const avisos = [], despertares = [];
  let usado = 85;
  const d = crearDisco({
    db: t.db, config: t.config, ajustes: t.nucleo.ajustes, aislamiento: t.nucleo.aislamiento, reloj: () => t.tiempo.t,
    avisos: { alPropietario: (x) => avisos.push(x) }, despertarPropietarios: (x) => despertares.push(x),
    volumen: () => ({ total: 100 * 1024 ** 3, usado: usado * 1024 ** 3, libre: (100 - usado) * 1024 ** 3 }),
  });
  assert.equal(d.revisar().aviso, true);
  assert.equal(d.revisar().aviso, false, 'el mismo día no se repite');
  assert.match(avisos[0], /el disco va por el 85%/);
  assert.match(despertares[0].texto, /\[disco al 85%\][\s\S]*proponele al Propietario qué liberar/);
  assert.match(d.linea(), /\(85%\) — pasó el umbral de aviso/);
  usado = 40;
  t.tiempo.t += 2 * 86_400_000;
  assert.equal(d.revisar().aviso, false, 'debajo del umbral no avisa');
  assert.throws(() => d.configurar({ umbral: 30 }), /entre 50 y 99/);
  t.limpiar();
});

test('el agente ve el disco en su contexto y configura la limpieza solo con confirmación en otro mensaje', async () => {
  const t = armar({
    guion: (spec) => {
      if (spec.prompt.includes('ZXDISCO')) return [{ herramienta: 'disco', args: { accion: 'ver' } }];
      if (spec.prompt.includes('ZXCONFIRMO')) return [{ herramienta: 'disco', args: { accion: 'configurar', dias_adjuntos: 30, confirmado: true } }];
      if (spec.prompt.includes('ZXGUARDAR')) return [{ herramienta: 'disco', args: { accion: 'configurar', dias_adjuntos: 30 } }];
      return [];
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Ana', telefono: '5491122222222', rol: 'Colaborador' });
  let n = 0;
  const entra = (de, texto) => { n++; return t.nucleo.ingesta({ event: 'message.any', session: 'default', me: { id: '5491100000001@c.us' }, payload: { id: `false_${de}@c.us_D${n}`, timestamp: 1_800_000_000 + n, from: `${de}@c.us`, fromMe: false, body: texto, hasMedia: false, _data: { Info: { PushName: 'X' } } } }); };
  const txt = () => t.corridas.at(-1).resultados[0].r.content[0].text;

  await entra('5491111111111', 'ZXDISCO');
  await t.avanzar(46_000);
  assert.match(t.corridas.at(-1).spec.prompt, /Disco: [\d.]+ \w+ de [\d.]+ \w+ \([\d.]+%\)/);
  assert.match(txt(), /Lo que ocupa:[\s\S]*Base de datos[\s\S]*Limpieza automática: prendida, cada hora; adjuntos y archivos enviados: 90 días; aviso al 80%/);

  await entra('5491111111111', 'ZXGUARDAR 30 días');
  await t.avanzar(46_000);
  assert.match(txt(), /Todavía no se cambió nada[\s\S]*a los 30 días/);
  assert.equal(t.nucleo.disco.conf().diasAdjuntos, 90);
  await entra('5491111111111', 'ZXCONFIRMO');
  await t.avanzar(46_000);
  assert.match(txt(), /Listo: adjuntos 30 días/);
  assert.equal(t.nucleo.disco.conf().diasAdjuntos, 30);

  await entra('5491122222222', 'hola');
  await t.avanzar(46_000);
  assert.ok(!t.corridas.at(-1).spec.herramientasGateway.includes('disco'), 'un Colaborador no la tiene');
  assert.ok(!/Disco: /.test(t.corridas.at(-1).spec.prompt), 'ni lo ve en su contexto');
  t.limpiar();
});

test('panel: el disco se ve y se limpia con sesión; sin sesión, 401', async () => {
  const t = armar();
  await entrarComoPropietario(t);
  const r = await t.pedir('GET', '/api/disco');
  assert.equal(r.status, 200);
  assert.ok(r.json.volumen.total > 0 && Array.isArray(r.json.desglose));
  const l = await t.pedir('POST', '/api/disco/limpiar', { simular: true });
  assert.equal(l.status, 200);
  assert.equal((await t.pedir('PATCH', '/api/disco', { umbral: 10 })).status, 400);
  t.olvidarCookie();
  assert.equal((await t.pedir('GET', '/api/disco')).status, 401);
  t.limpiar();
});
