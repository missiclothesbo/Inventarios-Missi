-- 0004: nombre de usuario opcional para iniciar sesion con correo O usuario.
-- Aditiva: no cambia correos, hashes, roles ni sucursales de cuentas existentes (username queda NULL).
-- Los nombres de usuario no contienen "@" (validado en la API), asi que nunca chocan con un correo.
ALTER TABLE usuarios ADD COLUMN username TEXT;
CREATE UNIQUE INDEX idx_usuarios_username ON usuarios(username COLLATE NOCASE) WHERE username IS NOT NULL;

CREATE TRIGGER usuarios_username_formato_ins BEFORE INSERT ON usuarios
WHEN NEW.username IS NOT NULL AND instr(NEW.username, '@') > 0
BEGIN SELECT RAISE(ABORT, 'El nombre de usuario no puede contener @'); END;

CREATE TRIGGER usuarios_username_formato_upd BEFORE UPDATE OF username ON usuarios
WHEN NEW.username IS NOT NULL AND instr(NEW.username, '@') > 0
BEGIN SELECT RAISE(ABORT, 'El nombre de usuario no puede contener @'); END;
