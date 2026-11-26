-- Más gente en el panel: el Propietario invita con un link de un solo uso y elige qué secciones ve cada uno.
-- accesos: lista JSON de secciones (ver src/auth/accesos.mjs); NULL = todo (el Propietario y los administradores).
ALTER TABLE usuarios_web ADD COLUMN accesos TEXT;

CREATE TABLE IF NOT EXISTS invitaciones (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  nombre TEXT,
  accesos TEXT,
  creada INTEGER NOT NULL,
  vence INTEGER NOT NULL,
  creada_por TEXT,
  usada INTEGER,
  usuario_id INTEGER REFERENCES usuarios_web(id)
);
