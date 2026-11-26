-- Un usuario de Linux por conversación y por trabajo (aislamiento entre corridas).
CREATE TABLE usuarios_so (
  cuenta_id INTEGER NOT NULL DEFAULT 1,
  clave TEXT PRIMARY KEY,
  uid INTEGER NOT NULL UNIQUE,
  creado INTEGER NOT NULL
);
