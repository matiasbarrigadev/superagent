-- Pantallas: terminales persistentes (tmux) en el entorno del Propietario, para lo interactivo (un login que imprime
-- una URL y espera, un instalador que pregunta). El gateway las mira y despierta al agente cuando piden algo.
CREATE TABLE pantallas (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  nombre TEXT PRIMARY KEY,
  chat_id TEXT,                       -- dónde avisar
  persona_id INTEGER,
  comando TEXT NOT NULL,
  avisar INTEGER NOT NULL DEFAULT 1,
  creada INTEGER NOT NULL,
  usada INTEGER NOT NULL,             -- última vez que el agente la miró o escribió
  ultimo_hash TEXT,                   -- lo último que se vio
  cambio INTEGER,                     -- cuándo cambió por última vez
  avisado_hash TEXT,                  -- lo último que se le avisó al agente
  terminada INTEGER NOT NULL DEFAULT 0
);
