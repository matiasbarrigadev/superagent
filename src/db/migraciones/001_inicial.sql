-- Migración inicial: modelo de datos completo de PLAN_MVP.md.
-- Todas las tablas llevan cuenta_id (una instalación = una cuenta en el MVP).

CREATE TABLE cuentas (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  nombre TEXT,
  estado TEXT NOT NULL DEFAULT 'setup' CHECK (estado IN ('setup', 'activa', 'pausada')),
  responder_sin_alta INTEGER NOT NULL DEFAULT 1,
  creada INTEGER NOT NULL
);

CREATE TABLE roles (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  permisos TEXT NOT NULL DEFAULT '[]',
  predefinido INTEGER NOT NULL DEFAULT 0,
  creado_por INTEGER,
  UNIQUE (cuenta_id, nombre)
);

CREATE TABLE personas (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  nombre TEXT,
  telefono TEXT,
  lid TEXT,
  rol_id INTEGER REFERENCES roles(id),
  claude_dir TEXT,
  creada INTEGER NOT NULL
);

CREATE TABLE usuarios_web (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  email TEXT NOT NULL,
  hash_contrasena TEXT NOT NULL,
  totp_secreto TEXT NOT NULL,          -- cifrado (AES-256-GCM)
  totp_ultimo_paso INTEGER NOT NULL DEFAULT 0,
  creado INTEGER NOT NULL,
  UNIQUE (cuenta_id, email)
);

CREATE TABLE codigos_recuperacion (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios_web(id),
  hash TEXT NOT NULL,
  usado_en INTEGER
);

CREATE TABLE sesiones_web (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id TEXT PRIMARY KEY,                 -- sha256 del valor de la cookie
  usuario_id INTEGER NOT NULL REFERENCES usuarios_web(id),
  creada INTEGER NOT NULL,
  vence INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE clientes (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'cliente' CHECK (tipo IN ('propio', 'cliente')),
  autonomia TEXT NOT NULL DEFAULT 'consultar_lo_importante'
    CHECK (autonomia IN ('via_libre', 'consultar_lo_importante', 'consultar_todo')),
  estado TEXT NOT NULL DEFAULT 'activo',
  creado_por INTEGER
);

CREATE TABLE persona_cliente (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  rol_id INTEGER NOT NULL REFERENCES roles(id),
  PRIMARY KEY (persona_id, cliente_id)
);

CREATE TABLE proyectos (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  nombre TEXT NOT NULL,
  repo TEXT,
  procedimiento_publicacion TEXT,
  estado TEXT NOT NULL DEFAULT 'activo'
);

CREATE TABLE credenciales_proyecto (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
  proveedor TEXT NOT NULL,
  alcance TEXT,
  credencial TEXT NOT NULL,            -- cifrada
  creada_por INTEGER,
  rotada INTEGER
);

CREATE TABLE publicaciones (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
  corrida_id INTEGER,
  pedida_por INTEGER,
  aprobacion_id TEXT,
  credenciales_usadas TEXT,
  pasos TEXT,
  resultado TEXT
);

CREATE TABLE sesiones_proyecto (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  proyecto_id INTEGER NOT NULL REFERENCES proyectos(id),
  nombre TEXT NOT NULL,
  session_id_claude TEXT,
  worktree TEXT,
  estado TEXT NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'pausada', 'archivada')),
  ultima_actividad INTEGER
);

CREATE TABLE buzon (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  sesion_id INTEGER NOT NULL REFERENCES sesiones_proyecto(id),
  de TEXT NOT NULL CHECK (de IN ('orquestador', 'sesion')),
  tipo TEXT NOT NULL CHECK (tipo IN ('reenvio', 'consulta', 'respuesta', 'pedido')),
  contenido TEXT NOT NULL,
  persona_origen INTEGER,
  estado TEXT NOT NULL DEFAULT 'pendiente'
);

CREATE TABLE chats (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id TEXT PRIMARY KEY,                 -- JID normalizado
  tipo TEXT NOT NULL CHECK (tipo IN ('directo', 'grupo')),
  persona_id INTEGER REFERENCES personas(id),
  cliente_id INTEGER REFERENCES clientes(id),
  activo INTEGER NOT NULL DEFAULT 1,
  responder_solo_si_mencionan INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE mensajes (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  persona_id INTEGER,
  remitente TEXT,
  nombre_remitente TEXT,
  from_me INTEGER NOT NULL DEFAULT 0,
  tipo TEXT,
  cuerpo TEXT,
  tiene_adjunto INTEGER NOT NULL DEFAULT 0,
  responde_a TEXT,
  ts INTEGER NOT NULL,
  procesado INTEGER NOT NULL DEFAULT 0,
  recibido INTEGER NOT NULL,
  UNIQUE (session, id)
);
CREATE INDEX idx_mensajes_pendientes ON mensajes (procesado, seq);
CREATE INDEX idx_mensajes_chat ON mensajes (chat_id, ts);

CREATE TABLE lids (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  lid TEXT PRIMARY KEY,
  telefono TEXT,
  actualizado INTEGER
);

CREATE TABLE corridas (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('orquestador', 'trabajo', 'rutina')),
  chat_id TEXT,
  persona_id INTEGER,
  persona_origen INTEGER,
  rol TEXT,
  credencial_usada TEXT,
  modelo TEXT,
  esfuerzo TEXT,
  trabajo_id TEXT,
  session_id_claude TEXT,
  estado TEXT NOT NULL,
  inicio INTEGER,
  fin INTEGER,
  error TEXT
);

CREATE TABLE trabajos (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id TEXT PRIMARY KEY,                 -- T-12
  pedido_por INTEGER,
  chat_id TEXT,
  descripcion TEXT NOT NULL,
  modelo TEXT,
  esfuerzo TEXT,
  worktree TEXT,
  estado TEXT NOT NULL DEFAULT 'en_cola' CHECK (estado IN ('en_cola', 'corriendo', 'terminado', 'fallido')),
  resultado TEXT
);

CREATE TABLE rutinas (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  cuando TEXT NOT NULL,
  zona_horaria TEXT NOT NULL,
  instruccion TEXT NOT NULL,
  creada_por INTEGER,
  chat_destino TEXT,
  modelo TEXT,
  activa INTEGER NOT NULL DEFAULT 1,
  proxima INTEGER,
  ultima INTEGER
);

CREATE TABLE equipo (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  nombre TEXT PRIMARY KEY,
  para_que TEXT NOT NULL,
  modelo TEXT,
  herramientas TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE ajustes_modelo (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  tipo_corrida TEXT PRIMARY KEY,
  modelo TEXT NOT NULL,
  esfuerzo TEXT,
  permitidos TEXT
);

CREATE TABLE conexiones (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  app TEXT NOT NULL,
  alcance TEXT NOT NULL DEFAULT 'instalacion' CHECK (alcance IN ('instalacion', 'persona')),
  persona_id INTEGER,
  proveedor TEXT NOT NULL DEFAULT 'directo',
  credencial TEXT,                     -- cifrada
  referencia TEXT,
  permisos TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  conectada_por INTEGER,
  url_mcp TEXT,
  habilitada_para TEXT
);

CREATE TABLE adjuntos (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  mensaje_seq INTEGER NOT NULL REFERENCES mensajes(seq),
  tipo TEXT NOT NULL,
  ruta TEXT,
  tamano INTEGER,
  texto TEXT,
  vence INTEGER
);

CREATE TABLE entradas (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  secreto TEXT NOT NULL,               -- hash
  instruccion TEXT,
  activa INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE reglas_contacto (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  origen TEXT,
  a_quien TEXT,
  mensaje_base TEXT,
  aprobada_por INTEGER,
  activa INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE lecciones (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  regla TEXT NOT NULL,
  porque TEXT,
  como_aplicar TEXT,
  publica INTEGER NOT NULL DEFAULT 0,
  autor INTEGER,
  estado TEXT NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'propuesta', 'desactivada')),
  creada INTEGER NOT NULL
);

CREATE TABLE memoria (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  alcance TEXT NOT NULL CHECK (alcance IN ('cuenta', 'cliente', 'proyecto', 'contacto')),
  alcance_id INTEGER,
  seccion TEXT NOT NULL CHECK (seccion IN ('Contexto', 'Comportamiento', 'Alcance', 'Decisiones', 'Pendientes', 'Historial')),
  contenido TEXT NOT NULL,
  autor INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE instrucciones (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  version INTEGER PRIMARY KEY,
  contenido TEXT NOT NULL,
  pedida_por INTEGER,
  aprobada_por INTEGER,
  activa INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE aprobaciones (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id TEXT PRIMARY KEY,                 -- A-12
  tipo TEXT NOT NULL,
  pedida_por INTEGER,
  detalle TEXT,
  diff TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  decidida_por INTEGER,
  comentario TEXT
);

CREATE TABLE propuestas (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('rol', 'persona')),
  datos TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  propuesta_por TEXT
);

CREATE TABLE auditoria (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT,
  rol TEXT,
  accion TEXT NOT NULL,
  decision_politica TEXT,
  detalle TEXT
);

CREATE TABLE eventos_wa (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  id INTEGER PRIMARY KEY,
  session TEXT,
  estado TEXT,
  ts INTEGER NOT NULL
);

-- Datos iniciales: la cuenta y los tres roles predefinidos (TEORIA §2.5).
INSERT INTO cuentas (id, nombre, estado, creada) VALUES (1, NULL, 'setup', unixepoch() * 1000);
INSERT INTO roles (nombre, descripcion, permisos, predefinido) VALUES
  ('Propietario', 'Dueño de la instalación: todo, incluida la cuenta de Claude y los roles.',
   '["administrar","conversar","trabajar_en_codigo","publicar","cambiar_instrucciones","conectar_apps","conectar_mis_cuentas","usar_web","programar_rutinas","iniciar_conversacion","aprobar"]', 1),
  ('Colaborador', 'Equipo: trabaja con el agente; publicar y cambiar instrucciones pasan por aprobación.',
   '["conversar","trabajar_en_codigo","publicar_con_aprobacion","cambiar_instrucciones_con_aprobacion","conectar_mis_cuentas","usar_web","programar_rutinas_con_aprobacion"]', 1),
  ('Tercero', 'Cualquier otra persona: solo conversa.', '["conversar"]', 1);
INSERT INTO ajustes_modelo (tipo_corrida, modelo, esfuerzo) VALUES
  ('orquestador', 'opus', 'medium'),
  ('tercero', 'sonnet', 'low'),
  ('busqueda', 'haiku', NULL),
  ('trabajo_codigo', 'opus', NULL),
  ('rutina', 'sonnet', NULL),
  ('respaldo', 'sonnet', NULL);
