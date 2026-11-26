// Base SQLite (node:sqlite) con migraciones numeradas en src/db/migraciones.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const DIR_MIGRACIONES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migraciones');

export function abrirBase(ruta) {
  if (ruta !== ':memory:') fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const db = new DatabaseSync(ruta);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrar(db);
  // Bases creadas por versiones anteriores pudieron quedar legibles: se corrige al abrir.
  if (ruta !== ':memory:' && process.platform !== 'win32') {
    for (const f of [ruta, `${ruta}-wal`, `${ruta}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  }
  return db;
}

export function migrar(db) {
  db.exec('CREATE TABLE IF NOT EXISTS _migraciones (version INTEGER PRIMARY KEY, aplicada INTEGER NOT NULL)');
  const hechas = new Set(db.prepare('SELECT version FROM _migraciones').all().map((r) => r.version));
  const archivos = fs.readdirSync(DIR_MIGRACIONES).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  for (const f of archivos) {
    const version = Number(f.split('_')[0]);
    if (hechas.has(version)) continue;
    const sql = fs.readFileSync(path.join(DIR_MIGRACIONES, f), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migraciones (version, aplicada) VALUES (?, ?)').run(version, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migración ${f}: ${e.message}`);
    }
  }
}

export function auditar(db, accion, { actor = null, rol = null, decision = null, detalle = null } = {}) {
  db.prepare('INSERT INTO auditoria (ts, actor, rol, accion, decision_politica, detalle) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), actor, rol, accion, decision, detalle == null ? null : JSON.stringify(detalle));
}
