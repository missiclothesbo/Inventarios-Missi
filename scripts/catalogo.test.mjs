// Pruebas del catálogo compartido (tallas oficiales, categorías, motivos, departamentos, referencias) y de los periodos de análisis.
// Lógica pura. Ejecutar: npm run test:unit
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as c from "../shared/catalogo.ts";
import * as p from "../src/lib/periodoFiltro.ts";
import * as csv from "../src/lib/csv.ts";
import * as vf from "../src/lib/ventasFiltros.ts";

describe("tallas oficiales de pantalón", () => {
  it("son exactamente estas, en este orden, como texto literal", () => {
    assert.deepEqual([...c.PANTS_SIZES], ["P", "M", "G", "GG", "3G", "4G", "36", "38", "40", "42", "44", "46", "48"]);
    assert.ok(c.PANTS_SIZES.every((s) => typeof s === "string"));
  });

  it("3G y 4G son rótulos literales; no existen XS, L, XL, XXL, GGG, 3XL ni 4XL", () => {
    for (const ok of ["P", "3G", "4G", "36", "38"]) assert.equal(c.isPantsSize(ok), true, ok);
    for (const bad of ["S", "XS", "L", "XL", "XXL", "GGG", "3XL", "4XL", "3g", "p", " P", "P ", "36.0", "", 36, null, undefined]) {
      assert.equal(c.isPantsSize(bad), false, String(bad));
    }
  });

  it("no se normaliza ni se reordena: 36 va antes que 38 y P es la primera", () => {
    assert.ok(c.pantsSizeIndex("36") < c.pantsSizeIndex("38"));
    assert.equal(c.pantsSizeIndex("P"), 0);
    assert.deepEqual(c.sortSizeLabels(["40", "38", "P", "4G", "36", "3G"]), ["P", "3G", "4G", "36", "38", "40"]);
  });

  it("las tallas históricas se leen: se ordenan al final sin descartarse", () => {
    assert.deepEqual(c.sortSizeLabels(["XL", "P", "GGG", "48", "S"]), ["P", "48", "GGG", "S", "XL"]);
    assert.equal(c.pantsSizeIndex("GGG"), -1);
  });

  it("la restricción aplica solo a pantalones: otras categorías aceptan otras tallas", () => {
    assert.equal(c.sizeAllowedForNewStock("Pantalones", "XL"), false);
    assert.equal(c.sizeAllowedForNewStock("Pantalones", "3G"), true);
    assert.equal(c.sizeAllowedForNewStock(undefined, "XL"), false, "sin categoría se asume pantalón");
    assert.equal(c.sizeAllowedForNewStock("Accesorios", "XL"), true);
  });
});

describe("categorías de movimiento y motivos", () => {
  it("las siete categorías, con etiqueta en español", () => {
    assert.deepEqual([...c.MOVEMENT_CATEGORIES], ["INGRESO", "VENTA", "CAMBIO", "DEVOLUCION", "SALIDA", "TRASPASO", "AJUSTE"]);
    for (const k of c.MOVEMENT_CATEGORIES) assert.ok(c.MOVEMENT_LABELS[k]);
    assert.equal(c.isMovementCategory("TRASPASO"), true);
    assert.equal(c.isMovementCategory("traspaso"), false);
  });

  it("motivos de devolución y cambio: los ocho acordados", () => {
    assert.deepEqual(Object.values(c.RETURN_REASON_LABELS), [
      "Talla incorrecta", "Color diferente al esperado", "Modelo diferente al esperado", "Defecto de fábrica",
      "Producto dañado", "Error en el pedido", "Cliente solicitó cambio", "Otro",
    ]);
    assert.equal(c.isReturnReason("OTRO"), true);
    assert.equal(c.isReturnReason("otro"), false);
  });
});

describe("departamentos de Bolivia", () => {
  it("los nueve, y el reconocimiento ignora mayúsculas, tildes y espacios sin reescribir el dato", () => {
    assert.equal(c.DEPARTMENTS.length, 9);
    assert.equal(c.canonicalDepartment("  la   paz "), "La Paz");
    assert.equal(c.canonicalDepartment("POTOSI"), "Potosí");
    assert.equal(c.canonicalDepartment("oruro"), "Oruro");
    assert.equal(c.canonicalDepartment("Atlántida"), null, "no reconocido: se conserva para revisión");
    assert.equal(c.canonicalDepartment(""), null);
    assert.equal(c.canonicalDepartment(null), null);
  });
});

describe("referencias legibles", () => {
  it("formatos fijos y lectura de lo que escribe el usuario", () => {
    assert.equal(c.saleRef(123), "V-000123");
    assert.equal(c.transferRef(12), "TR-000012");
    assert.equal(c.movementRef(7), "MOV-000007");
    assert.equal(c.operationRef("cambio", 5), "CM-000005");
    assert.equal(c.operationRef("devolucion", 5), "DV-000005");
    assert.equal(c.operationRef("anulacion", 5), "AN-000005");
    assert.deepEqual(c.parseRef("TR-000012"), { kind: "TR", id: 12 });
    assert.deepEqual(c.parseRef("tr12"), { kind: "TR", id: 12 });
    assert.deepEqual(c.parseRef("#45"), { kind: null, id: 45 });
    assert.deepEqual(c.parseRef("V-5"), { kind: "V", id: 5 });
    assert.equal(c.parseRef("palazzo"), null);
  });
});

describe("periodos de análisis", () => {
  const hoy = "2026-10-21"; // miércoles
  it("incluye todos los periodos pedidos más «todo el historial»", () => {
    assert.deepEqual(p.PERIODOS_ANALISIS, ["hoy", "ayer", "semana_actual", "semana_anterior", "mes_actual", "mes_anterior", "anio_actual", "todo", "personalizado"]);
    assert.equal(p.PERIODO_ANALISIS_TEXT.todo, "Todo el historial");
  });

  it("resuelve cada preset a fechas inclusivas de Bolivia", () => {
    const r = (x) => p.resolverPeriodo(x, { desde: "", hasta: "" }, hoy);
    assert.deepEqual(r("hoy"), { desde: hoy, hasta: hoy, error: null });
    assert.deepEqual(r("ayer"), { desde: "2026-10-20", hasta: "2026-10-20", error: null });
    assert.deepEqual(r("semana_actual"), { desde: "2026-10-19", hasta: hoy, error: null });
    assert.deepEqual(r("semana_anterior"), { desde: "2026-10-12", hasta: "2026-10-18", error: null });
    assert.deepEqual(r("mes_actual"), { desde: "2026-10-01", hasta: hoy, error: null });
    assert.deepEqual(r("mes_anterior"), { desde: "2026-09-01", hasta: "2026-09-30", error: null });
    assert.deepEqual(r("anio_actual"), { desde: "2026-01-01", hasta: hoy, error: null });
  });

  it("todo el historial no manda fechas; el rango personalizado se valida", () => {
    assert.deepEqual(p.resolverPeriodo("todo", { desde: "", hasta: "" }, hoy), { error: null });
    assert.deepEqual(p.resolverPeriodo("personalizado", { desde: "2026-10-01", hasta: "2026-10-05" }, hoy), { desde: "2026-10-01", hasta: "2026-10-05", error: null });
    assert.ok(p.resolverPeriodo("personalizado", { desde: "2026-10-05", hasta: "2026-10-01" }, hoy).error);
    assert.ok(p.resolverPeriodo("personalizado", { desde: "", hasta: "" }, hoy).error);
    assert.deepEqual(p.resolverPeriodo("personalizado", { desde: "2026-10-05", hasta: "2026-10-05" }, hoy), { desde: "2026-10-05", hasta: "2026-10-05", error: null }, "un solo día es válido (inclusivo)");
  });
});

describe("exportación CSV", () => {
  it("escapa comas, comillas y saltos de línea; conserva tildes y números", () => {
    assert.equal(csv.csvCell('Pantalón "palazzo", azul'), '"Pantalón ""palazzo"", azul"');
    assert.equal(csv.csvCell("línea\nnueva"), '"línea\nnueva"');
    assert.equal(csv.csvCell(12.5), "12.5");
    assert.equal(csv.csvCell(null), "");
    assert.equal(csv.csvCell(undefined), "");
  });

  it("neutraliza celdas que Excel ejecutaría como fórmula", () => {
    for (const bad of ["=1+1", "+cmd", "-2+3", "@SUMA(A1)"]) assert.ok(csv.csvCell(bad).startsWith("'"), bad);
    assert.equal(csv.csvCell(-5), "-5", "un número negativo no es texto");
  });

  it("arma encabezado y filas con CRLF", () => {
    assert.equal(csv.toCsv(["A", "B"], [[1, "x"], [2, "y,z"]]), 'A,B\r\n1,x\r\n2,"y,z"');
  });

  it("nombre de archivo sin tildes ni espacios y con el periodo", () => {
    assert.equal(csv.csvFileName("Envíos por departamento", "2026-10-01", "2026-10-21"), "envios-por-departamento_2026-10-01_a_2026-10-21.csv");
    assert.equal(csv.csvFileName("modelos más vendidos"), "modelos-mas-vendidos_todo-el-historial.csv");
  });
});

describe("filtros del historial de ventas", () => {
  const hoy = "2026-10-21";
  const admin = { hoy, isAdmin: true, userBranchId: null, menuBranchId: 1 };
  const vend = { hoy, isAdmin: false, userBranchId: 2, menuBranchId: 2 };
  const base = vf.FILTROS_VACIOS(hoy);

  it("sin filtros: todo el historial, la sucursal del menú y ningún filtro activo", () => {
    const r = vf.aFiltrosServidor(base, admin);
    assert.equal(r.error, null);
    assert.equal(r.filtros.desde, undefined);
    assert.equal(r.filtros.hasta, undefined);
    assert.equal(r.filtros.sucursal_id, 1);
    assert.equal(vf.filtrosActivos(base), 0);
  });

  it("el administrador elige: menú lateral, toda la organización o una sucursal", () => {
    assert.equal(vf.aFiltrosServidor({ ...base, sucursal: "TODAS" }, admin).filtros.sucursal_id, null);
    assert.equal(vf.aFiltrosServidor({ ...base, sucursal: "2" }, admin).filtros.sucursal_id, 2);
    assert.equal(vf.aFiltrosServidor({ ...base, sucursal: "MENU" }, { ...admin, menuBranchId: null }).filtros.sucursal_id, null);
  });

  it("el vendedor SIEMPRE queda en su sucursal y no puede filtrar por responsable", () => {
    const r = vf.aFiltrosServidor({ ...base, sucursal: "1", usuario: "7" }, vend);
    assert.equal(r.filtros.sucursal_id, 2);
    assert.equal(r.filtros.usuario_id, null);
  });

  it("convierte cada filtro a su parámetro, recorta texto y descarta vacíos", () => {
    const f = { ...base, estado: "cancelada", metodo: "QR", modalidad: "envio", departamento: "La Paz", provincia: "  Murillo ", municipio: "Palca", producto: "5", talla: "7", color: "2", usuario: "3", q: " V-000012 " };
    const r = vf.aFiltrosServidor(f, admin).filtros;
    assert.deepEqual(r, {
      estado: "cancelada", sucursal_id: 1, desde: undefined, hasta: undefined, metodo_pago: "QR", modalidad: "envio", departamento: "La Paz",
      provincia: "Murillo", municipio: "Palca", producto_id: 5, talla_id: 7, color_id: 2, usuario_id: 3, q: "V-000012",
    });
    assert.equal(vf.filtrosActivos(f), 11);
  });

  it("periodos: presets inclusivos, todo el historial y rango personalizado con validación", () => {
    assert.deepEqual([vf.aFiltrosServidor({ ...base, preset: "hoy" }, admin).filtros.desde, vf.aFiltrosServidor({ ...base, preset: "hoy" }, admin).filtros.hasta], [hoy, hoy]);
    assert.equal(vf.aFiltrosServidor({ ...base, preset: "mes_anterior" }, admin).filtros.desde, "2026-09-01");
    const bad = vf.aFiltrosServidor({ ...base, preset: "personalizado", custom: { desde: "2026-10-05", hasta: "2026-10-01" } }, admin);
    assert.ok(bad.error);
    assert.deepEqual(bad.filtros, {});
    assert.equal(vf.filtrosActivos({ ...base, preset: "hoy" }), 1);
  });
});
