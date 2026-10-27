-- 0005: aditiva. Guarda el vendedor de cada venta, la foto (clave en R2) de cada modelo y un índice de fecha para reportes.
-- No modifica ni borra filas existentes (las ventas antiguas quedan con vendedor_id NULL).
ALTER TABLE ventas ADD COLUMN vendedor_id INTEGER REFERENCES usuarios(id);
ALTER TABLE productos ADD COLUMN foto_key TEXT;
CREATE INDEX idx_ventas_fecha ON ventas(fecha);
