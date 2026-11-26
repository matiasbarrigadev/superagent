-- Paridad: procesamiento de adjuntos, archivos salientes, lecciones y conectores.
-- procesado: 0 pendiente, 1 con texto, 2 falló o no aplica.
ALTER TABLE adjuntos ADD COLUMN procesado INTEGER NOT NULL DEFAULT 0;
ALTER TABLE adjuntos ADD COLUMN nombre TEXT;

INSERT INTO ajustes (clave, valor) VALUES
  ('describir_imagenes', '1'),
  ('enviar_audio', '0'),
  ('navegador', '1');

-- Archivos que el agente puede mandar (copias del gateway, fuera de las carpetas aisladas).
CREATE TABLE archivos (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  chat_id TEXT,
  nombre TEXT NOT NULL,
  ruta TEXT NOT NULL,
  mime TEXT,
  tamano INTEGER,
  origen TEXT,
  creado INTEGER NOT NULL
);
