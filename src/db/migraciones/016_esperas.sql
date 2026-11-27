-- Autorizaciones que el agente espera (un login por CLI, un link): el gateway comprueba cada tanto con el comando que
-- eligió el agente y lo despierta en la charla donde se pidió cuando queda conectado o vence.
CREATE TABLE esperas (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  persona_id INTEGER,
  servicio TEXT NOT NULL,             -- qué se está conectando ("Vercel")
  comprobar TEXT NOT NULL,            -- comando que sale bien cuando ya quedó conectado
  creada INTEGER NOT NULL,
  vence INTEGER NOT NULL,
  proxima INTEGER NOT NULL,
  ultima_salida TEXT,
  UNIQUE (chat_id, servicio)
);
