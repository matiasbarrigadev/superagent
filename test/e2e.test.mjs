// Punta a punta: ingesta → motor → spawn de un "claude" falso → MCP del gateway por HTTP → salida a WAHA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { abrirBase } from '../src/db/index.mjs';
import { crearNucleo } from '../src/nucleo.mjs';
import { crearEjecutor } from '../src/engine/claude.mjs';
import { crearAislamiento } from '../src/claude/aislamiento.mjs';
import { wahaFalso, persona, escribe, silencio } from './ayuda.mjs';

const FALSO = fileURLToPath(new URL('./falsos/claude.mjs', import.meta.url));

test('un mensaje real de punta a punta, con el binario lanzado y el MCP por HTTP', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-e2e-'));
  const db = abrirBase(':memory:');
  db.prepare('UPDATE cuentas SET responder_sin_alta = 1 WHERE id = 1').run();
  const waha = wahaFalso();
  const cuenta = {
    comando: (a) => ({ file: process.execPath, args: [FALSO, ...a] }),
    entorno: ({ home, configDir }) => ({ PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: configDir, SystemRoot: process.env.SystemRoot }),
  };
  let tiempo = Date.now();
  const config = { dataDir, mcpUrl: null };
  const aislamiento = crearAislamiento({ db, config, log: silencio });
  const nucleo = crearNucleo({ db, config, waha, aislamiento, ejecutar: crearEjecutor({ cuenta, aislamiento, log: silencio }), reloj: () => tiempo, log: silencio });
  const srv = await new Promise((resolve) => { const s = serve({ fetch: nucleo.mcp.app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve({ s, port: info.port })); });
  config.mcpUrl = `http://127.0.0.1:${srv.port}/mcp`;
  try {
    persona(db, { nombre: 'Colab', telefono: '5491122222222', rol: 'Colaborador' });
    await escribe(nucleo, { telefono: '5491122222222', texto: '¿me ayudás con el informe?' });
    await escribe(nucleo, { telefono: '5491199999999', texto: 'hola, ¿qué venden?' });
    tiempo += 46_000;
    nucleo.motor.tick();
    await nucleo.motor.esperar();
    await nucleo.salida.procesar();
    const colab = waha.enviados.find((e) => e.chatId === '5491122222222@c.us');
    const tercero = waha.enviados.find((e) => e.chatId === '5491199999999@c.us');
    assert.match(colab.texto, /^eco: Colab \(Colaborador\): ¿me ayudás con el informe\?/);
    assert.match(colab.texto, /delegar_trabajo/);
    assert.match(tercero.texto, /herramientas: responder,reaccionar,guardar_memoria,preguntar_al_propietario$/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM corridas WHERE estado = 'ok'").get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sesiones_claude').get().n, 2);
    // Cada conversación tuvo su usuario y su carpeta; el archivo del MCP (con el token) se borró al terminar.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usuarios_so').get().n, 2);
    const r1 = aislamiento.rutas('chat:5491122222222@c.us'), r2 = aislamiento.rutas('chat:5491199999999@c.us');
    assert.notEqual(r1.base, r2.base);
    assert.ok(fs.existsSync(r1.config) && fs.existsSync(r2.trabajo));
    assert.ok(!fs.existsSync(path.join(r1.base, 'mcp.json')));
    // El token de una corrida terminada ya no sirve.
    const r = await fetch(config.mcpUrl, { method: 'POST', headers: { Authorization: 'Bearer cualquiera', 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(r.status, 401);
  } finally {
    srv.s.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
