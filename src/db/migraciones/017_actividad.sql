-- "Ver al agente": los pasos de cada corrida (qué dijo, qué herramientas llamó y qué le devolvieron), ya tachados,
-- y por qué el gateway no le pasó un mensaje al agente.
CREATE TABLE corrida_pasos (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  corrida_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  tipo TEXT NOT NULL,                 -- texto | herramienta | resultado
  nombre TEXT,                        -- nombre técnico de la herramienta
  titulo TEXT,                        -- en palabras simples ("Ejecutó un comando: instalar dependencias")
  categoria TEXT,                     -- responder, comando, archivo, web, conector, decision…
  detalle TEXT,                       -- entrada o salida, tachada y recortada
  resumen TEXT,
  error INTEGER NOT NULL DEFAULT 0,
  ref TEXT                            -- une la llamada con su resultado
);
CREATE INDEX idx_corrida_pasos ON corrida_pasos (corrida_id, id);
CREATE INDEX idx_corrida_pasos_ts ON corrida_pasos (ts);

-- chat_inactivo, contexto (grupo sin mención), sin_conversar, sin_alta.
ALTER TABLE mensajes ADD COLUMN descarte TEXT;
