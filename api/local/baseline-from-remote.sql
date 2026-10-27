PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE sucursales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    activa INTEGER NOT NULL DEFAULT 1
);
INSERT INTO "sucursales" ("id","nombre","activa") VALUES(1,'MISSI Cochabamba',1);
INSERT INTO "sucursales" ("id","nombre","activa") VALUES(2,'MISSI Santa Cruz',1);
CREATE TABLE productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    descripcion TEXT,
    categoria TEXT NOT NULL DEFAULT 'Pantalones',
    precio_venta REAL NOT NULL DEFAULT 0,
    costo REAL NOT NULL DEFAULT 0,
    activo INTEGER NOT NULL DEFAULT 1,
    fecha_creacion TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "productos" ("id","nombre","descripcion","categoria","precio_venta","costo","activo","fecha_creacion") VALUES(1,'Palazzo sastrero',NULL,'Pantalones',0,0,1,'2026-10-18 18:37:53');
INSERT INTO "productos" ("id","nombre","descripcion","categoria","precio_venta","costo","activo","fecha_creacion") VALUES(2,'Palazzo ejecutivo',NULL,'Pantalones',0,0,1,'2026-10-18 18:37:53');
INSERT INTO "productos" ("id","nombre","descripcion","categoria","precio_venta","costo","activo","fecha_creacion") VALUES(3,'Cintura de avispa',NULL,'Pantalones',0,0,1,'2026-10-18 18:37:53');
INSERT INTO "productos" ("id","nombre","descripcion","categoria","precio_venta","costo","activo","fecha_creacion") VALUES(4,'Short sastrero',NULL,'Pantalones',0,0,1,'2026-10-18 18:37:53');
INSERT INTO "productos" ("id","nombre","descripcion","categoria","precio_venta","costo","activo","fecha_creacion") VALUES(5,'Palazzo con hebilla',NULL,'Pantalones',0,0,1,'2026-10-18 18:37:53');
CREATE TABLE tallas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    orden INTEGER NOT NULL
);
INSERT INTO "tallas" ("id","nombre","orden") VALUES(1,'S',1);
INSERT INTO "tallas" ("id","nombre","orden") VALUES(2,'M',2);
INSERT INTO "tallas" ("id","nombre","orden") VALUES(3,'G',3);
INSERT INTO "tallas" ("id","nombre","orden") VALUES(4,'GG',4);
INSERT INTO "tallas" ("id","nombre","orden") VALUES(5,'3G',5);
INSERT INTO "tallas" ("id","nombre","orden") VALUES(6,'36',6);
INSERT INTO "tallas" ("id","nombre","orden") VALUES(7,'38',7);
INSERT INTO "tallas" ("id","nombre","orden") VALUES(8,'40',8);
INSERT INTO "tallas" ("id","nombre","orden") VALUES(9,'42',9);
INSERT INTO "tallas" ("id","nombre","orden") VALUES(10,'44',10);
INSERT INTO "tallas" ("id","nombre","orden") VALUES(11,'46',11);
INSERT INTO "tallas" ("id","nombre","orden") VALUES(12,'48',12);
CREATE TABLE colores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    estado INTEGER NOT NULL DEFAULT 1
);
INSERT INTO "colores" ("id","nombre","estado") VALUES(1,'Blanco',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(2,'Negro',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(3,'Azul marino',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(4,'Azul eléctrico',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(5,'Amarillo',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(6,'Verde hoja',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(7,'Verde pistacho',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(8,'Verde',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(9,'Plomo',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(10,'Cappuccino',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(11,'Café',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(12,'Rosado',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(13,'Celeste pastel',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(14,'Guindo',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(15,'Rojo',1);
INSERT INTO "colores" ("id","nombre","estado") VALUES(16,'Verde botella',1);
CREATE TABLE inventario (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER NOT NULL,
    talla_id INTEGER NOT NULL,
    color_id INTEGER NOT NULL,
    sucursal_id INTEGER NOT NULL,
    cantidad INTEGER NOT NULL DEFAULT 0 CHECK (cantidad >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (producto_id) REFERENCES productos(id),
    FOREIGN KEY (talla_id) REFERENCES tallas(id),
    FOREIGN KEY (color_id) REFERENCES colores(id),
    FOREIGN KEY (sucursal_id) REFERENCES sucursales(id),

    UNIQUE (producto_id, talla_id, color_id, sucursal_id)
);
CREATE TABLE ventas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sucursal_id INTEGER NOT NULL,
    fecha TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    total REAL NOT NULL DEFAULT 0 CHECK (total >= 0),
    metodo_pago TEXT,
    tipo_entrega TEXT,
    estado TEXT NOT NULL DEFAULT 'completada',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sucursal_id) REFERENCES sucursales(id)
);
CREATE TABLE detalle_venta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venta_id INTEGER NOT NULL,
    producto_id INTEGER NOT NULL,
    talla_id INTEGER NOT NULL,
    color_id INTEGER NOT NULL,
    cantidad INTEGER NOT NULL CHECK (cantidad > 0),
    precio_unitario REAL NOT NULL CHECK (precio_unitario >= 0),
    subtotal REAL NOT NULL CHECK (subtotal >= 0),

    FOREIGN KEY (venta_id) REFERENCES ventas(id),
    FOREIGN KEY (producto_id) REFERENCES productos(id),
    FOREIGN KEY (talla_id) REFERENCES tallas(id),
    FOREIGN KEY (color_id) REFERENCES colores(id)
);
CREATE TABLE traspasos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sucursal_origen_id INTEGER NOT NULL,
    sucursal_destino_id INTEGER NOT NULL,
    fecha TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    observaciones TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (sucursal_origen_id) REFERENCES sucursales(id),
    FOREIGN KEY (sucursal_destino_id) REFERENCES sucursales(id),

    CHECK (sucursal_origen_id <> sucursal_destino_id)
);
CREATE TABLE traspaso_detalles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    traspaso_id INTEGER NOT NULL,
    producto_id INTEGER NOT NULL,
    talla_id INTEGER NOT NULL,
    color_id INTEGER NOT NULL,
    cantidad INTEGER NOT NULL CHECK (cantidad > 0),

    FOREIGN KEY (traspaso_id) REFERENCES traspasos(id),
    FOREIGN KEY (producto_id) REFERENCES productos(id),
    FOREIGN KEY (talla_id) REFERENCES tallas(id),
    FOREIGN KEY (color_id) REFERENCES colores(id)
);
CREATE TABLE movimientos_inventario (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sucursal_id INTEGER NOT NULL,
    producto_id INTEGER NOT NULL,
    talla_id INTEGER NOT NULL,
    color_id INTEGER NOT NULL,
    tipo TEXT NOT NULL CHECK (
        tipo IN (
            'entrada',
            'venta',
            'ajuste',
            'traspaso_entrada',
            'traspaso_salida'
        )
    ),
    cantidad INTEGER NOT NULL CHECK (cantidad > 0),
    referencia_tipo TEXT,
    referencia_id INTEGER,
    observaciones TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (sucursal_id) REFERENCES sucursales(id),
    FOREIGN KEY (producto_id) REFERENCES productos(id),
    FOREIGN KEY (talla_id) REFERENCES tallas(id),
    FOREIGN KEY (color_id) REFERENCES colores(id)
);
CREATE TABLE departamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE,
    estado INTEGER NOT NULL DEFAULT 1
);
INSERT INTO "departamentos" ("id","nombre","estado") VALUES(1,'Beni',1);
INSERT INTO "departamentos" ("id","nombre","estado") VALUES(2,'Chuquisaca',1);
INSERT INTO "departamentos" ("id","nombre","estado") VALUES(3,'Cochabamba',1);
INSERT INTO "departamentos" ("id","nombre","estado") VALUES(4,'La Paz',1);
INSERT INTO "departamentos" ("id","nombre","estado") VALUES(5,'Oruro',1);
INSERT INTO "departamentos" ("id","nombre","estado") VALUES(6,'Pando',1);
INSERT INTO "departamentos" ("id","nombre","estado") VALUES(7,'Potosí',1);
INSERT INTO "departamentos" ("id","nombre","estado") VALUES(8,'Santa Cruz',1);
INSERT INTO "departamentos" ("id","nombre","estado") VALUES(9,'Tarija',1);
CREATE TABLE destinos_entrega (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo_entrega TEXT NOT NULL CHECK (
        tipo_entrega IN (
            'directa',
            'interdepartamental',
            'interprovincial'
        )
    ),
    departamento_id INTEGER,
    destino_manual TEXT,
    direccion TEXT,
    referencia TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (departamento_id) REFERENCES departamentos(id)
);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('sucursales',2);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('productos',5);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('tallas',12);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('colores',16);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('departamentos',9);
CREATE INDEX idx_inventario_variante
ON inventario(producto_id, talla_id, color_id);
CREATE INDEX idx_movimientos_fecha
ON movimientos_inventario(created_at);
CREATE TRIGGER validar_metodo_pago_venta
BEFORE INSERT ON ventas
WHEN NEW.metodo_pago IS NOT NULL
 AND NEW.metodo_pago NOT IN ('efectivo', 'qr')
BEGIN
    SELECT RAISE(ABORT, 'Metodo de pago no valido: use efectivo o qr');
END;
CREATE TRIGGER validar_metodo_pago_venta_update
BEFORE UPDATE OF metodo_pago ON ventas
WHEN NEW.metodo_pago IS NOT NULL
 AND NEW.metodo_pago NOT IN ('efectivo', 'qr')
BEGIN
    SELECT RAISE(ABORT, 'Metodo de pago no valido: use efectivo o qr');
END;
CREATE VIEW vista_resumen_ventas AS
SELECT
    s.nombre AS sucursal,
    COUNT(v.id) AS cantidad_ventas,
    COALESCE(SUM(
        CASE WHEN v.estado = 'completada'
             THEN v.total ELSE 0 END
    ), 0) AS total_ventas
FROM sucursales s
LEFT JOIN ventas v ON v.sucursal_id = s.id
GROUP BY s.id, s.nombre;
