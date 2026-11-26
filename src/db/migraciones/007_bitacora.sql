-- Bitácora de decisiones: lo que se aprobó, rechazó o decidió (en la charla con el Propietario o en el panel).
-- No hay que confirmar nada acá: es el registro para mirar después.
CREATE TABLE bitacora (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  persona_id INTEGER,          -- quién decidió
  pedida_por INTEGER,          -- quién lo pidió (si fue otra persona)
  chat_id TEXT,
  donde TEXT NOT NULL,         -- 'charla' | 'panel' | 'whatsapp'
  resultado TEXT NOT NULL,     -- 'aprobado' | 'rechazado' | 'hecho' | 'decision'
  que TEXT NOT NULL,           -- resumen en una línea
  ref TEXT                     -- A-n, P-n, acción
);
CREATE INDEX idx_bitacora_ts ON bitacora (ts);
