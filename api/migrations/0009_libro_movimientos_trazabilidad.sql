-- 0009: libro de movimientos estandarizado + trazabilidad de traspasos y motivos de devolución/cambio.
-- ADITIVA: solo agrega columnas, índices y triggers. No borra ni reescribe ninguna fila histórica salvo clasificar
-- (categoria/signo/usuario/origen/destino) usando datos que YA estaban guardados en otras tablas. Lo que nunca se
-- guardó (p. ej. el usuario de un traspaso antiguo) queda en NULL y la interfaz muestra "No registrado".

-- ---------------------------------------------------------------- movimientos_inventario
-- El CHECK original de `tipo` (entrada, venta, ajuste, traspaso_entrada, traspaso_salida) y `cantidad > 0` no se puede
-- ampliar sin reconstruir la tabla. Por eso `tipo` pasa a ser un valor técnico heredado y la clasificación de negocio
-- vive en `categoria` (+ `signo`: +1 entra al stock vendible, -1 sale, 0 no cambia el stock vendible, p. ej. cuarentena).
ALTER TABLE movimientos_inventario ADD COLUMN categoria TEXT;
ALTER TABLE movimientos_inventario ADD COLUMN signo INTEGER;
ALTER TABLE movimientos_inventario ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id);
ALTER TABLE movimientos_inventario ADD COLUMN sucursal_origen_id INTEGER REFERENCES sucursales(id);
ALTER TABLE movimientos_inventario ADD COLUMN sucursal_destino_id INTEGER REFERENCES sucursales(id);
ALTER TABLE movimientos_inventario ADD COLUMN motivo_codigo TEXT;
ALTER TABLE movimientos_inventario ADD COLUMN cantidad_anterior INTEGER;
ALTER TABLE movimientos_inventario ADD COLUMN cantidad_resultante INTEGER;

-- ---------------------------------------------------------------- traspasos: quién hizo cada paso
ALTER TABLE traspasos ADD COLUMN creado_por INTEGER REFERENCES usuarios(id);
ALTER TABLE traspasos ADD COLUMN despachado_por INTEGER REFERENCES usuarios(id);
ALTER TABLE traspasos ADD COLUMN recibido_por INTEGER REFERENCES usuarios(id);
ALTER TABLE traspasos ADD COLUMN cancelado_por INTEGER REFERENCES usuarios(id);

-- ---------------------------------------------------------------- operaciones: motivo estructurado
-- `motivo` (texto) se conserva tal cual. `motivo_codigo` es opcional: las operaciones antiguas quedan sin clasificar.
ALTER TABLE operaciones ADD COLUMN motivo_codigo TEXT;

CREATE TRIGGER operaciones_motivo_codigo_ins BEFORE INSERT ON operaciones
WHEN NEW.motivo_codigo IS NOT NULL AND NEW.motivo_codigo NOT IN
  ('TALLA_INCORRECTA','COLOR_DIFERENTE','MODELO_DIFERENTE','DEFECTO_FABRICA','PRODUCTO_DANADO','ERROR_PEDIDO','CLIENTE_SOLICITO_CAMBIO','OTRO')
BEGIN SELECT RAISE(ABORT, 'Motivo de devolucion o cambio no valido'); END;

-- ---------------------------------------------------------------- clasificación de lo ya registrado
UPDATE movimientos_inventario SET
  categoria = CASE
    WHEN referencia_tipo IN ('devolucion','anulacion','devolucion_danada','cambio')
         AND (SELECT o.tipo FROM operaciones o WHERE o.id = movimientos_inventario.referencia_id) = 'cambio' THEN 'CAMBIO'
    WHEN referencia_tipo = 'cambio' THEN 'CAMBIO'
    WHEN referencia_tipo IN ('devolucion','anulacion','devolucion_danada','venta_cancelada') THEN 'DEVOLUCION'
    WHEN tipo IN ('traspaso_entrada','traspaso_salida') OR referencia_tipo = 'traspaso_cancelado' THEN 'TRASPASO'
    WHEN tipo = 'venta' THEN 'VENTA'
    WHEN tipo = 'entrada' THEN 'INGRESO'
    ELSE 'AJUSTE' END,
  signo = CASE
    WHEN referencia_tipo = 'devolucion_danada' THEN 0
    WHEN tipo IN ('entrada','traspaso_entrada') THEN 1
    WHEN tipo IN ('venta','traspaso_salida') THEN -1
    WHEN tipo = 'ajuste' AND referencia_tipo IN ('venta_cancelada','traspaso_cancelado','anulacion','devolucion') THEN 1
    ELSE NULL END
WHERE categoria IS NULL;

-- Usuario: solo cuando otra tabla lo guardó de verdad (operación, vendedor de la venta, "por usuario N" del ingreso manual).
UPDATE movimientos_inventario SET usuario_id = CASE
  WHEN referencia_tipo IN ('devolucion','anulacion','devolucion_danada','cambio')
    THEN (SELECT o.usuario_id FROM operaciones o WHERE o.id = movimientos_inventario.referencia_id)
  WHEN referencia_tipo = 'venta'
    THEN (SELECT v.vendedor_id FROM ventas v WHERE v.id = movimientos_inventario.referencia_id)
  WHEN referencia_tipo = 'ingreso_manual' AND observaciones GLOB 'por usuario [0-9]*'
    THEN (SELECT u.id FROM usuarios u WHERE u.id = CAST(substr(movimientos_inventario.observaciones, 13) AS INTEGER))
  ELSE NULL END
WHERE usuario_id IS NULL;

-- Origen y destino de los traspasos (dato real del traspaso al que pertenece el movimiento).
UPDATE movimientos_inventario SET
  sucursal_origen_id = (SELECT t.sucursal_origen_id FROM traspasos t WHERE t.id = movimientos_inventario.referencia_id),
  sucursal_destino_id = (SELECT t.sucursal_destino_id FROM traspasos t WHERE t.id = movimientos_inventario.referencia_id)
WHERE referencia_tipo IN ('traspaso','traspaso_cancelado') AND sucursal_origen_id IS NULL;

-- Motivo estructurado: lo heredan los movimientos de operaciones nuevas (las antiguas no tienen código).
UPDATE movimientos_inventario SET motivo_codigo =
  (SELECT o.motivo_codigo FROM operaciones o WHERE o.id = movimientos_inventario.referencia_id)
WHERE referencia_tipo IN ('devolucion','anulacion','devolucion_danada','cambio') AND motivo_codigo IS NULL;

-- ---------------------------------------------------------------- índices para filtros y reportes
CREATE INDEX idx_mov_categoria_fecha ON movimientos_inventario(categoria, created_at);
CREATE INDEX idx_mov_sucursal_fecha ON movimientos_inventario(sucursal_id, created_at);
CREATE INDEX idx_mov_variante ON movimientos_inventario(producto_id, talla_id, color_id);
CREATE INDEX idx_mov_usuario ON movimientos_inventario(usuario_id);
CREATE INDEX idx_traspaso_detalles_variante ON traspaso_detalles(producto_id, talla_id, color_id);
CREATE INDEX idx_traspasos_fecha ON traspasos(fecha);
CREATE INDEX idx_operaciones_tipo_fecha ON operaciones(tipo, created_at);
CREATE INDEX idx_operaciones_sucursal ON operaciones(sucursal_id, created_at);
CREATE INDEX idx_detalle_venta_variante ON detalle_venta(producto_id, talla_id, color_id);
CREATE INDEX idx_ventas_estado_fecha ON ventas(estado, fecha);

-- ---------------------------------------------------------------- reglas del libro
CREATE TRIGGER mov_validar_ins BEFORE INSERT ON movimientos_inventario
WHEN (NEW.categoria IS NOT NULL AND NEW.categoria NOT IN ('INGRESO','VENTA','CAMBIO','DEVOLUCION','SALIDA','TRASPASO','AJUSTE'))
  OR (NEW.signo IS NOT NULL AND NEW.signo NOT IN (-1, 0, 1))
BEGIN SELECT RAISE(ABORT, 'Movimiento de inventario no valido (categoria o signo)'); END;

-- Un movimiento insertado sin categoría (p. ej. por un script antiguo) se clasifica con las mismas reglas de arriba.
CREATE TRIGGER mov_clasificar_defecto AFTER INSERT ON movimientos_inventario
WHEN NEW.categoria IS NULL
BEGIN
  UPDATE movimientos_inventario SET
    categoria = CASE
      WHEN NEW.referencia_tipo IN ('devolucion','anulacion','devolucion_danada','cambio')
           AND (SELECT o.tipo FROM operaciones o WHERE o.id = NEW.referencia_id) = 'cambio' THEN 'CAMBIO'
      WHEN NEW.referencia_tipo = 'cambio' THEN 'CAMBIO'
      WHEN NEW.referencia_tipo IN ('devolucion','anulacion','devolucion_danada','venta_cancelada') THEN 'DEVOLUCION'
      WHEN NEW.tipo IN ('traspaso_entrada','traspaso_salida') OR NEW.referencia_tipo = 'traspaso_cancelado' THEN 'TRASPASO'
      WHEN NEW.tipo = 'venta' THEN 'VENTA'
      WHEN NEW.tipo = 'entrada' THEN 'INGRESO'
      ELSE 'AJUSTE' END,
    signo = COALESCE(NEW.signo, CASE
      WHEN NEW.referencia_tipo = 'devolucion_danada' THEN 0
      WHEN NEW.tipo IN ('entrada','traspaso_entrada') THEN 1
      WHEN NEW.tipo IN ('venta','traspaso_salida') THEN -1
      ELSE NULL END)
  WHERE id = NEW.id;
END;

-- El historial es inmutable: solo se permite clasificar (categoria/signo) un movimiento que nunca la tuvo.
-- Las correcciones se hacen con un movimiento compensatorio (AJUSTE), nunca editando el original.
CREATE TRIGGER mov_inmutable_upd BEFORE UPDATE ON movimientos_inventario
WHEN NOT (OLD.categoria IS NULL AND NEW.categoria IS NOT NULL
          AND OLD.id = NEW.id AND OLD.sucursal_id = NEW.sucursal_id AND OLD.producto_id = NEW.producto_id
          AND OLD.talla_id = NEW.talla_id AND OLD.color_id = NEW.color_id AND OLD.tipo = NEW.tipo
          AND OLD.cantidad = NEW.cantidad AND OLD.referencia_tipo IS NEW.referencia_tipo
          AND OLD.referencia_id IS NEW.referencia_id AND OLD.observaciones IS NEW.observaciones
          AND OLD.created_at = NEW.created_at AND OLD.usuario_id IS NEW.usuario_id)
BEGIN SELECT RAISE(ABORT, 'El historial de movimientos no se puede modificar'); END;

CREATE TRIGGER mov_inmutable_del BEFORE DELETE ON movimientos_inventario
BEGIN SELECT RAISE(ABORT, 'El historial de movimientos no se puede borrar'); END;

CREATE TRIGGER auditoria_inmutable_upd BEFORE UPDATE ON auditoria
BEGIN SELECT RAISE(ABORT, 'La auditoria no se puede modificar'); END;

CREATE TRIGGER auditoria_inmutable_del BEFORE DELETE ON auditoria
BEGIN SELECT RAISE(ABORT, 'La auditoria no se puede borrar'); END;

-- Detalle de ventas: los precios y cantidades vendidos no se reescriben (el precio histórico es permanente).
CREATE TRIGGER detalle_venta_historico_upd BEFORE UPDATE ON detalle_venta
WHEN OLD.cantidad <> NEW.cantidad OR OLD.precio_unitario <> NEW.precio_unitario OR OLD.subtotal <> NEW.subtotal
  OR OLD.producto_id <> NEW.producto_id OR OLD.talla_id <> NEW.talla_id OR OLD.color_id <> NEW.color_id OR OLD.venta_id <> NEW.venta_id
BEGIN SELECT RAISE(ABORT, 'El detalle de una venta registrada no se puede modificar'); END;

CREATE TRIGGER detalle_venta_historico_del BEFORE DELETE ON detalle_venta
BEGIN SELECT RAISE(ABORT, 'El detalle de una venta registrada no se puede borrar'); END;

-- Devoluciones/cambios: el registro no se edita ni se borra (solo puede avanzar el estado del pago).
CREATE TRIGGER operaciones_inmutable_upd BEFORE UPDATE ON operaciones
WHEN OLD.tipo <> NEW.tipo OR OLD.venta_id <> NEW.venta_id OR OLD.sucursal_id <> NEW.sucursal_id OR OLD.usuario_id <> NEW.usuario_id
  OR OLD.motivo <> NEW.motivo OR OLD.motivo_codigo IS NOT NEW.motivo_codigo OR OLD.valor_devuelto <> NEW.valor_devuelto
  OR OLD.valor_entregado <> NEW.valor_entregado OR OLD.created_at <> NEW.created_at
BEGIN SELECT RAISE(ABORT, 'El registro de una devolucion o cambio no se puede modificar'); END;

CREATE TRIGGER operaciones_inmutable_del BEFORE DELETE ON operaciones
BEGIN SELECT RAISE(ABORT, 'El registro de una devolucion o cambio no se puede borrar'); END;

CREATE TRIGGER operacion_items_inmutable_upd BEFORE UPDATE ON operacion_items
BEGIN SELECT RAISE(ABORT, 'Las lineas de una devolucion o cambio no se pueden modificar'); END;

CREATE TRIGGER operacion_items_inmutable_del BEFORE DELETE ON operacion_items
BEGIN SELECT RAISE(ABORT, 'Las lineas de una devolucion o cambio no se pueden borrar'); END;

-- Líneas de traspaso: fijas una vez creadas (el traspaso solo cambia de estado).
CREATE TRIGGER traspaso_detalles_inmutable_upd BEFORE UPDATE ON traspaso_detalles
BEGIN SELECT RAISE(ABORT, 'Las lineas de un traspaso no se pueden modificar'); END;

CREATE TRIGGER traspaso_detalles_inmutable_del BEFORE DELETE ON traspaso_detalles
BEGIN SELECT RAISE(ABORT, 'Las lineas de un traspaso no se pueden borrar'); END;
