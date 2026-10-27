-- 0010: MISSI BOLIVIA como organización matriz. ADITIVA: no borra ni reescribe datos de ventas, stock ni movimientos.
--
-- * `organizaciones` es la matriz. Cada sucursal (MISSI Cochabamba, MISSI Santa Cruz y las futuras) pertenece a una organización.
-- * Ventas, movimientos, traspasos y devoluciones ya llevan `sucursal_id`; su organización se obtiene por esa sucursal
--   (no se duplica una segunda columna en cada tabla, así no puede haber una inconsistencia entre ambas).
-- * El stock nacional NO se guarda: siempre se calcula sumando el stock de las sucursales de la organización.
-- * Los usuarios pertenecen a una organización: un administrador ve todas las sucursales de la suya; un vendedor, solo la suya.

CREATE TABLE organizaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL UNIQUE,
  activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO organizaciones (codigo, nombre) VALUES ('MISSI-BO', 'MISSI BOLIVIA');

ALTER TABLE sucursales ADD COLUMN organizacion_id INTEGER REFERENCES organizaciones(id);
UPDATE sucursales SET organizacion_id = (SELECT id FROM organizaciones WHERE codigo = 'MISSI-BO') WHERE organizacion_id IS NULL;
CREATE INDEX idx_sucursales_organizacion ON sucursales(organizacion_id);

ALTER TABLE usuarios ADD COLUMN organizacion_id INTEGER REFERENCES organizaciones(id);
UPDATE usuarios SET organizacion_id = COALESCE(
  (SELECT s.organizacion_id FROM sucursales s WHERE s.id = usuarios.sucursal_id),
  (SELECT id FROM organizaciones WHERE codigo = 'MISSI-BO'))
WHERE organizacion_id IS NULL;
CREATE INDEX idx_usuarios_organizacion ON usuarios(organizacion_id);

-- Una sucursal nueva debe indicar su organización (no puede quedar suelta).
CREATE TRIGGER sucursales_organizacion_obligatoria BEFORE INSERT ON sucursales
WHEN NEW.organizacion_id IS NULL
BEGIN SELECT RAISE(ABORT, 'La sucursal debe pertenecer a una organizacion'); END;

-- Un usuario nuevo sin organización hereda la de su sucursal (o la única organización, si es administrador).
CREATE TRIGGER usuarios_organizacion_defecto AFTER INSERT ON usuarios
WHEN NEW.organizacion_id IS NULL
BEGIN
  UPDATE usuarios SET organizacion_id = COALESCE(
    (SELECT s.organizacion_id FROM sucursales s WHERE s.id = NEW.sucursal_id),
    (SELECT id FROM organizaciones WHERE activa = 1 ORDER BY id LIMIT 1))
  WHERE id = NEW.id;
END;

-- La organización de un vendedor debe coincidir con la de su sucursal (evita accesos cruzados entre organizaciones).
CREATE TRIGGER usuarios_organizacion_coherente_ins BEFORE INSERT ON usuarios
WHEN NEW.sucursal_id IS NOT NULL AND NEW.organizacion_id IS NOT NULL
 AND (SELECT s.organizacion_id FROM sucursales s WHERE s.id = NEW.sucursal_id) <> NEW.organizacion_id
BEGIN SELECT RAISE(ABORT, 'La sucursal del usuario pertenece a otra organizacion'); END;

CREATE TRIGGER usuarios_organizacion_coherente_upd BEFORE UPDATE OF sucursal_id, organizacion_id ON usuarios
WHEN NEW.sucursal_id IS NOT NULL AND NEW.organizacion_id IS NOT NULL
 AND (SELECT s.organizacion_id FROM sucursales s WHERE s.id = NEW.sucursal_id) <> NEW.organizacion_id
BEGIN SELECT RAISE(ABORT, 'La sucursal del usuario pertenece a otra organizacion'); END;
