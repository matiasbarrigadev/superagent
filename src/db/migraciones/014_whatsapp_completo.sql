-- WhatsApp más completo: la salida admite fotos, videos, stickers, reacciones, ubicaciones, contactos, encuestas,
-- ediciones y borrados; se guarda el id de WhatsApp de lo enviado (para editarlo o borrarlo después); y se
-- registran las reacciones, ediciones y borrados que llegan.

-- SQLite no cambia un CHECK: la tabla se rehace con los tipos nuevos.
CREATE TABLE salida_nueva (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'texto' CHECK (tipo IN ('texto', 'archivo', 'voz', 'imagen', 'video', 'sticker', 'reaccion', 'ubicacion', 'contacto', 'encuesta', 'editar', 'borrar')),
  contenido TEXT NOT NULL,
  responde_a TEXT,
  contacto_nuevo INTEGER NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'enviado', 'fallido')),
  no_antes_de INTEGER NOT NULL DEFAULT 0,
  intentos INTEGER NOT NULL DEFAULT 0,
  corrida_id INTEGER,
  origen TEXT,
  error TEXT,
  creado INTEGER NOT NULL,
  enviado INTEGER,
  sesion TEXT,
  waha_id TEXT
);
INSERT INTO salida_nueva (cuenta_id, id, chat_id, tipo, contenido, responde_a, contacto_nuevo, estado, no_antes_de, intentos, corrida_id, origen, error, creado, enviado, sesion)
  SELECT cuenta_id, id, chat_id, tipo, contenido, responde_a, contacto_nuevo, estado, no_antes_de, intentos, corrida_id, origen, error, creado, enviado, sesion FROM salida;
DROP TABLE salida;
ALTER TABLE salida_nueva RENAME TO salida;
CREATE INDEX idx_salida_pendiente ON salida (estado, no_antes_de);

-- Reacciones que llegan (una por persona y mensaje: la última vale; emoji vacío = la quitó).
CREATE TABLE reacciones (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  session TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  mensaje_id TEXT NOT NULL,
  de TEXT NOT NULL,
  emoji TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (session, mensaje_id, de)
);
CREATE INDEX idx_reacciones_chat ON reacciones (chat_id);

ALTER TABLE mensajes ADD COLUMN editado INTEGER;
ALTER TABLE mensajes ADD COLUMN borrado INTEGER;
