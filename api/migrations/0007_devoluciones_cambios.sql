-- 0007: devoluciones, cambios y anulaciones. ADITIVA: no modifica ni borra ventas, detalles, stock ni movimientos.
-- La venta original nunca se edita por una devolución; cada operación queda enlazada a ella.

CREATE TABLE operaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('devolucion', 'cambio', 'anulacion')),
  venta_id INTEGER NOT NULL REFERENCES ventas(id),
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  motivo TEXT NOT NULL CHECK (length(trim(motivo)) > 0),
  valor_devuelto REAL NOT NULL DEFAULT 0 CHECK (valor_devuelto >= 0),
  valor_entregado REAL NOT NULL DEFAULT 0 CHECK (valor_entregado >= 0),
  -- diferencia = valor_entregado - valor_devuelto: > 0 el cliente paga; < 0 se le debe; 0 sin pago
  diferencia REAL NOT NULL DEFAULT 0,
  pago_tipo TEXT NOT NULL DEFAULT 'ninguno' CHECK (pago_tipo IN ('ninguno', 'cobro', 'reembolso', 'credito')),
  pago_estado TEXT NOT NULL DEFAULT 'no_aplica' CHECK (pago_estado IN ('no_aplica', 'completado', 'pendiente')),
  pago_metodo TEXT CHECK (pago_metodo IS NULL OR pago_metodo IN ('qr', 'efectivo')),
  monto_pago REAL NOT NULL DEFAULT 0 CHECK (monto_pago >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- un pago completado siempre indica con qué método se movió el dinero
  CHECK (pago_estado <> 'completado' OR pago_tipo = 'ninguno' OR pago_metodo IS NOT NULL),
  -- un crédito nunca se marca como dinero entregado
  CHECK (pago_tipo <> 'credito' OR pago_estado <> 'completado')
);
CREATE INDEX idx_operaciones_venta ON operaciones(venta_id);
CREATE INDEX idx_operaciones_fecha ON operaciones(created_at);

CREATE TABLE operacion_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id INTEGER NOT NULL REFERENCES operaciones(id),
  rol TEXT NOT NULL CHECK (rol IN ('devuelto', 'entregado')),
  detalle_venta_id INTEGER REFERENCES detalle_venta(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  talla_id INTEGER NOT NULL REFERENCES tallas(id),
  color_id INTEGER NOT NULL REFERENCES colores(id),
  cantidad INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario REAL NOT NULL CHECK (precio_unitario >= 0),
  condicion TEXT CHECK (condicion IS NULL OR condicion IN ('vendible', 'danado')),
  CHECK (rol <> 'devuelto' OR (detalle_venta_id IS NOT NULL AND condicion IS NOT NULL)),
  CHECK (rol <> 'entregado' OR (detalle_venta_id IS NULL AND condicion IS NULL))
);
CREATE INDEX idx_operacion_items_operacion ON operacion_items(operacion_id);
CREATE INDEX idx_operacion_items_detalle ON operacion_items(detalle_venta_id);

-- Prendas devueltas en mal estado: fuera del stock vendible, trazables por sucursal y variante.
CREATE TABLE inventario_danado (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  talla_id INTEGER NOT NULL REFERENCES tallas(id),
  color_id INTEGER NOT NULL REFERENCES colores(id),
  cantidad INTEGER NOT NULL DEFAULT 0 CHECK (cantidad >= 0),
  UNIQUE (sucursal_id, producto_id, talla_id, color_id)
);

-- Aserción atómica: una fila con ok <> 1 hace fallar (y revertir) el lote completo de la operación.
CREATE TABLE operacion_validacion (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

-- Búsqueda de ventas por cliente, producto y destino.
CREATE INDEX idx_ventas_cliente ON ventas(cliente_nombre);
CREATE INDEX idx_ventas_telefono ON ventas(cliente_telefono);
CREATE INDEX idx_detalle_venta_producto ON detalle_venta(producto_id);
