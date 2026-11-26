-- Cierre de la paridad: clientes propuestos por el agente (7e), publicación con procedimiento (8c),
-- sesiones de proyecto (8d) y pausa (9).

-- Propuestas: ahora también de clientes y de sesiones de proyecto (se rehace la tabla por el CHECK).
CREATE TABLE propuestas_nueva (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('rol', 'persona', 'cliente', 'sesion')),
  datos TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  propuesta_por TEXT,
  creada INTEGER,
  decidida_por INTEGER,
  chat_origen TEXT,
  persona_origen INTEGER
);
INSERT INTO propuestas_nueva SELECT cuenta_id, id, tipo, datos, estado, propuesta_por, creada, decidida_por, chat_origen, persona_origen FROM propuestas;
DROP TABLE propuestas;
ALTER TABLE propuestas_nueva RENAME TO propuestas;

-- Corridas: tipos nuevos (sesión de proyecto y publicación).
CREATE TABLE corridas_nueva (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('orquestador', 'trabajo', 'rutina', 'sesion', 'publicacion')),
  chat_id TEXT, persona_id INTEGER, persona_origen INTEGER, rol TEXT, credencial_usada TEXT, modelo TEXT, esfuerzo TEXT,
  trabajo_id TEXT, session_id_claude TEXT, estado TEXT NOT NULL, inicio INTEGER, fin INTEGER, error TEXT,
  canal TEXT, origen TEXT, cliente_id INTEGER, herramientas TEXT, resultado TEXT
);
INSERT INTO corridas_nueva SELECT cuenta_id, id, tipo, chat_id, persona_id, persona_origen, rol, credencial_usada, modelo, esfuerzo,
  trabajo_id, session_id_claude, estado, inicio, fin, error, canal, origen, cliente_id, herramientas, resultado FROM corridas;
DROP TABLE corridas;
ALTER TABLE corridas_nueva RENAME TO corridas;

-- Publicación: procedimiento versionado (JSON con los cinco pasos) y dominios del proyecto.
ALTER TABLE proyectos ADD COLUMN procedimiento_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proyectos ADD COLUMN dominios TEXT NOT NULL DEFAULT '[]';
ALTER TABLE publicaciones ADD COLUMN estado TEXT NOT NULL DEFAULT 'corriendo';
ALTER TABLE publicaciones ADD COLUMN inicio INTEGER;
ALTER TABLE publicaciones ADD COLUMN fin INTEGER;
ALTER TABLE publicaciones ADD COLUMN procedimiento_version INTEGER;

-- Sesiones de proyecto: quién la pidió y en qué chat responde; el buzón guarda el chat de origen.
ALTER TABLE sesiones_proyecto ADD COLUMN persona_origen INTEGER;
ALTER TABLE sesiones_proyecto ADD COLUMN chat_origen TEXT;
ALTER TABLE sesiones_proyecto ADD COLUMN rama TEXT;
ALTER TABLE sesiones_proyecto ADD COLUMN creada INTEGER;
ALTER TABLE buzon ADD COLUMN chat_origen TEXT;
ALTER TABLE buzon ADD COLUMN creado INTEGER;
ALTER TABLE buzon ADD COLUMN respuesta_a INTEGER;

INSERT INTO ajustes (clave, valor) VALUES ('mensaje_pausa', 'El agente está en pausa por un momento. Tu mensaje quedó guardado.');
