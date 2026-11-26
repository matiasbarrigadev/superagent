-- Solo el primer Propietario verifica su número: los que ya sumó (con número) quedan verificados si hay al menos
-- un Propietario verificado que los avale.
UPDATE personas SET verificada = 1
WHERE activa = 1 AND alta_manual = 1 AND telefono IS NOT NULL
  AND rol_id = (SELECT id FROM roles WHERE nombre = 'Propietario' AND predefinido = 1)
  AND EXISTS (SELECT 1 FROM personas p2 WHERE p2.verificada = 1 AND p2.activa = 1
    AND p2.rol_id = (SELECT id FROM roles WHERE nombre = 'Propietario' AND predefinido = 1));

-- Una rutina aprobada puede correr con los permisos del Propietario que la aprobó (por ejemplo, un reporte que
-- necesita un conector que el rol de quien la pidió no tiene).
ALTER TABLE rutinas ADD COLUMN ejecuta_como INTEGER;
