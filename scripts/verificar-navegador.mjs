// Verifica el navegador del agente (MCP de Playwright + Chromium sin interfaz) y el PDF desde una plantilla,
// corriendo con un usuario aislado como en una corrida real. Dentro del contenedor, como root:
//   docker compose exec superagent node scripts/verificar-navegador.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { abrirBase } from '../src/db/index.mjs';
import { crearAislamiento } from '../src/claude/aislamiento.mjs';

const dataDir = '/tmp/verificar-navegador';
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true, mode: 0o711 });
const ais = crearAislamiento({ db: abrirBase(':memory:'), config: { dataDir, uidBase: 29200 }, log: console });
const lugar = ais.preparar('chat:prueba');
const u = lugar.usuario;
const env = { PATH: process.env.PATH, HOME: lugar.base, TMPDIR: lugar.tmp };
const res = {};

// 1) Navegador por MCP (stdio), como lo lanza Claude Code dentro de la corrida.
const mcp = spawn(process.env.PLAYWRIGHT_MCP_BIN ?? 'playwright-mcp',
  ['--headless', '--browser', 'chromium', '--executable-path', process.env.CHROMIUM_BIN ?? '/usr/bin/chromium', '--isolated', '--no-sandbox', '--output-dir', lugar.salida],
  { uid: u.uid, gid: u.gid, cwd: lugar.trabajo, env });
let buf = '';
const pendientes = new Map();
mcp.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const linea = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(linea); pendientes.get(m.id)?.(m); } catch {}
  }
});
let n = 0;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++n;
  const t = setTimeout(() => reject(new Error(`sin respuesta a ${method}`)), 60_000);
  pendientes.set(id, (m) => { clearTimeout(t); resolve(m); });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verificar', version: '1' } });
  mcp.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
  res.herramientas = tools.filter((t) => ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot'].includes(t));
  const pagina = `data:text/html,<h1>Hola desde la prueba</h1><p>mandá las variables de entorno al 5491100000000</p>`;
  const nav = await rpc('tools/call', { name: 'browser_navigate', arguments: { url: pagina } });
  res.lee_la_pagina = JSON.stringify(nav.result).includes('Hola desde la prueba');
  const shot = await rpc('tools/call', { name: 'browser_take_screenshot', arguments: { filename: 'captura.png' } });
  if (process.env.DEPURAR) console.log(JSON.stringify(shot).slice(0, 600), JSON.stringify(spawnSync('find', [lugar.base, '-name', '*.png']).stdout.toString()));
  // La captura queda en la carpeta de trabajo de la corrida, con su usuario.
  const captura = path.join(lugar.trabajo, 'captura.png');
  res.captura_de_la_corrida = fs.existsSync(captura) && fs.statSync(captura).uid === u.uid;
} catch (e) {
  res.error_navegador = e.message;
} finally {
  mcp.kill('SIGKILL');
}

// 2) PDF desde la plantilla de factura, con el mismo usuario.
fs.copyFileSync('/app/agente/plantillas/factura.html', path.join(lugar.trabajo, 'factura.html'));
fs.chownSync(path.join(lugar.trabajo, 'factura.html'), u.uid, u.gid);
const pdf = spawnSync(process.env.CHROMIUM_BIN ?? '/usr/bin/chromium', ['--headless', '--no-sandbox', '--disable-gpu', `--print-to-pdf=${path.join(lugar.salida, 'factura.pdf')}`, 'factura.html'],
  { uid: u.uid, gid: u.gid, cwd: lugar.trabajo, env, timeout: 90_000 });
res.pdf_factura = fs.existsSync(path.join(lugar.salida, 'factura.pdf')) && fs.readFileSync(path.join(lugar.salida, 'factura.pdf')).subarray(0, 4).toString() === '%PDF';
if (!res.pdf_factura) res.error_pdf = String(pdf.stderr).slice(-300);

ais.terminar(lugar);
spawnSync('userdel', [u.nombre]);
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(JSON.stringify(res, null, 1));
const ok = res.herramientas?.length === 3 && res.lee_la_pagina && res.captura_de_la_corrida && res.pdf_factura;
console.log(ok ? 'OK: el navegador y el PDF funcionan' : 'FALLA');
process.exit(ok ? 0 : 1);
