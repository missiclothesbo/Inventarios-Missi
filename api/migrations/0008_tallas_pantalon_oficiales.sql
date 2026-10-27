-- 0008: catálogo oficial de tallas de pantalón. ADITIVA y reversible por datos: no borra tallas ni referencias.
--
-- Orden y rótulos oficiales (texto literal, "3G" y "4G" NO son 3XL/4XL):
--   S, M, G, GG, 3G, 4G, 38, 36, 40, 42, 44, 46, 48
--
-- * La talla que la migración 0001 renombró a "GGG" vuelve a su rótulo original "3G" (el export real de D1 la tenía así).
--   Se conserva el MISMO id, por lo que inventario, ventas, traspasos y devoluciones históricas siguen apuntando a ella.
--   El rótulo anterior queda registrado en tallas.etiqueta_historica (auditable).
-- * "4G" se agrega solo si no existe.
-- * Cualquier otra talla que ya existiera (histórica) se conserva, queda con oficial_pantalon = 0 y al final del orden:
--   se sigue leyendo en el historial pero no se ofrece para inventario nuevo.

ALTER TABLE tallas ADD COLUMN oficial_pantalon INTEGER NOT NULL DEFAULT 0 CHECK (oficial_pantalon IN (0, 1));
ALTER TABLE tallas ADD COLUMN etiqueta_historica TEXT;

UPDATE tallas SET etiqueta_historica = nombre, nombre = '3G'
 WHERE nombre = 'GGG' AND NOT EXISTS (SELECT 1 FROM tallas t2 WHERE t2.nombre = '3G');

INSERT INTO tallas (nombre, orden) SELECT '4G', 6 WHERE NOT EXISTS (SELECT 1 FROM tallas WHERE nombre = '4G');

-- Tallas históricas (no oficiales) al final, sin perder su orden relativo.
UPDATE tallas SET orden = 100 + orden
 WHERE nombre NOT IN ('S', 'M', 'G', 'GG', '3G', '4G', '38', '36', '40', '42', '44', '46', '48') AND orden < 100;

UPDATE tallas SET oficial_pantalon = 1,
       orden = CASE nombre
         WHEN 'S' THEN 1 WHEN 'M' THEN 2 WHEN 'G' THEN 3 WHEN 'GG' THEN 4 WHEN '3G' THEN 5 WHEN '4G' THEN 6
         WHEN '38' THEN 7 WHEN '36' THEN 8 WHEN '40' THEN 9 WHEN '42' THEN 10 WHEN '44' THEN 11 WHEN '46' THEN 12 WHEN '48' THEN 13
       END
 WHERE nombre IN ('S', 'M', 'G', 'GG', '3G', '4G', '38', '36', '40', '42', '44', '46', '48');

-- Los rótulos oficiales no se renombran por accidente (ni por una API ni por un script).
CREATE TRIGGER tallas_oficiales_inmutables BEFORE UPDATE OF nombre ON tallas
WHEN OLD.oficial_pantalon = 1 AND NEW.nombre <> OLD.nombre
BEGIN SELECT RAISE(ABORT, 'El rotulo de una talla oficial de pantalon no se puede cambiar'); END;

CREATE TRIGGER tallas_oficiales_no_borrar BEFORE DELETE ON tallas
WHEN OLD.oficial_pantalon = 1
BEGIN SELECT RAISE(ABORT, 'Una talla oficial de pantalon no se puede borrar'); END;
