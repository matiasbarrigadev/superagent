-- Consumo de Claude por corrida (lo que informa Claude Code al terminar) y tamaño del contexto.
ALTER TABLE corridas ADD COLUMN tokens_entrada INTEGER;
ALTER TABLE corridas ADD COLUMN tokens_cache INTEGER;
ALTER TABLE corridas ADD COLUMN tokens_salida INTEGER;
ALTER TABLE corridas ADD COLUMN costo_usd REAL;
ALTER TABLE corridas ADD COLUMN contexto_tokens INTEGER;
CREATE INDEX IF NOT EXISTS idx_corridas_inicio ON corridas (inicio);

INSERT OR IGNORE INTO ajustes (clave, valor) VALUES ('aviso_consumo_pct', '80'), ('compactar_pct', '60');
