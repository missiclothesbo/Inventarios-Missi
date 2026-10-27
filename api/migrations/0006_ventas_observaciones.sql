-- 0006: aditiva. Descripción/notas opcionales de la venta. Las ventas existentes quedan con observaciones NULL.
ALTER TABLE ventas ADD COLUMN observaciones TEXT;
