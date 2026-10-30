// Pruebas de la lógica de colores por modelo. Ejecutar: npm run test:unit
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as c from "../src/lib/colores.ts";

const colors = [
  { id: 1, nombre: "Negro", estado: true, producto_ids: [1, 2] },
  { id: 2, nombre: "Verde oliva", estado: true, producto_ids: [5] },
  { id: 3, nombre: "Beige", estado: false, producto_ids: [5] },
  { id: 4, nombre: "Sin modelos", estado: true },
];

describe("nombre del color", () => {
  it("normaliza espacios y conserva las mayúsculas elegidas", () => {
    assert.equal(c.cleanColorName("  Verde    oliva  "), "Verde oliva");
    assert.equal(c.colorKey("  VERDE   Oliva "), "verde oliva");
  });
  it("valida vacío, largo, símbolos y duplicados sin importar mayúsculas ni espacios", () => {
    assert.match(c.colorNameError("   ", colors), /Escribe el nombre/);
    assert.match(c.colorNameError("a".repeat(41), colors), /demasiado largo/);
    assert.match(c.colorNameError("<b>", colors), /solo letras/i);
    assert.match(c.colorNameError("VERDE  OLIVA", colors), /Ya existe el color «Verde oliva»/);
    assert.equal(c.colorNameError("Azul eléctrico", colors), null);
    assert.equal(c.colorNameError("Verde oliva", colors, 2), null, "al editar, su propio nombre no cuenta como duplicado");
  });
});

describe("colores que se ofrecen por modelo", () => {
  it("solo los activos asignados al modelo; sin modelo, ninguno", () => {
    assert.deepEqual(c.colorsForProduct(colors, 5).map((x) => x.nombre), ["Verde oliva"], "Beige está desactivado");
    assert.deepEqual(c.colorsForProduct(colors, "1").map((x) => x.nombre), ["Negro"]);
    assert.deepEqual(c.colorsForProduct(colors, 3), []);
    assert.deepEqual(c.colorsForProduct(colors, ""), []);
    assert.deepEqual(c.colorsForProduct(colors, null), []);
  });
  it("modelos que aún no tienen el color", () => {
    assert.deepEqual(c.unassignedProducts(colors[0], [{ id: 1 }, { id: 2 }, { id: 5 }]), [{ id: 5 }]);
    assert.equal(c.unassignedProducts(colors[3], [{ id: 1 }]).length, 1);
  });
});

describe("pantalla de colores solo para administradores", () => {
  it("ruta protegida y menú visible solo al admin", () => {
    assert.match(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"), /path="\/colores" element=\{<AdminOnly><Colores \/><\/AdminOnly>\}/);
    assert.match(readFileSync(new URL("../src/components/layout/navigation.ts", import.meta.url), "utf8"), /path: "\/colores", icon: Palette, adminOnly: true/);
  });
  it("no usa listas fijas ni almacenamiento local como fuente de colores", () => {
    const page = readFileSync(new URL("../src/pages/Colores/Colores.tsx", import.meta.url), "utf8");
    assert.ok(!/localStorage|sessionStorage/.test(page));
    assert.match(page, /listAllColors\(\)/);
  });
});
