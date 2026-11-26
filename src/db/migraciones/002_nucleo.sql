-- Núcleo: entrada y salida de WhatsApp, motor, roles con niveles, clientes, onboarding,
-- trabajos, rutinas, entradas y reglas de contacto (etapas 1, 5, 6, 6c, 7 y 7b).

-- Permisos con niveles (TEORIA §2.5). Reemplaza la lista provisoria de la migración 001.
UPDATE roles SET permisos = '{"conversar":true,"herramientas_negocio":"lectura_escritura","trabajar_en_codigo":"en_rama","publicar_sistemas":"directo","cambiar_agente":"directo","gestionar_personas":true,"gestionar_roles":true,"aprobar":true,"conectar_cuentas":true,"conectar_mis_cuentas":true,"usar_web":true,"programar_rutinas":"directo","iniciar_conversacion":"directo"}',
  descripcion = 'Dueño de la instalación: puede todo y aprueba lo de los demás.'
  WHERE nombre = 'Propietario' AND predefinido = 1;
UPDATE roles SET permisos = '{"conversar":true,"herramientas_negocio":"lectura_escritura","trabajar_en_codigo":"en_rama","publicar_sistemas":"con_aprobacion","cambiar_agente":"con_aprobacion","gestionar_personas":false,"gestionar_roles":false,"aprobar":false,"conectar_cuentas":false,"conectar_mis_cuentas":true,"usar_web":true,"programar_rutinas":"con_aprobacion","iniciar_conversacion":"con_aprobacion"}',
  descripcion = 'Equipo: trabaja con el agente; publicar y cambiar el agente pasan por el Propietario.'
  WHERE nombre = 'Colaborador' AND predefinido = 1;
UPDATE roles SET permisos = '{"conversar":true,"herramientas_negocio":"ninguna","trabajar_en_codigo":"no","publicar_sistemas":"no","cambiar_agente":"no","gestionar_personas":false,"gestionar_roles":false,"aprobar":false,"conectar_cuentas":false,"conectar_mis_cuentas":false,"usar_web":false,"programar_rutinas":"no","iniciar_conversacion":"no"}',
  descripcion = 'Cualquier otra persona: conversa con el agente y nada más.'
  WHERE nombre = 'Tercero' AND predefinido = 1;

-- Personas: alta manual (el Propietario la cargó) o automática (escribió sin alta), y verificación del número.
ALTER TABLE personas ADD COLUMN alta_manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE personas ADD COLUMN verificada INTEGER NOT NULL DEFAULT 0;
ALTER TABLE personas ADD COLUMN activa INTEGER NOT NULL DEFAULT 1;
UPDATE personas SET alta_manual = 1;
CREATE INDEX idx_personas_telefono ON personas (telefono);

CREATE TABLE verificaciones (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  telefono TEXT NOT NULL,
  hash TEXT NOT NULL,
  vence INTEGER NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 0
);

-- Cliente propio (la misma organización), con vía libre: una instalación sin clientes no nota nada.
INSERT INTO clientes (id, nombre, tipo, autonomia, estado) VALUES (1, 'Propio', 'propio', 'via_libre', 'activo');

-- Chats: nombre y alta. Los grupos nacen inactivos (lo decide el código al crearlos).
ALTER TABLE chats ADD COLUMN nombre TEXT;
ALTER TABLE chats ADD COLUMN creado INTEGER;
ALTER TABLE chats ADD COLUMN proyecto_id INTEGER REFERENCES proyectos(id);

-- Mensajes: canal, teléfono resuelto, adjunto, menciones y estado de proceso.
-- procesado: 0 pendiente, 1 hecho, 2 en una corrida, 3 carta muerta.
ALTER TABLE mensajes ADD COLUMN canal TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE mensajes ADD COLUMN telefono TEXT;
ALTER TABLE mensajes ADD COLUMN media_url TEXT;
ALTER TABLE mensajes ADD COLUMN media_tipo TEXT;
ALTER TABLE mensajes ADD COLUMN menciona INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mensajes ADD COLUMN responde_al_agente INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mensajes ADD COLUMN corrida_id INTEGER;
ALTER TABLE mensajes ADD COLUMN intentos INTEGER NOT NULL DEFAULT 0;

ALTER TABLE adjuntos ADD COLUMN mime TEXT;
ALTER TABLE adjuntos ADD COLUMN estado TEXT NOT NULL DEFAULT 'pendiente';
ALTER TABLE adjuntos ADD COLUMN creado INTEGER;

-- Sesión de Claude por chat y por variante de instrucciones (el system prompt queda fijo por sesión).
CREATE TABLE sesiones_claude (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  chat_id TEXT NOT NULL,
  clave TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actualizada INTEGER NOT NULL,
  PRIMARY KEY (chat_id, clave)
);

ALTER TABLE corridas ADD COLUMN canal TEXT;
ALTER TABLE corridas ADD COLUMN origen TEXT;
ALTER TABLE corridas ADD COLUMN cliente_id INTEGER;
ALTER TABLE corridas ADD COLUMN herramientas TEXT;
ALTER TABLE corridas ADD COLUMN resultado TEXT;

-- Salida: todo lo que el agente manda pasa por acá (reintentos y ritmo suave).
CREATE TABLE salida (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'texto' CHECK (tipo IN ('texto', 'archivo', 'voz')),
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
  enviado INTEGER
);
CREATE INDEX idx_salida_pendiente ON salida (estado, no_antes_de);

-- Avisos para el Propietario (panel) y consultas abiertas de otros chats.
CREATE TABLE avisos (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL DEFAULT 'aviso' CHECK (tipo IN ('aviso', 'consulta', 'error')),
  texto TEXT NOT NULL,
  chat_origen TEXT,
  persona_origen INTEGER,
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto', 'resuelto')),
  leido INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);

-- Memoria: visibilidad pública (lo que puede ver un Tercero) y fecha.
ALTER TABLE memoria ADD COLUMN publica INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memoria ADD COLUMN creada INTEGER;
CREATE INDEX idx_memoria_alcance ON memoria (alcance, alcance_id);

-- Propuestas (onboarding y "agregá a Juan como…"): confirmación del Propietario.
ALTER TABLE propuestas ADD COLUMN creada INTEGER;
ALTER TABLE propuestas ADD COLUMN decidida_por INTEGER;
ALTER TABLE propuestas ADD COLUMN chat_origen TEXT;
ALTER TABLE propuestas ADD COLUMN persona_origen INTEGER;

-- Aprobaciones: qué ejecutar al aprobar y de dónde vino.
ALTER TABLE aprobaciones ADD COLUMN accion TEXT;
ALTER TABLE aprobaciones ADD COLUMN datos TEXT;
ALTER TABLE aprobaciones ADD COLUMN chat_origen TEXT;
ALTER TABLE aprobaciones ADD COLUMN corrida_id INTEGER;
ALTER TABLE aprobaciones ADD COLUMN creada INTEGER;
ALTER TABLE aprobaciones ADD COLUMN decidida INTEGER;

-- Trabajos en segundo plano.
ALTER TABLE trabajos ADD COLUMN numero INTEGER;
ALTER TABLE trabajos ADD COLUMN cliente_id INTEGER;
ALTER TABLE trabajos ADD COLUMN creado INTEGER;
ALTER TABLE trabajos ADD COLUMN inicio INTEGER;
ALTER TABLE trabajos ADD COLUMN fin INTEGER;

-- Rutinas: destinos aprobados, esfuerzo, estado de aprobación y motivo de pausa.
ALTER TABLE rutinas ADD COLUMN destinos TEXT NOT NULL DEFAULT '[]';
ALTER TABLE rutinas ADD COLUMN esfuerzo TEXT;
ALTER TABLE rutinas ADD COLUMN aprobada INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rutinas ADD COLUMN pausa_motivo TEXT;
ALTER TABLE rutinas ADD COLUMN creada INTEGER;

ALTER TABLE entradas ADD COLUMN creada_por INTEGER;
ALTER TABLE entradas ADD COLUMN creada INTEGER;
ALTER TABLE entradas ADD COLUMN ultima INTEGER;

ALTER TABLE reglas_contacto ADD COLUMN creada INTEGER;

-- Ajustes generales de la instalación (clave/valor).
CREATE TABLE ajustes (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  clave TEXT PRIMARY KEY,
  valor TEXT
);
INSERT INTO ajustes (clave, valor) VALUES
  ('nombre_agente', NULL),
  ('zona_horaria', 'UTC'),
  ('espera_silencio_s', '45'),
  ('espera_maxima_s', '180'),
  ('max_trabajos', '2'),
  ('max_corridas', '3'),
  ('ritmo_suave', '1'),
  ('ritmo_por_hora', '4'),
  ('ritmo_espaciado_min', '5'),
  ('onboarding_hecho', '0'),
  ('instrucciones_extra', NULL);

-- Modelos por tipo de corrida (TEORIA §2.11), con esfuerzo y la lista que el orquestador puede elegir al delegar.
DELETE FROM ajustes_modelo;
INSERT INTO ajustes_modelo (tipo_corrida, modelo, esfuerzo, permitidos) VALUES
  ('orquestador', 'opus', 'medium', NULL),
  ('tercero', 'sonnet', 'low', NULL),
  ('busqueda', 'haiku', 'low', NULL),
  ('trabajo', 'opus', 'medium', '["opus","sonnet","haiku"]'),
  ('rutina', 'sonnet', 'low', '["opus","sonnet","haiku"]'),
  ('respaldo', 'sonnet', NULL, NULL);

-- Equipo de subagentes por defecto.
INSERT INTO equipo (nombre, para_que, modelo, herramientas, activo) VALUES
  ('explorador', 'Busca y lee archivos o código para responder una pregunta concreta. No cambia nada.', 'haiku', '["Read","Glob","Grep"]', 1),
  ('revisor', 'Revisa un cambio o un texto y marca errores, riesgos y omisiones. No cambia nada.', 'sonnet', '["Read","Glob","Grep"]', 1),
  ('investigador', 'Investiga un tema en la web y devuelve un resumen con fuentes.', 'sonnet', '["WebSearch","WebFetch"]', 1);
