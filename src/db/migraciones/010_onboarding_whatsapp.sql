-- Onboarding por WhatsApp: el Propietario carga su número antes de vincular; al vincular, el agente le escribe y
-- él confirma respondiendo con el código que ve en el panel (modo "respuesta").
ALTER TABLE verificaciones ADD COLUMN modo TEXT NOT NULL DEFAULT 'codigo';
ALTER TABLE verificaciones ADD COLUMN saludado INTEGER NOT NULL DEFAULT 0;

-- Un WhatsApp que ya tiene historia no le responde a cualquiera hasta que el Propietario lo decida en la
-- configuración inicial. Las instalaciones ya configuradas no cambian.
UPDATE cuentas SET responder_sin_alta = 0
  WHERE NOT EXISTS (SELECT 1 FROM ajustes WHERE clave = 'onboarding_hecho' AND valor = '1');
