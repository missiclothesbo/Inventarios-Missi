ALTER TABLE usuarios ADD COLUMN username TEXT;
ALTER TABLE usuarios ADD COLUMN telefono TEXT;
CREATE UNIQUE INDEX idx_usuarios_username ON usuarios(username);

INSERT INTO usuarios
(email, nombre, username, telefono, password_hash, rol, sucursal_id, activo)
VALUES
('nadith@missi.local', 'Nadith Navarro', 'nadith', NULL,
'pbkdf2$100000$wzoAoD7ao4spobS4TNhrQw$o2C6lDnp46NpAfg7w-P0E42Pq-ZHmhVaBwPakuavjsw',
'admin', NULL, 1);

INSERT INTO usuarios
(email, nombre, username, telefono, password_hash, rol, sucursal_id, activo)
VALUES
('alis@missi.local', 'Alis Villagabriel', 'alis', NULL,
'pbkdf2$100000$AQuuby65a8jgPdlTZT83yA$5f214UqvmAlP_-AB5ZBQMs_jw8FpeTOD4Zf8U2BO5JI',
'vendedor', 1, 1);

SELECT id, nombre, username, rol, sucursal_id, activo FROM usuarios;
