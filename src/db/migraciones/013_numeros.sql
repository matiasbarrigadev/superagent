-- Varios números de WhatsApp por instalación (sesiones de WAHA), cada uno con su política.
CREATE TABLE sesiones_wa (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  nombre TEXT PRIMARY KEY,            -- nombre de la sesión en WAHA
  etiqueta TEXT,                      -- cómo lo llama la gente ("empresa", "personal de Ana")
  numero TEXT,                        -- teléfono vinculado (se completa solo)
  principal INTEGER NOT NULL DEFAULT 0,
  politica TEXT NOT NULL,             -- JSON: modo, chats, guardar, días, escribir primero, conectores, notas
  fuera_de_alcance INTEGER NOT NULL DEFAULT 0,
  creada INTEGER,
  actualizada INTEGER
);

-- Qué números ven cada chat (un grupo puede verse desde dos).
CREATE TABLE chat_sesiones (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  chat_id TEXT NOT NULL,
  sesion TEXT NOT NULL,
  visto INTEGER,
  PRIMARY KEY (chat_id, sesion)
);

-- Qué número responde en un chat compartido (lo elige el Propietario); si hay conflicto sin elegir, se avisa una vez.
ALTER TABLE chats ADD COLUMN sesion_responde TEXT;
ALTER TABLE chats ADD COLUMN conflicto_numeros INTEGER NOT NULL DEFAULT 0;
-- Por qué número sale cada envío.
ALTER TABLE salida ADD COLUMN sesion TEXT;

-- Lo que ya había: cada chat lo vio el número por el que llegaron sus mensajes.
INSERT OR IGNORE INTO chat_sesiones (chat_id, sesion, visto)
  SELECT chat_id, session, MAX(recibido) FROM mensajes WHERE canal = 'whatsapp' AND session NOT IN ('panel', 'interno') GROUP BY chat_id, session;
