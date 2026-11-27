// Pantallas: el agente corre algo interactivo (un login que muestra una URL y espera), lee la pantalla, escribe en
// ella, y el gateway lo despierta cuando pide algo nuevo o termina. Sin código por servicio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, persona, escribe } from './ayuda.mjs';

/** tmux falso: cada sesión tiene su texto; lo que se escribe lo procesa `reaccion`. */
function tmuxFalso(reaccion = () => {}) {
  const sesiones = new Map();
  const llamadas = [];
  const fn = async (args) => {
    const a = args.slice(2); // sin "-S <socket>"
    llamadas.push(a);
    const i = a.indexOf('new-session');
    if (i >= 0) {
      const nombre = a[a.indexOf('-s', i) + 1];
      const comando = a.at(-1);
      sesiones.set(nombre, { texto: `$ ${comando}\nAbrí este link: https://auth.test/device?code=ABCD\nPegá el código de autorización:`, muerta: false, codigo: null });
      return { codigo: 0, salida: '' };
    }
    const t = a[a.indexOf('-t') + 1];
    const s = sesiones.get(t);
    if (a[0] === 'capture-pane') return s ? { codigo: 0, salida: `${s.texto}\n\n\n` } : { codigo: 1, salida: '', error: "can't find session" };
    if (a[0] === 'display-message') return { codigo: 0, salida: s ? `${s.muerta ? 1 : 0}|${s.codigo ?? ''}\n` : '' };
    if (a[0] === 'send-keys') { if (s) reaccion(s, a.slice(a.indexOf('-t') + 2)); return { codigo: 0, salida: '' }; }
    if (a[0] === 'kill-session') { sesiones.delete(t); return { codigo: 0, salida: '' }; }
    return { codigo: 0, salida: '' };
  };
  return { fn, sesiones, llamadas };
}

test('abrir, ver y escribir: el código se pega, el login termina y el agente se entera solo', async () => {
  const tm = tmuxFalso((s, teclas) => {
    if (teclas[0] === '-l') s.texto += ` ${teclas.at(-1)}`;
    if (teclas[0] === 'Enter' && /XYZ-123/.test(s.texto)) s.texto += ' (verificando…)';
  });
  const t = armar({
    tmuxPantallas: tm.fn,
    guion: async (spec, ctx, llamar) => {
      if (spec.prompt.includes('conectá el calendario')) {
        const r = await llamar('pantalla', { accion: 'abrir', nombre: 'login-cal', comando: 'claude mcp login calendario --no-browser' });
        await llamar('responder', { texto: `Abrí este link: ${/https:\S+/.exec(JSON.stringify(r))?.[0]}` });
      }
      if (spec.prompt.includes('XYZ-123')) await llamar('pantalla', { accion: 'escribir', nombre: 'login-cal', texto: 'XYZ-123' });
    },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'conectá el calendario' });
  await t.avanzar(46_000);
  assert.ok(tm.sesiones.has('login-cal'));
  assert.ok(t.waha.enviados.some((e) => /auth\.test\/device/.test(e.texto ?? '')), 'el link le llega a la persona');
  // Lo que el agente ya vio no se le vuelve a avisar.
  await t.avanzar(10_000);
  assert.ok(!t.db.prepare("SELECT 1 FROM mensajes WHERE tipo = 'evento' AND cuerpo LIKE '[pantalla login-cal%'").get());
  // La persona contesta el código: el agente lo escribe; el login termina y el vigía lo despierta.
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'el código es XYZ-123' });
  await t.avanzar(10_000);
  assert.match(tm.sesiones.get('login-cal').texto, /XYZ-123 \(verificando/);
  // El CLI termina un rato después, cuando el agente ya no está mirando.
  Object.assign(tm.sesiones.get('login-cal'), { muerta: true, codigo: 0 });
  tm.sesiones.get('login-cal').texto += '\nListo: autenticado como ana@ejemplo.test';
  await t.avanzar(5_000);
  await t.avanzar(5_000);
  const evt = t.db.prepare("SELECT cuerpo FROM mensajes WHERE tipo = 'evento' AND cuerpo LIKE '[pantalla login-cal terminó%'").get();
  assert.ok(evt, 'se entera de que terminó');
  assert.match(evt.cuerpo, /autenticado como ana@ejemplo\.test/);
  t.limpiar();
});

test('si la pantalla cambia sola y queda quieta, avisa una vez', async () => {
  const tm = tmuxFalso();
  const t = armar({ tmuxPantallas: tm.fn });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await t.nucleo.pantallas.abrir({ nombre: 'instalador', comando: 'instalar', chatId: '5491111111111@c.us' });
  tm.sesiones.get('instalador').texto += '\n¿Continuar? [s/n]';
  await t.avanzar(5_000); // ve el cambio
  await t.avanzar(5_000); // quieta: avisa
  await t.avanzar(5_000); // ya avisó: no repite
  const n = t.db.prepare("SELECT COUNT(*) AS n FROM mensajes WHERE tipo = 'evento' AND cuerpo LIKE '[pantalla instalador muestra algo nuevo]%'").get().n;
  assert.equal(n, 1);
  t.limpiar();
});

test('teclas no permitidas, nombres raros y solo el Propietario', async () => {
  const tm = tmuxFalso();
  const t = armar({ tmuxPantallas: tm.fn, guion: async () => {} });
  await t.nucleo.pantallas.abrir({ nombre: 'Prueba Uno!', comando: 'bash' });
  assert.ok(tm.sesiones.has('prueba-uno'));
  await assert.rejects(t.nucleo.pantallas.escribir('prueba-uno', { teclas: ['C-c; rm -rf /'] }), /Tecla no permitida/);
  persona(t.db, { nombre: 'Colaboradora', telefono: '5492222222222', rol: 'Colaborador', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5492222222222', texto: 'hola' });
  await t.avanzar(46_000);
  assert.ok(!t.corridas.at(-1).spec.herramientasGateway.some((h) => h.endsWith('pantalla')));
  t.limpiar();
});

test('estado del entorno en un lugar: MCP de Claude Code (también de plugins), logins y pantallas', async () => {
  const t = armar({
    tmuxPantallas: tmuxFalso().fn,
    correrEstado: async () => ({ codigo: 0, salida: 'calendario: https://cal.test/mcp (HTTP) - ! Needs authentication' }),
    guion: async (spec, ctx, llamar) => { if (spec.prompt.includes('qué te falta')) await llamar('pantalla', { accion: 'estado' }); },
  });
  persona(t.db, { nombre: 'Dueña', telefono: '5491111111111', rol: 'Propietario', verificada: 1 });
  await escribe(t.nucleo, { telefono: '5491111111111', texto: 'qué te falta?' });
  await t.avanzar(46_000);
  const r = JSON.stringify(t.corridas.at(-1).resultados);
  assert.match(r, /Needs authentication/);
  assert.match(r, /Pantallas abiertas: ninguna/);
  t.limpiar();
});
