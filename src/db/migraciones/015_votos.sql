-- Votos de las encuestas que manda el agente (el último voto de cada persona es el que vale), para mostrarlos en la
-- bandeja como en WhatsApp.
CREATE TABLE encuesta_votos (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  session TEXT NOT NULL,
  encuesta_id TEXT NOT NULL,          -- parte final del id de WhatsApp de la encuesta
  chat_id TEXT NOT NULL,
  de TEXT NOT NULL,                   -- quién votó (jid)
  nombre TEXT,                        -- cómo se llama, si se sabe
  opciones TEXT NOT NULL,             -- JSON: opciones elegidas ([] = quitó el voto)
  ts INTEGER NOT NULL,
  PRIMARY KEY (session, encuesta_id, de)
);
CREATE INDEX idx_encuesta_votos_chat ON encuesta_votos (chat_id);
