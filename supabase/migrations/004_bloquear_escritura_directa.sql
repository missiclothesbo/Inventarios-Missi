-- 004_bloquear_escritura_directa.sql
-- EJECUTAR SOLO DESPUES de desplegar el frontend nuevo (el viejo escribe directo y dejaria de funcionar).
-- Quita la escritura directa a las tablas de stock/ventas: desde aqui solo se modifican
-- mediante las funciones (security definer) que validan, bloquean filas y dejan historial.
-- No elimina datos ni politicas de lectura.
begin;

revoke insert, update, delete on public.inventario     from anon, authenticated;
revoke insert, update, delete on public.ventas         from anon, authenticated;
revoke insert, update, delete on public.detalle_venta  from anon, authenticated;

-- Aviso: sin inicio de sesion, cualquiera con la clave publicable puede LLAMAR a las funciones.
-- Para cerrar eso del todo hace falta Supabase Auth + politicas por rol (siguiente paso).
commit;
