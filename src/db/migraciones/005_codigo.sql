-- Etapa 8: trabajo en código, GitHub y circuito de aprobación del Colaborador.
ALTER TABLE proyectos ADD COLUMN rama_principal TEXT NOT NULL DEFAULT 'main';
ALTER TABLE proyectos ADD COLUMN creado INTEGER;
ALTER TABLE trabajos ADD COLUMN proyecto_id INTEGER REFERENCES proyectos(id);
ALTER TABLE trabajos ADD COLUMN rama TEXT;

-- Links firmados de aprobación: de un solo uso, 30 minutos, atados a la aprobación y al Propietario.
CREATE TABLE enlaces (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  hash TEXT PRIMARY KEY,
  aprobacion_id TEXT NOT NULL,
  persona_id INTEGER NOT NULL,
  vence INTEGER NOT NULL,
  usado INTEGER
);

-- Rondas de revisión de una aprobación rechazada (máximo 3).
ALTER TABLE aprobaciones ADD COLUMN ronda INTEGER NOT NULL DEFAULT 1;
