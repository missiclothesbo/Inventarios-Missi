-- 0011: ajuste del catálogo oficial de tallas de pantalón (reemplaza el orden de la 0008).
--
-- Orden y rótulos oficiales (texto literal):  P, M, G, GG, 3G, 4G, 36, 38, 40, 42, 44, 46, 48
--
-- * La talla que se llamaba "S" pasa a "P". Se conserva el MISMO id, así que inventario, ventas, traspasos, devoluciones y
--   movimientos históricos siguen apuntando a ella sin tocar ninguna fila; el rótulo anterior queda en `etiqueta_historica`
--   (auditable). Es el mismo mecanismo que se usó para GGG → 3G en la 0008. Solo cambia cómo se LEE el rótulo.
-- * Si ya existiera una talla "P" distinta, no se renombra nada (se evita una fusión silenciosa) y "S" queda como histórica.
-- * 36 pasa a ir antes que 38.
-- * Cualquier talla que no esté en la lista se conserva como histórica (se lee, no se ofrece para inventario nuevo).

DROP TRIGGER IF EXISTS tallas_oficiales_inmutables;

UPDATE tallas SET etiqueta_historica = COALESCE(etiqueta_historica, nombre), nombre = 'P'
 WHERE nombre = 'S' AND NOT EXISTS (SELECT 1 FROM tallas t2 WHERE t2.nombre = 'P');

-- "P" nueva (solo si no existía y "S" no se pudo renombrar). Si "S" sigue existiendo queda como histórica.
INSERT INTO tallas (nombre, orden) SELECT 'P', 1 WHERE NOT EXISTS (SELECT 1 FROM tallas WHERE nombre = 'P');

UPDATE tallas SET oficial_pantalon = 0, orden = 100 + (orden % 100)
 WHERE nombre NOT IN ('P', 'M', 'G', 'GG', '3G', '4G', '36', '38', '40', '42', '44', '46', '48');

UPDATE tallas SET oficial_pantalon = 1,
       orden = CASE nombre
         WHEN 'P' THEN 1 WHEN 'M' THEN 2 WHEN 'G' THEN 3 WHEN 'GG' THEN 4 WHEN '3G' THEN 5 WHEN '4G' THEN 6
         WHEN '36' THEN 7 WHEN '38' THEN 8 WHEN '40' THEN 9 WHEN '42' THEN 10 WHEN '44' THEN 11 WHEN '46' THEN 12 WHEN '48' THEN 13
       END
 WHERE nombre IN ('P', 'M', 'G', 'GG', '3G', '4G', '36', '38', '40', '42', '44', '46', '48');

CREATE TRIGGER tallas_oficiales_inmutables BEFORE UPDATE OF nombre ON tallas
WHEN OLD.oficial_pantalon = 1 AND NEW.nombre <> OLD.nombre
BEGIN SELECT RAISE(ABORT, 'El rotulo de una talla oficial de pantalon no se puede cambiar'); END;
