-- 0003: autenticacion propia (usuarios, sesiones, intentos de login), auditoria e idempotencia generica.
-- Las contrasenas se guardan SOLO como hash PBKDF2-SHA256 con sal; los tokens de sesion solo como SHA-256.

CREATE TABLE usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    nombre TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL CHECK (rol IN ('admin', 'vendedor')),
    sucursal_id INTEGER REFERENCES sucursales(id),
    activo INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ultimo_login TEXT,
    CHECK (rol = 'admin' OR sucursal_id IS NOT NULL)
);

CREATE TABLE sesiones (
    token_hash TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
);
CREATE INDEX idx_sesiones_usuario ON sesiones(usuario_id);
CREATE INDEX idx_sesiones_expira ON sesiones(expires_at);

CREATE TABLE intentos_login (
    email TEXT NOT NULL COLLATE NOCASE,
    ocurrido_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_intentos_login ON intentos_login(email, ocurrido_en);

CREATE TABLE auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER,
    accion TEXT NOT NULL,
    entidad TEXT NOT NULL,
    entidad_id INTEGER,
    detalle TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_auditoria_entidad ON auditoria(entidad, entidad_id);

CREATE TABLE idempotencia (
    clave TEXT PRIMARY KEY,
    ruta TEXT NOT NULL,
    usuario_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
