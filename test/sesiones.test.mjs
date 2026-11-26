// Etapa 8d: sesiones de proyecto persistentes (buzón, --resume, sin escribirle a nadie).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe } from './ayuda.mjs';

function montar(guionSesion = () => []) {
  const t = armar({
    guion: async (spec, ctx, llamar) => {
      if (spec.tipo === 'sesion') return guionSesion(spec, ctx, llamar);
      if (spec.tipo === 'trabajo') return [];
      if (spec.prompt.includes('abrí una sesión')) return [{ herramienta: 'crear_sesion_proyecto', args: { nombre: 'Tienda', proyecto: 'tienda' } }];
      const m = /pasale a la sesión: (.*)/.exec(spec.prompt);
      if (m) return [{ herramienta: 'reenviar_a_sesion', args: { sesion: 'S-1', contenido: m[1] } }];
      return [];
    },
  });
  t.db.prepare("INSERT INTO proyectos (cliente_id, nombre) VALUES (1, 'tienda')").run();
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  persona(t.db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
  t.nucleo.ajustes.set('propietario_completo', '0'); // prueba el flujo de propuestas y aprobaciones (otros roles)
  return t;
}

async function abrirSesion(t) {
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'abrí una sesión para la tienda' });
  await t.avanzar(46_000);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM sesiones_proyecto').get().n, 0, 'hasta confirmar no existe');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'confirmo P-1' });
  await t.avanzar(0);
  assert.equal(t.db.prepare('SELECT estado FROM sesiones_proyecto').get().estado, 'activa');
}

test('una sesión no le puede escribir a nadie; el reenvío y su respuesta quedan en el buzón, en orden', async () => {
  const t = montar(async (spec, ctx, llamar) => {
    await llamar('responder', { texto: 'hola cliente' });
    await llamar('iniciar_conversacion', { destino: '5491199990000', texto: 'hola' });
    return [];
  });
  await abrirSesion(t);
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'pasale a la sesión: el cliente quiere cambiar el color del botón' });
  await t.avanzar(46_000);
  await t.avanzar(2000);
  const s = t.corridas.find((c) => c.spec.tipo === 'sesion');
  assert.ok(s, 'corrió la sesión');
  assert.ok(!s.spec.herramientasGateway.includes('responder') && !s.spec.herramientasGateway.includes('iniciar_conversacion'));
  assert.ok(s.resultados.every((r) => r.r.isError));
  assert.match(s.spec.prompt, /<buzon>\n\[pedido de Colab\] el cliente quiere cambiar el color del botón/);
  const buzon = t.db.prepare('SELECT de, tipo, estado FROM buzon ORDER BY id').all().map((b) => [b.de, b.tipo, b.estado]);
  assert.deepEqual(buzon, [['orquestador', 'pedido', 'leido'], ['sesion', 'respuesta', 'pendiente']]);
  assert.ok(!t.waha.enviados.some((e) => e.texto === 'hola cliente'));
  // La respuesta le llega al orquestador, en el chat de quien la pidió.
  const aviso = t.corridas.at(-1);
  assert.equal(aviso.spec.tipo, 'orquestador');
  assert.equal(aviso.spec.chatId, '5491122222222@c.us');
  assert.match(aviso.spec.prompt, /\[S-1 Tienda respondió\]/);
  t.limpiar();
});

test('un trabajo creado desde la sesión hereda el rol de la persona de origen; la sesión retoma su conversación', async () => {
  let vez = 0;
  const t = montar(() => (++vez === 1 ? [{ herramienta: 'delegar_trabajo', args: { descripcion: 'Revisar el catálogo completo de productos' } }] : []));
  await abrirSesion(t);
  await escribe(t.nucleo, { telefono: '5491122222222', texto: 'pasale a la sesión: revisá el catálogo' });
  await t.avanzar(46_000);
  await t.avanzar(2000);
  const trabajo = t.corridas.find((c) => c.spec.tipo === 'trabajo');
  assert.equal(trabajo.spec.rol.nombre, 'Colaborador');
  assert.equal(t.db.prepare('SELECT chat_id FROM trabajos').get().chat_id, '5491122222222@c.us', 'el resultado vuelve al chat del orquestador');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'pasale a la sesión: ¿cómo va?' });
  await t.avanzar(46_000);
  const corridasSesion = t.corridas.filter((c) => c.spec.tipo === 'sesion');
  assert.equal(corridasSesion.length, 2);
  assert.equal(corridasSesion[1].nueva, false);
  assert.equal(corridasSesion[1].sesion, corridasSesion[0].sesion, 'mismo --resume');
  assert.equal(corridasSesion[1].spec.rol.nombre, 'Propietario', 'el rol es el de quien escribe esta vez');
  t.limpiar();
});

test('una sesión pausada no se despierta', async () => {
  const t = montar(() => []);
  await abrirSesion(t);
  t.nucleo.sesiones.cambiarEstado(1, 'pausada');
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'pasale a la sesión: urgente' });
  await t.avanzar(46_000);
  await t.avanzar(5000);
  assert.ok(!t.corridas.some((c) => c.spec.tipo === 'sesion'));
  assert.match(t.corridas.at(-1).resultados[0].r.content[0].text, /está pausada/);
  t.nucleo.sesiones.cambiarEstado(1, 'activa');
  await t.avanzar(1000);
  assert.ok(t.corridas.some((c) => c.spec.tipo === 'sesion'), 'al reanudar, lee el buzón');
  t.limpiar();
});
