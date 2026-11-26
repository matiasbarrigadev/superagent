-- Apps del agente: lo que levanta en su entorno (un sistema, un panel, una calculadora) y se publica en
-- <url pública>/apps/<nombre>/. El gateway hace de proxy al puerto local y, si hay comando, la mantiene viva.
CREATE TABLE IF NOT EXISTS apps (
  nombre TEXT PRIMARY KEY,
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  puerto INTEGER NOT NULL,
  comando TEXT,
  dir TEXT,
  quitar_prefijo INTEGER NOT NULL DEFAULT 0,
  descripcion TEXT,
  creado INTEGER NOT NULL,
  actualizado INTEGER NOT NULL
);
