-- 0012: almacén central MISSI BOLIVIA, recepciones de mercadería y lotes con trazabilidad.
-- ADITIVA: agrega columnas, tablas, índices y reglas. No borra, no reescribe ni recalcula ninguna fila existente de
-- inventario, ventas, traspasos ni movimientos. El stock de cada ubicación sigue en `inventario` (fuente de verdad);
-- los lotes lo desglosan y SIEMPRE suman exactamente lo mismo (lo garantizan las reglas de abajo).
--
-- Rollback: las tablas nuevas pueden ignorarse sin afectar a nada existente; restaurar la copia de la base tomada antes.

-- ---------------------------------------------------------------- ubicaciones: tienda o almacén
ALTER TABLE sucursales ADD COLUMN tipo TEXT NOT NULL DEFAULT 'tienda' CHECK (tipo IN ('tienda', 'almacen'));

-- MISSI BOLIVIA: almacén central de la organización MISSI BOLIVIA (ubicación física con su propio stock).
-- No cambia Cochabamba ni Santa Cruz. Solo se crea si no existe ya un almacén.
INSERT INTO sucursales (nombre, activa, codigo, es_central, organizacion_id, tipo)
SELECT 'MISSI BOLIVIA', 1, 'MBO', 0, (SELECT id FROM organizaciones WHERE codigo = 'MISSI-BO'), 'almacen'
 WHERE EXISTS (SELECT 1 FROM organizaciones WHERE codigo = 'MISSI-BO')
   AND NOT EXISTS (SELECT 1 FROM sucursales WHERE tipo = 'almacen' OR codigo = 'MBO' OR nombre = 'MISSI BOLIVIA');

-- Un solo almacén central por organización.
CREATE UNIQUE INDEX idx_sucursales_un_almacen ON sucursales(organizacion_id) WHERE tipo = 'almacen';

-- ---------------------------------------------------------------- recepciones (ingreso de mercadería, una o muchas prendas)
CREATE TABLE recepciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  -- Fecha y hora REAL de llegada de la mercadería (UTC, 'AAAA-MM-DD HH:MM:SS'). created_at es cuándo se registró.
  fecha_recepcion TEXT NOT NULL,
  proveedor TEXT,
  referencia TEXT,
  notas TEXT,
  total_unidades INTEGER NOT NULL DEFAULT 0 CHECK (total_unidades >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  creado_por INTEGER NOT NULL REFERENCES usuarios(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_recepciones_sucursal_fecha ON recepciones(sucursal_id, fecha_recepcion);

-- ---------------------------------------------------------------- lotes (por ubicación)
-- Un lote es mercadería de una misma talla y color que llegó junta. Si el mismo modelo/talla/color llega otro día, es
-- otro lote. Al traspasarse, el lote de destino es "hijo" del de origen: conserva la fecha de recepción original y el
-- mismo código de lote (el de la raíz), así se sigue su historia en todas las ubicaciones.
CREATE TABLE lotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  talla_id INTEGER NOT NULL REFERENCES tallas(id),
  color_id INTEGER NOT NULL REFERENCES colores(id),
  -- NULL = es el lote original (raíz). El código visible del lote es L-<id de la raíz>.
  lote_raiz_id INTEGER REFERENCES lotes(id),
  -- Lote del que vino por traspaso (NULL si no vino de un traspaso).
  lote_origen_id INTEGER REFERENCES lotes(id),
  origen TEXT NOT NULL CHECK (origen IN ('recepcion', 'ingreso', 'saldo_inicial', 'conciliacion', 'devolucion', 'ajuste', 'traspaso')),
  cantidad_inicial INTEGER NOT NULL CHECK (cantidad_inicial > 0),
  cantidad_restante INTEGER NOT NULL CHECK (cantidad_restante >= 0 AND cantidad_restante <= cantidad_inicial),
  -- Llegada a la empresa (UTC). NULL = desconocida (stock anterior a los lotes; NUNCA se inventa).
  fecha_recepcion TEXT,
  -- Llegada a ESTA ubicación (UTC). NULL = desconocida.
  fecha_llegada TEXT,
  recepcion_id INTEGER REFERENCES recepciones(id),
  traspaso_id INTEGER REFERENCES traspasos(id),
  proveedor TEXT,
  referencia TEXT,
  notas TEXT,
  creado_por INTEGER REFERENCES usuarios(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_lotes_variante ON lotes(sucursal_id, producto_id, talla_id, color_id, cantidad_restante);
CREATE INDEX idx_lotes_raiz ON lotes(lote_raiz_id);
CREATE INDEX idx_lotes_fecha ON lotes(fecha_recepcion);
CREATE INDEX idx_lotes_traspaso ON lotes(traspaso_id);
CREATE INDEX idx_lotes_recepcion ON lotes(recepcion_id);

-- ---------------------------------------------------------------- entradas y salidas de cada lote
CREATE TABLE lote_movimientos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lote_id INTEGER NOT NULL REFERENCES lotes(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'salida')),
  cantidad INTEGER NOT NULL CHECK (cantidad > 0),
  -- recepcion, ingreso_manual, saldo_inicial, conciliacion, venta, cambio, salida_manual, ajuste_manual,
  -- devolucion, anulacion, traspaso, traspaso_cancelado
  referencia_tipo TEXT NOT NULL,
  referencia_id INTEGER,
  detalle_venta_id INTEGER REFERENCES detalle_venta(id),
  traspaso_id INTEGER REFERENCES traspasos(id),
  movimiento_id INTEGER REFERENCES movimientos_inventario(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  -- Identificador del grupo de sentencias que lo creó (enlaza el asiento del libro dentro del mismo lote de D1).
  grupo TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_lote_mov_lote ON lote_movimientos(lote_id, tipo);
CREATE INDEX idx_lote_mov_grupo ON lote_movimientos(grupo);
CREATE INDEX idx_lote_mov_detalle ON lote_movimientos(detalle_venta_id);
CREATE INDEX idx_lote_mov_traspaso ON lote_movimientos(traspaso_id);
CREATE INDEX idx_lote_mov_movimiento ON lote_movimientos(movimiento_id);
CREATE INDEX idx_lote_mov_ref ON lote_movimientos(referencia_tipo, referencia_id);

-- ---------------------------------------------------------------- stock existente: un lote "saldo inicial" por variante
-- La fecha real de llegada de este stock no se conoce: fecha_recepcion y fecha_llegada quedan en NULL (desconocida).
-- created_at registra cuándo se activó el control por lotes.
INSERT INTO lotes (sucursal_id, producto_id, talla_id, color_id, origen, cantidad_inicial, cantidad_restante, fecha_recepcion, fecha_llegada, notas)
SELECT i.sucursal_id, i.producto_id, i.talla_id, i.color_id, 'saldo_inicial', i.cantidad, i.cantidad, NULL, NULL,
       'Stock existente al activar los lotes: fecha de ingreso real desconocida.'
  FROM inventario i
 WHERE i.cantidad > 0
 ORDER BY i.id;

INSERT INTO lote_movimientos (lote_id, tipo, cantidad, referencia_tipo)
SELECT id, 'entrada', cantidad_inicial, 'saldo_inicial' FROM lotes WHERE origen = 'saldo_inicial';

-- ---------------------------------------------------------------- reglas: lotes = stock, siempre
-- Las rutas de la API cambian primero los lotes y después `inventario`, así que al llegar aquí ya coinciden y estas
-- reglas no hacen nada. Solo actúan ante escrituras directas a `inventario` (scripts, importaciones):
--  * si el stock SUBE sin lote, se crea un lote "conciliación" con fecha desconocida por la diferencia;
--  * si el stock BAJA sin descontar lotes, se rechaza (el stock y sus lotes nunca pueden quedar distintos).
CREATE TRIGGER inventario_lotes_alta_ins AFTER INSERT ON inventario
WHEN NEW.cantidad > (SELECT COALESCE(SUM(l.cantidad_restante), 0) FROM lotes l
                      WHERE l.sucursal_id = NEW.sucursal_id AND l.producto_id = NEW.producto_id
                        AND l.talla_id = NEW.talla_id AND l.color_id = NEW.color_id)
BEGIN
  INSERT INTO lotes (sucursal_id, producto_id, talla_id, color_id, origen, cantidad_inicial, cantidad_restante, notas)
  SELECT NEW.sucursal_id, NEW.producto_id, NEW.talla_id, NEW.color_id, 'conciliacion', d, d,
         'Stock registrado sin lote: fecha de ingreso real desconocida.'
    FROM (SELECT NEW.cantidad - (SELECT COALESCE(SUM(l.cantidad_restante), 0) FROM lotes l
                                  WHERE l.sucursal_id = NEW.sucursal_id AND l.producto_id = NEW.producto_id
                                    AND l.talla_id = NEW.talla_id AND l.color_id = NEW.color_id) AS d);
  INSERT INTO lote_movimientos (lote_id, tipo, cantidad, referencia_tipo)
  SELECT id, 'entrada', cantidad_inicial, 'conciliacion' FROM lotes WHERE id = last_insert_rowid();
END;

CREATE TRIGGER inventario_lotes_alta_upd AFTER UPDATE OF cantidad ON inventario
WHEN NEW.cantidad > (SELECT COALESCE(SUM(l.cantidad_restante), 0) FROM lotes l
                      WHERE l.sucursal_id = NEW.sucursal_id AND l.producto_id = NEW.producto_id
                        AND l.talla_id = NEW.talla_id AND l.color_id = NEW.color_id)
BEGIN
  INSERT INTO lotes (sucursal_id, producto_id, talla_id, color_id, origen, cantidad_inicial, cantidad_restante, notas)
  SELECT NEW.sucursal_id, NEW.producto_id, NEW.talla_id, NEW.color_id, 'conciliacion', d, d,
         'Stock registrado sin lote: fecha de ingreso real desconocida.'
    FROM (SELECT NEW.cantidad - (SELECT COALESCE(SUM(l.cantidad_restante), 0) FROM lotes l
                                  WHERE l.sucursal_id = NEW.sucursal_id AND l.producto_id = NEW.producto_id
                                    AND l.talla_id = NEW.talla_id AND l.color_id = NEW.color_id) AS d);
  INSERT INTO lote_movimientos (lote_id, tipo, cantidad, referencia_tipo)
  SELECT id, 'entrada', cantidad_inicial, 'conciliacion' FROM lotes WHERE id = last_insert_rowid();
END;

CREATE TRIGGER inventario_lotes_baja_upd AFTER UPDATE OF cantidad ON inventario
WHEN NEW.cantidad < (SELECT COALESCE(SUM(l.cantidad_restante), 0) FROM lotes l
                      WHERE l.sucursal_id = NEW.sucursal_id AND l.producto_id = NEW.producto_id
                        AND l.talla_id = NEW.talla_id AND l.color_id = NEW.color_id)
BEGIN SELECT RAISE(ABORT, 'El stock no puede bajar sin descontar sus lotes'); END;

CREATE TRIGGER inventario_sin_borrado BEFORE DELETE ON inventario
WHEN OLD.cantidad > 0
BEGIN SELECT RAISE(ABORT, 'No se puede borrar una fila de inventario con stock'); END;

-- ---------------------------------------------------------------- historial inmutable
-- Un lote solo cambia su cantidad restante (por ventas, traspasos, salidas o devoluciones); el resto es permanente.
CREATE TRIGGER lotes_inmutable_upd BEFORE UPDATE ON lotes
WHEN OLD.id <> NEW.id OR OLD.sucursal_id <> NEW.sucursal_id OR OLD.producto_id <> NEW.producto_id
  OR OLD.talla_id <> NEW.talla_id OR OLD.color_id <> NEW.color_id OR OLD.lote_raiz_id IS NOT NEW.lote_raiz_id
  OR OLD.lote_origen_id IS NOT NEW.lote_origen_id OR OLD.origen <> NEW.origen OR OLD.cantidad_inicial <> NEW.cantidad_inicial
  OR OLD.fecha_recepcion IS NOT NEW.fecha_recepcion OR OLD.fecha_llegada IS NOT NEW.fecha_llegada
  OR OLD.recepcion_id IS NOT NEW.recepcion_id OR OLD.traspaso_id IS NOT NEW.traspaso_id
  OR OLD.created_at <> NEW.created_at
BEGIN SELECT RAISE(ABORT, 'Los datos de un lote no se pueden modificar'); END;

CREATE TRIGGER lotes_sin_borrado BEFORE DELETE ON lotes
BEGIN SELECT RAISE(ABORT, 'Un lote no se puede borrar'); END;

-- Solo se permite enlazar una vez el asiento del libro (movimiento_id de NULL a un valor).
CREATE TRIGGER lote_movimientos_inmutable_upd BEFORE UPDATE ON lote_movimientos
WHEN OLD.lote_id <> NEW.lote_id OR OLD.tipo <> NEW.tipo OR OLD.cantidad <> NEW.cantidad
  OR OLD.referencia_tipo <> NEW.referencia_tipo OR OLD.referencia_id IS NOT NEW.referencia_id
  OR OLD.detalle_venta_id IS NOT NEW.detalle_venta_id OR OLD.traspaso_id IS NOT NEW.traspaso_id
  OR OLD.created_at <> NEW.created_at OR OLD.grupo IS NOT NEW.grupo
  OR (OLD.movimiento_id IS NOT NULL AND OLD.movimiento_id IS NOT NEW.movimiento_id)
BEGIN SELECT RAISE(ABORT, 'El historial de un lote no se puede modificar'); END;

CREATE TRIGGER lote_movimientos_sin_borrado BEFORE DELETE ON lote_movimientos
BEGIN SELECT RAISE(ABORT, 'El historial de un lote no se puede borrar'); END;

-- Recepciones: el encabezado no se edita ni se borra (solo se completa el total de unidades al registrarla).
CREATE TRIGGER recepciones_inmutable_upd BEFORE UPDATE ON recepciones
WHEN OLD.sucursal_id <> NEW.sucursal_id OR OLD.fecha_recepcion <> NEW.fecha_recepcion OR OLD.proveedor IS NOT NEW.proveedor
  OR OLD.referencia IS NOT NEW.referencia OR OLD.notas IS NOT NEW.notas OR OLD.idempotency_key <> NEW.idempotency_key
  OR OLD.creado_por <> NEW.creado_por OR OLD.created_at <> NEW.created_at
BEGIN SELECT RAISE(ABORT, 'Una recepcion registrada no se puede modificar'); END;

CREATE TRIGGER recepciones_sin_borrado BEFORE DELETE ON recepciones
BEGIN SELECT RAISE(ABORT, 'Una recepcion registrada no se puede borrar'); END;
