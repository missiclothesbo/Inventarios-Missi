-- 0001: sucursales con codigo/central + ajustes de catalogo. Aditiva.
-- NO toca inventario/ventas. Verificado contra el esquema remoto real (auditoria 2026-10-18).

ALTER TABLE sucursales ADD COLUMN codigo TEXT;
ALTER TABLE sucursales ADD COLUMN es_central INTEGER NOT NULL DEFAULT 0 CHECK (es_central IN (0, 1));
UPDATE sucursales SET codigo = 'CBBA', es_central = 1 WHERE nombre = 'MISSI Cochabamba';
UPDATE sucursales SET codigo = 'SCZ' WHERE nombre = 'MISSI Santa Cruz';
CREATE UNIQUE INDEX idx_sucursales_codigo ON sucursales(codigo);

-- Talla: el rotulo oficial es GGG (se conserva el id, asi que cualquier referencia futura sigue valida).
UPDATE tallas SET nombre = 'GGG'
 WHERE nombre = '3G' AND NOT EXISTS (SELECT 1 FROM tallas WHERE nombre = 'GGG');
-- 36,38,40,42,44,46,48 ya existen en D1 (verificado); no se insertan.

-- Colores nuevos (los existentes NO se renombran ni se fusionan).
--  * Beige: pedido explicito.
--  * Verde hoja seca: normalizacion de "Hoja seca" de Supabase. Se agrega aparte de "Verde hoja"
--    (distinto tono) para no fusionar colores sin confirmacion.
--  * Azul y Celeste: existen en Supabase y NO tienen equivalente exacto en D1 (Azul marino y Celeste pastel
--    son colores distintos); se agregan sin fusionar.
-- Capuchino -> Cappuccino y Pistacho -> Verde pistacho ya existen en D1: se mapean en la importacion.
INSERT INTO colores (nombre) SELECT 'Beige'           WHERE NOT EXISTS (SELECT 1 FROM colores WHERE nombre = 'Beige');
INSERT INTO colores (nombre) SELECT 'Verde hoja seca' WHERE NOT EXISTS (SELECT 1 FROM colores WHERE nombre = 'Verde hoja seca');
INSERT INTO colores (nombre) SELECT 'Azul'            WHERE NOT EXISTS (SELECT 1 FROM colores WHERE nombre = 'Azul');
INSERT INTO colores (nombre) SELECT 'Celeste'         WHERE NOT EXISTS (SELECT 1 FROM colores WHERE nombre = 'Celeste');

-- Modelo independiente. precio_venta queda en 0 (sin precio) hasta definirlo: la venta exige precio
-- explicito si el modelo no tiene precio_venta > 0.
INSERT INTO productos (nombre) SELECT 'Hebilla bota recta'
 WHERE NOT EXISTS (SELECT 1 FROM productos WHERE nombre = 'Hebilla bota recta');
