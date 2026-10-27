-- 0013: la ubicación de tipo almacén se llama "Almacén Central" y pasa a ser la ubicación principal (es_central).
-- El nombre "MISSI BOLIVIA" deja de usarse como ubicación: queda solo como nombre interno de la organización.
-- Solo renombra la fila creada en 0012 (tipo = 'almacen'); no toca stock, lotes, ventas ni movimientos.
UPDATE sucursales SET nombre = 'Almacén Central', codigo = 'ALM', es_central = 1
 WHERE tipo = 'almacen' AND nombre = 'MISSI BOLIVIA';
UPDATE sucursales SET es_central = 0 WHERE tipo <> 'almacen' AND es_central = 1
   AND EXISTS (SELECT 1 FROM sucursales WHERE tipo = 'almacen' AND es_central = 1);
