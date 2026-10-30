-- 0014: colores administrables y asignados por modelo. ADITIVA: no borra ni reescribe colores, stock ni ventas.
-- Los ids de color no cambian, así que todo el historial (inventario, ventas, lotes, movimientos) sigue válido.

-- Nombre normalizado (minúsculas, sin espacios de más) para impedir duplicados que solo cambian en mayúsculas.
-- La API lo recalcula con la misma regla; la base garantiza la unicidad aunque dos peticiones lleguen a la vez.
ALTER TABLE colores ADD COLUMN nombre_norm TEXT;
ALTER TABLE colores ADD COLUMN created_at TEXT;
ALTER TABLE colores ADD COLUMN updated_at TEXT;
UPDATE colores SET nombre_norm = lower(trim(nombre)) WHERE nombre_norm IS NULL;
CREATE UNIQUE INDEX idx_colores_nombre_norm ON colores(nombre_norm);

CREATE TRIGGER colores_nombre_norm_ins AFTER INSERT ON colores WHEN NEW.nombre_norm IS NULL
BEGIN UPDATE colores SET nombre_norm = lower(trim(NEW.nombre)) WHERE id = NEW.id; END;

-- Qué colores se ofrecen para cada modelo. Quitar una asignación NO toca stock ni ventas existentes: solo deja de
-- ofrecer ese color para registrar mercadería nueva del modelo.
CREATE TABLE producto_colores (
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  color_id INTEGER NOT NULL REFERENCES colores(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (producto_id, color_id)
);
CREATE INDEX idx_producto_colores_color ON producto_colores(color_id);

-- Siembra: hoy todo modelo ofrece todo color; se conserva exactamente eso para los modelos y colores existentes.
INSERT OR IGNORE INTO producto_colores (producto_id, color_id)
SELECT p.id, c.id FROM productos p CROSS JOIN colores c;
