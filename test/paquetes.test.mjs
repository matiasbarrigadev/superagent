// Paquetes: traer el trabajo previo (o mudar una instalación) con ensayo, confirmación, idempotencia y sin secretos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe, entrarComoPropietario } from './ayuda.mjs';
import { validarPaquete, partirMemoria } from '../src/servicios/paquetes.mjs';

const PAQUETE = {
  superagent: 1,
  roles: [{ nombre: 'Ventas', descripcion: 'solo cantidades', permisos: { conversar: true, herramientas_negocio: 'lectura' } }],
  clientes: [{ nombre: 'Estudio Ejemplo', autonomia: 'consultar_todo' }],
  personas: [{ nombre: 'Ana', telefono: '5491100000001', rol: 'Colaborador', clientes: [{ cliente: 'Estudio Ejemplo', rol: 'Ventas' }] }],
  proyectos: [{ nombre: 'sitio', cliente: 'Estudio Ejemplo', repo: 'miorg/sitio', dominios: ['ejemplo.com'] }],
  chats: [{ id: '120363000000000001@g.us', nombre: 'Equipo sitio', cliente: 'Estudio Ejemplo', proyecto: 'sitio', solo_si_mencionan: true }],
  memoria: [
    { alcance: 'cuenta', seccion: 'Contexto', contenido: 'Somos un estudio de diseño.' },
    { alcance: 'cliente', de: 'Estudio Ejemplo', seccion: 'Comportamiento', contenido: 'Prefieren audios.' },
    { alcance: 'contacto', de: '5491100000001', seccion: 'Contexto', contenido: 'Ana coordina entregas.' },
  ],
  lecciones: [{ regla: 'No publicar los viernes a la tarde.' }],
  rutinas: [{ cuando: '0 9 * * 1-5', zona_horaria: 'UTC', instruccion: 'Mandale a Ana el resumen de ayer.', destino: '5491100000001', pedida_por: '5491100000001' }],
  secretos: [{ nombre: 'VERCEL_TOKEN', para: 'publicar' }],
  conectores: [{ nombre: 'Supabase', url: 'https://mcp.supabase.com/mcp' }],
};

function conDuena() {
  const t = armar();
  const duena = persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  return { t, actor: { personaId: duena, permisos: t.nucleo.politica.rolDe(duena, 1).permisos } };
}

test('validación: versión, cron, referencias y secretos (que rechazan el paquete entero)', () => {
  assert.match(validarPaquete({}).join(' '), /superagent/);
  assert.match(validarPaquete({ superagent: 1, rutinas: [{ cuando: 'cada tanto', instruccion: 'x' }] }).join(' '), /rutinas\[0\]/);
  assert.match(validarPaquete({ superagent: 1, memoria: [{ alcance: 'cliente', seccion: 'Contexto', contenido: 'x' }] }).join(' '), /falta "de"/);
  assert.match(validarPaquete({ superagent: 1, memoria: [{ alcance: 'cuenta', seccion: 'Contexto', contenido: 'el token es ghp_abcdefghijklmnopqrstuvwxyz0123' }] }).join(' '), /parece un secreto/);
  assert.match(validarPaquete({ superagent: 1, secretos: [{ nombre: 'VERCEL_TOKEN', valor: 'algo' }] }).join(' '), /parece un secreto/);
  assert.match(validarPaquete({ superagent: 1, conectores: [{ nombre: 'X', api_key: 'abc' }] }).join(' '), /parece un secreto/);
  assert.deepEqual(validarPaquete(PAQUETE), []);
  const { t, actor } = conDuena();
  assert.throws(() => t.nucleo.paquetes.importar({ ...PAQUETE, memoria: [{ alcance: 'cuenta', seccion: 'Contexto', contenido: 'sk-ant-api03-abcdefghijklmnopqrstuvwx' }] }, actor), /parece un secreto/);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM clientes WHERE nombre = 'Estudio Ejemplo'").get().n, 0, 'no quedó nada a medias');
  t.limpiar();
});

test('ensayo no escribe; importar crea todo; reimportar no duplica; lo cambiado se actualiza', () => {
  const { t, actor } = conDuena();
  const ensayo = t.nucleo.paquetes.ensayar(PAQUETE, actor);
  assert.ok(ensayo.crear.some((x) => /cliente "Estudio Ejemplo"/.test(x)));
  assert.ok(ensayo.crear.some((x) => /memoria contacto de \+5491100000001/.test(x)), 'resuelve la persona nueva del mismo paquete');
  assert.deepEqual(ensayo.faltan.secretos.map((s) => s.nombre), ['VERCEL_TOKEN']);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM clientes WHERE nombre = 'Estudio Ejemplo'").get().n, 0);

  const plan = t.nucleo.paquetes.importar(PAQUETE, actor);
  assert.equal(plan.crear.length, ensayo.crear.length);
  const ana = t.db.prepare("SELECT * FROM personas WHERE telefono = '5491100000001'").get();
  const cli = t.db.prepare("SELECT * FROM clientes WHERE nombre = 'Estudio Ejemplo'").get();
  assert.equal(cli.autonomia, 'consultar_todo');
  assert.equal(t.db.prepare('SELECT r.nombre FROM persona_cliente pc JOIN roles r ON r.id = pc.rol_id WHERE pc.persona_id = ? AND pc.cliente_id = ?').get(ana.id, cli.id).nombre, 'Ventas');
  const grupo = t.db.prepare("SELECT * FROM chats WHERE id = '120363000000000001@g.us'").get();
  assert.equal(grupo.cliente_id, cli.id);
  assert.equal(grupo.responder_solo_si_mencionan, 1);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM memoria WHERE alcance = 'contacto' AND alcance_id = ?").get(ana.id).n, 1);

  const otra = t.nucleo.paquetes.importar(PAQUETE, actor);
  assert.equal(otra.crear.length, 0, otra.crear.join(', '));
  assert.equal(otra.actualizar.length, 0, otra.actualizar.join(', '));
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM memoria').get().n, 3);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM rutinas').get().n, 1);

  const cambiado = t.nucleo.paquetes.importar({ superagent: 1, clientes: [{ nombre: 'estudio ejemplo', autonomia: 'via_libre' }] }, actor);
  assert.deepEqual(cambiado.actualizar, ['cliente "estudio ejemplo" (autonomía)']);
  t.limpiar();
});

test('memoria larga se parte en notas de hasta 4000 caracteres', () => {
  const largo = Array.from({ length: 6 }, (_, i) => `Párrafo ${i}. ${'x'.repeat(1500)}`).join('\n\n');
  const trozos = partirMemoria(largo);
  assert.ok(trozos.length >= 3 && trozos.every((x) => x.length <= 4000));
  const { t, actor } = conDuena();
  const plan = t.nucleo.paquetes.importar({ superagent: 1, memoria: [{ alcance: 'cuenta', seccion: 'Historial', contenido: largo }] }, actor);
  assert.ok(plan.avisos.some((a) => /va partida en/.test(a)));
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM memoria WHERE seccion = 'Historial'").get().n, trozos.length);
  t.limpiar();
});

test('una rutina importada dispara a su hora, con quien la pidió', async () => {
  const { t, actor } = conDuena();
  t.nucleo.paquetes.importar(PAQUETE, actor);
  const r = t.db.prepare('SELECT * FROM rutinas').get();
  assert.equal(r.activa, 1);
  assert.equal(r.aprobada, 1);
  assert.ok(r.proxima > 0);
  t.nucleo.programador.tick(r.proxima);
  await t.avanzar(5_000);
  const c = t.corridas.find((x) => x.spec.prompt.includes('[rutina R-1] Mandale a Ana'));
  assert.ok(c, 'corrió');
  assert.equal(c.ctx.chatId, '5491100000001@c.us');
  assert.equal(c.ctx.personaId, t.db.prepare("SELECT id FROM personas WHERE telefono = '5491100000001'").get().id);
  t.limpiar();
});

test('por WhatsApp: el Propietario ve el ensayo, confirma en otro mensaje, y después exporta sin secretos', async () => {
  const t = armar({
    guion: (spec) => {
      if (spec.prompt.includes('cargá lo que te pasé')) return [
        { herramienta: 'importar_paquete', args: { paquete: PAQUETE } },
        { herramienta: 'importar_paquete', args: { paquete: PAQUETE, confirmado: true } },
      ];
      if (spec.prompt.includes('sí, cargalo')) return [{ herramienta: 'importar_paquete', args: { paquete: PAQUETE, confirmado: true } }];
      if (spec.prompt.includes('exportá')) return [{ herramienta: 'exportar_paquete', args: {} }];
      return [];
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'cargá lo que te pasé' });
  await t.avanzar(46_000);
  let c = t.corridas.at(-1);
  assert.match(c.resultados[0].r.content[0].text, /^Ensayo \(todavía no se aplicó nada\)[\s\S]*Secretos para cargar después[\s\S]*VERCEL_TOKEN/);
  assert.match(c.resultados[1].r.content[0].text, /todavía no vio el ensayo/);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM clientes WHERE nombre = 'Estudio Ejemplo'").get().n, 0);
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'sí, cargalo' });
  await t.avanzar(46_000);
  assert.match(t.corridas.at(-1).resultados[0].r.content[0].text, /^Importado[\s\S]*pedile lo que falta/);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM clientes WHERE nombre = 'Estudio Ejemplo'").get().n, 1);

  t.nucleo.entorno.guardar?.('VERCEL_TOKEN', 'valor-que-no-tiene-que-salir', { descripcion: 'publicar' });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'exportá la configuración' });
  await t.avanzar(46_000);
  c = t.corridas.at(-1);
  const texto = c.resultados[0].r.content[0].text;
  assert.match(texto, /Listo: \S+\.json/, texto);
  const ruta = /Listo: (\S+\.json)/.exec(texto)[1];
  const fs = await import('node:fs');
  const exportado = fs.readFileSync(ruta, 'utf8');
  assert.ok(!exportado.includes('valor-que-no-tiene-que-salir'));
  const p = JSON.parse(exportado);
  assert.deepEqual(validarPaquete(p), [], 'lo exportado se puede volver a importar');
  assert.equal(p.rutinas[0].pedida_por, '5491100000001');

  // Mudanza: en otra instalación entra todo, y reimportar no duplica.
  const { t: t2, actor: a2 } = conDuena();
  t2.nucleo.paquetes.importar(p, a2);
  assert.equal(t2.db.prepare("SELECT COUNT(*) AS n FROM memoria").get().n, 3);
  assert.equal(t2.nucleo.paquetes.importar(p, a2).crear.length, 0);
  t2.limpiar();

  // Un Colaborador no tiene estas herramientas.
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'hola' });
  await t.avanzar(46_000);
  assert.ok(!t.corridas.at(-1).spec.herramientasGateway.includes('importar_paquete'));
  t.limpiar();
});

test('API del panel: memoria, rutinas y paquetes', async () => {
  const t = armar();
  await entrarComoPropietario(t);
  const m = await t.pedir('POST', '/api/memoria', { alcance: 'cuenta', seccion: 'Contexto', contenido: 'Dato de la cuenta.' });
  assert.equal(m.status, 200);
  assert.equal((await t.pedir('POST', '/api/memoria', { alcance: 'cuenta', seccion: 'Contexto', contenido: 'x'.repeat(4001) })).status, 400);
  assert.equal((await t.pedir('GET', '/api/memoria')).json.memoria.length, 1);
  assert.equal((await t.pedir('DELETE', `/api/memoria/${m.json.id}`)).json.ok, true);
  const r = await t.pedir('POST', '/api/rutinas', { cuando: '0 8 * * *', instruccion: 'Resumen del día', destino: 'propietario' });
  assert.equal(r.status, 200);
  assert.ok(r.json.proxima > 0);
  const e = await t.pedir('POST', '/api/paquetes/ensayar', { paquete: PAQUETE });
  assert.match(e.json.resumen, /^Ensayo/);
  const mal = await t.pedir('POST', '/api/paquetes/importar', { paquete: { superagent: 1, secretos: [{ nombre: 'X_TOKEN', valor: 'y' }] } });
  assert.equal(mal.status, 400);
  assert.equal((await t.pedir('POST', '/api/paquetes/importar', { paquete: PAQUETE })).status, 200);
  assert.equal((await t.pedir('GET', '/api/paquetes/exportar')).json.clientes[0].nombre, 'Estudio Ejemplo');
  t.limpiar();
});

test('paquete con números: la política viaja sin credenciales y el número queda para vincular', () => {
  const t = armar();
  const duena = persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  const actor = { personaId: duena, permisos: t.nucleo.politica.rolDe(duena, 1).permisos };
  const p = { superagent: 1, numeros: [{ nombre: 'personal', etiqueta: 'personal', politica: { modo: 'leer', chats: 'clientes', guardar: true, dias: 30 } }],
    chats: [{ id: '120363000000000002@g.us', nombre: 'Grupo', responde_por: 'personal' }] };
  assert.deepEqual(validarPaquete({ superagent: 1, numeros: [{ nombre: 'Mal Nombre' }] }).length, 1);
  const plan = t.nucleo.paquetes.importar(p, actor);
  assert.ok(plan.crear.some((x) => /número "personal" \(queda para vincular en el panel\)/.test(x)));
  assert.equal(t.nucleo.numeros.politicaDe('personal').modo, 'leer');
  assert.equal(t.db.prepare("SELECT sesion_responde FROM chats WHERE id = '120363000000000002@g.us'").get().sesion_responde, 'personal');
  assert.equal(t.nucleo.paquetes.importar(p, actor).crear.length, 0);
  const ex = t.nucleo.paquetes.exportar();
  assert.deepEqual(ex.numeros.map((x) => x.nombre), ['default', 'personal']);
  t.limpiar();
});
