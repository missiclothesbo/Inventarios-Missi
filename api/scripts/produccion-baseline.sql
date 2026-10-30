-- PRODUCCIÓN: la D1 real ya tiene aplicadas a mano las migraciones 0003 (auth) y 0004 (username) pero su tabla
-- d1_migrations está vacía. Este script SOLO registra esas dos como aplicadas, para que `migrations apply` ejecute
-- únicamente las pendientes (0001, 0002, 0005…0013). No modifica ninguna tabla de negocio.
-- NO ejecutar sin aprobación.
INSERT INTO d1_migrations (name) SELECT '0003_auth.sql' WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0003_auth.sql');
INSERT INTO d1_migrations (name) SELECT '0004_usuarios_username.sql' WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0004_usuarios_username.sql');
