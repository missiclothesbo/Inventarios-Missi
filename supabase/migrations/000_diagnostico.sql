-- 000_diagnostico.sql  (SOLO LECTURA - ejecutar primero y revisar)
-- Confirma que no hay triggers que descuenten stock por su cuenta (se duplicaría
-- con las nuevas funciones) y muestra constraints/policies actuales.
select event_object_table, trigger_name, action_statement
  from information_schema.triggers where trigger_schema = 'public';

select conrelid::regclass as tabla, conname, pg_get_constraintdef(oid) as definicion
  from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2;

select tablename, policyname, cmd, roles, qual, with_check
  from pg_policies where schemaname = 'public' order by 1, 2;

select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns where table_schema = 'public' order by 1, ordinal_position;
