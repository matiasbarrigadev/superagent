import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { abrirBase, migrar } from '../src/db/index.mjs';

test('todas las tablas tienen cuenta_id', () => {
  const db = abrirBase(':memory:');
  const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migraciones'").all();
  assert.ok(tablas.length >= 30, `pocas tablas: ${tablas.length}`);
  for (const { name } of tablas) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
    assert.ok(cols.includes('cuenta_id'), `${name} no tiene cuenta_id`);
  }
});

test('las migraciones se pueden reaplicar sin efecto', () => {
  const db = abrirBase(':memory:');
  migrar(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM roles WHERE predefinido = 1').get().n, 3);
  assert.equal(db.prepare('SELECT estado FROM cuentas WHERE id = 1').get().estado, 'setup');
});

test('el código no menciona a ningún cliente (decisión 20)', () => {
  const raiz = path.resolve(import.meta.dirname, '..');
  // Se compara contra hashes (sha256 de cada palabra en minúsculas) para que ni este test nombre a los clientes.
  const HASHES = new Set([
    'fa806d7619a1a7218e5ed0e2aa1c4121d528608636177a9d781f4aa6b9e9b3c3',
    '3e76850e84c28f4b536d66a1fdbde3b2c9ec440abb276c266f69a24e6aa7070a',
    '01db71ab8048f74a4b92c26ba77285ade0687ac192758e8185ad52701f649ef2',
  ]);
  const prohibidos = {
    [Symbol.match]: () => null,
    test: (texto) => (String(texto).normalize('NFC').toLowerCase().match(/\p{L}+/gu) ?? [])
      .some((w) => HASHES.has(crypto.createHash('sha256').update(w).digest('hex'))),
  };
  const revisar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git', 'data'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) revisar(p);
      else if (/\.(m?js|jsx|ts|tsx|sql|json|md|yml|yaml|toml|css|html|sh)$|Dockerfile$/.test(e.name)) {
        assert.ok(!prohibidos.test(fs.readFileSync(p, 'utf8')), `menciona un cliente: ${path.relative(raiz, p)}`);
      }
    }
  };
  for (const d of ['src', 'web/src', 'agente', 'railway', 'scripts', 'test']) {
    if (fs.existsSync(path.join(raiz, d))) revisar(path.join(raiz, d));
  }
  for (const f of ['Dockerfile', 'docker-compose.yml', 'README.md']) {
    if (fs.existsSync(path.join(raiz, f))) assert.ok(!prohibidos.test(fs.readFileSync(path.join(raiz, f), 'utf8')), f);
  }
});
