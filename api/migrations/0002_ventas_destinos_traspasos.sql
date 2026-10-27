-- 0002: columnas y reglas que faltan para ventas, destinos y traspasos.
-- Estrategia: ADD COLUMN + triggers + indices (sin reconstruir tablas), segura aunque ya existan datos.

-- ---- ventas ----
ALTER TABLE ventas ADD COLUMN cliente_nombre TEXT;
ALTER TABLE ventas ADD COLUMN cliente_telefono TEXT;
ALTER TABLE ventas ADD COLUMN destino_id INTEGER REFERENCES destinos_entrega(id);
ALTER TABLE ventas ADD COLUMN idempotency_key TEXT;
ALTER TABLE ventas ADD COLUMN motivo_cancelacion TEXT;
ALTER TABLE ventas ADD COLUMN cancelada_at TEXT;
ALTER TABLE ventas ADD COLUMN op_token TEXT;

CREATE UNIQUE INDEX idx_ventas_idempotency ON ventas(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_ventas_sucursal_fecha ON ventas(sucursal_id, fecha);
CREATE INDEX idx_ventas_estado ON ventas(estado);

CREATE TRIGGER ventas_validar_estado_ins BEFORE INSERT ON ventas
WHEN NEW.estado NOT IN ('completada', 'cancelada')
BEGIN SELECT RAISE(ABORT, 'Estado de venta no valido'); END;

CREATE TRIGGER ventas_validar_estado_upd BEFORE UPDATE OF estado ON ventas
WHEN NEW.estado NOT IN ('completada', 'cancelada')
BEGIN SELECT RAISE(ABORT, 'Estado de venta no valido'); END;

CREATE TRIGGER ventas_validar_entrega_ins BEFORE INSERT ON ventas
WHEN NEW.tipo_entrega IS NOT NULL AND NEW.tipo_entrega NOT IN ('directa', 'interdepartamental', 'interprovincial')
BEGIN SELECT RAISE(ABORT, 'Tipo de entrega no valido'); END;

CREATE TRIGGER ventas_validar_entrega_upd BEFORE UPDATE OF tipo_entrega ON ventas
WHEN NEW.tipo_entrega IS NOT NULL AND NEW.tipo_entrega NOT IN ('directa', 'interdepartamental', 'interprovincial')
BEGIN SELECT RAISE(ABORT, 'Tipo de entrega no valido'); END;

-- ---- detalle_venta ----
CREATE INDEX idx_detalle_venta_venta ON detalle_venta(venta_id);

CREATE TRIGGER detalle_venta_validar BEFORE INSERT ON detalle_venta
WHEN NEW.cantidad <= 0 OR NEW.precio_unitario < 0 OR NEW.subtotal < 0
BEGIN SELECT RAISE(ABORT, 'Detalle de venta no valido (cantidad > 0, precio >= 0)'); END;

-- ---- destinos_entrega ----
-- envio nacional (interdepartamental): departamento_id (lista de 9) + ciudad + direccion (+ referencia)
-- interprovincial: departamento_manual + provincia + municipio + direccion + agencia_transporte (+ referencia)
ALTER TABLE destinos_entrega ADD COLUMN ciudad TEXT;
ALTER TABLE destinos_entrega ADD COLUMN departamento_manual TEXT;
ALTER TABLE destinos_entrega ADD COLUMN provincia TEXT;
ALTER TABLE destinos_entrega ADD COLUMN municipio TEXT;
ALTER TABLE destinos_entrega ADD COLUMN agencia_transporte TEXT;

-- ---- traspasos ----
ALTER TABLE traspasos ADD COLUMN responsable TEXT NOT NULL DEFAULT '';
ALTER TABLE traspasos ADD COLUMN enviado_at TEXT;
ALTER TABLE traspasos ADD COLUMN recibido_at TEXT;
ALTER TABLE traspasos ADD COLUMN cancelado_at TEXT;
ALTER TABLE traspasos ADD COLUMN idempotency_key TEXT;
ALTER TABLE traspasos ADD COLUMN op_token TEXT;

CREATE UNIQUE INDEX idx_traspasos_idempotency ON traspasos(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_traspasos_estado ON traspasos(estado);

CREATE TRIGGER traspasos_validar_ins BEFORE INSERT ON traspasos
WHEN NEW.estado NOT IN ('pendiente', 'enviado', 'recibido', 'cancelado') OR length(trim(NEW.responsable)) = 0
BEGIN SELECT RAISE(ABORT, 'Traspaso no valido (estado o responsable)'); END;

CREATE TRIGGER traspasos_validar_upd BEFORE UPDATE OF estado ON traspasos
WHEN NEW.estado NOT IN ('pendiente', 'enviado', 'recibido', 'cancelado')
BEGIN SELECT RAISE(ABORT, 'Estado de traspaso no valido'); END;

-- Un traspaso recibido o cancelado ya no cambia de estado.
CREATE TRIGGER traspasos_estados_finales BEFORE UPDATE OF estado ON traspasos
WHEN OLD.estado IN ('recibido', 'cancelado') AND NEW.estado <> OLD.estado
BEGIN SELECT RAISE(ABORT, 'El traspaso ya esta cerrado'); END;

CREATE INDEX idx_traspaso_detalles_traspaso ON traspaso_detalles(traspaso_id);

CREATE TRIGGER traspaso_detalles_validar BEFORE INSERT ON traspaso_detalles
WHEN NEW.cantidad <= 0
BEGIN SELECT RAISE(ABORT, 'La cantidad del traspaso debe ser mayor a 0'); END;

-- ---- movimientos_inventario ----
-- El CHECK existente solo admite: entrada, venta, ajuste, traspaso_entrada, traspaso_salida y cantidad > 0
-- (sin signo). Las anulaciones se registran como 'ajuste' con referencia_tipo 'venta_cancelada' o
-- 'traspaso_cancelado' (siempre son reposiciones, es decir, entradas).
CREATE INDEX idx_movimientos_ref ON movimientos_inventario(referencia_tipo, referencia_id);
CREATE INDEX idx_inventario_sucursal ON inventario(sucursal_id);

-- ---- vista corregida: cuenta solo ventas completadas ----
DROP VIEW IF EXISTS vista_resumen_ventas;
CREATE VIEW vista_resumen_ventas AS
SELECT
    s.nombre AS sucursal,
    COUNT(v.id) AS cantidad_ventas,
    COALESCE(SUM(v.total), 0) AS total_ventas
FROM sucursales s
LEFT JOIN ventas v ON v.sucursal_id = s.id AND v.estado = 'completada'
GROUP BY s.id, s.nombre;
