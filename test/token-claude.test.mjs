// Captura del token de `claude setup-token`: completo, aunque llegue partido en pedazos y seguido de más texto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { crearCuentaClaude } from '../src/claude/cuenta.mjs';

const TOKEN = 'sk-ant-oat01-' + 'Ab9_-'.repeat(18) + 'xYzAA';

function ptyFalso(pedazos) {
  return {
    spawn() {
      let alDatos = () => {}, alSalir = () => {};
      setTimeout(() => { for (const p of pedazos) alDatos(p); alSalir({ exitCode: 0 }); }, 5);
      return { onData: (f) => { alDatos = f; }, onExit: (f) => { alSalir = f; }, write() {}, kill() {}, resize() {} };
    },
  };
}

async function capturar(pedazos) {
  const mem = new Map();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
  const c = crearCuentaClaude({ config: { dataDir: dir, claude: { bin: 'claude', usuarioSO: 'agente' }, sessionSecret: 'x'.repeat(48) },
    pty: ptyFalso(pedazos), ajustes: { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v) }, log: { log() {}, warn() {} } });
  let mostrado = '';
  await new Promise((r) => c.abrirTerminal({ alDatos: (d) => { mostrado += d; }, alSalir: r }));
  return { token: c.tokenActual(), mostrado };
}

test('token partido en dos pedazos y seguido de texto en la línea siguiente', async () => {
  const { token, mostrado } = await capturar([
    '\x1b[32m✓\x1b[39m Long-lived authentication token created\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n',
    TOKEN.slice(0, 40), TOKEN.slice(40) + '\r\n\r\nStore this token securely.\r\n',
  ]);
  assert.equal(token, TOKEN);
  assert.ok(!mostrado.includes(TOKEN.slice(13, 40)));
});

test('token con colores alrededor y pegado a la línea siguiente', async () => {
  const { token } = await capturar([`\x1b[1m${TOKEN}\x1b[22m\r\n\x1b[2GStore`]);
  assert.equal(token, TOKEN);
});

test('token al final de la salida, sin nada después', async () => {
  const { token } = await capturar([`Your OAuth token:\r\n${TOKEN}`]);
  assert.equal(token, TOKEN);
});

test('con validador: se guarda el candidato que funciona; si ninguno funciona, no se guarda nada', async () => {
  const mem = new Map();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
  const nueva = (pedazos) => crearCuentaClaude({ config: { dataDir: dir, claude: { bin: 'claude', usuarioSO: 'agente' }, sessionSecret: 'x'.repeat(48) },
    pty: ptyFalso(pedazos), ajustes: { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v) }, log: { log() {}, warn() {} } });
  // El CLI partió el token en dos líneas: el primer candidato (la línea sola) falla y el unido funciona.
  const partido = [`Your OAuth token:\r\n${TOKEN.slice(0, 60)}\r\n${TOKEN.slice(60)}\r\n\r\nStore this token securely.\r\n`];
  let c = nueva(partido);
  const probados = [];
  c.usarValidador(async (t) => { probados.push(t); return { ok: t === TOKEN, salida: 'API Error: 401' }; });
  let invalido = null;
  await new Promise((r) => c.abrirTerminal({ alDatos() {}, alSalir: r, alTokenInvalido: (s) => { invalido = s; } }));
  assert.equal(c.tokenActual(), TOKEN);
  assert.equal(probados.length, 2);
  assert.equal(invalido, null);

  mem.clear();
  c = nueva(partido);
  c.usarValidador(async () => ({ ok: false, salida: 'API Error: 401' }));
  await new Promise((r) => c.abrirTerminal({ alDatos() {}, alSalir: r, alTokenInvalido: (s) => { invalido = s; } }));
  assert.equal(c.tokenActual(), null);
  assert.match(invalido, /401/);
});
