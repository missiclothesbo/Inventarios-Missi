// Pruebas de periodos de reporte, fechas de Bolivia, modelos de reporte e impresión.
// Ejecutar: npm run test:unit
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as p from "../src/lib/periodos.ts";
import * as r from "../src/lib/reportes.ts";

const HOY = "2026-10-19"; // lunes

describe("fecha de hoy en Bolivia", () => {
  it("usa la fecha de La Paz, no la del equipo: 02:00 UTC del 19 = 22:00 del 18", () => {
    assert.equal(p.hoyBolivia(new Date("2026-10-19T02:00:00Z")), "2026-10-18");
    assert.equal(p.hoyBolivia(new Date("2026-10-19T05:00:00Z")), "2026-10-19");
  });
});

describe("presets de periodo", () => {
  it("hoy y ayer", () => {
    assert.deepEqual(p.rangoPreset("hoy", HOY), { desde: "2026-10-19", hasta: "2026-10-19" });
    assert.deepEqual(p.rangoPreset("ayer", HOY), { desde: "2026-10-18", hasta: "2026-10-18" });
  });

  it("semana actual empieza el lunes y llega hasta hoy; semana anterior es lunes a domingo completos", () => {
    assert.deepEqual(p.rangoPreset("semana_actual", HOY), { desde: "2026-10-19", hasta: "2026-10-19" });
    assert.deepEqual(p.rangoPreset("semana_actual", "2026-10-22"), { desde: "2026-10-19", hasta: "2026-10-22" });
    assert.deepEqual(p.rangoPreset("semana_anterior", "2026-10-22"), { desde: "2026-10-12", hasta: "2026-10-18" });
  });

  it("semana anterior cruza mes y año", () => {
    assert.deepEqual(p.rangoPreset("semana_anterior", "2026-01-05"), { desde: "2025-12-29", hasta: "2026-01-04" }); // 05-ene-2026 es lunes
  });

  it("mes actual desde el día 1 hasta hoy; mes anterior completo (incluye febrero bisiesto)", () => {
    assert.deepEqual(p.rangoPreset("mes_actual", HOY), { desde: "2026-10-01", hasta: "2026-10-19" });
    assert.deepEqual(p.rangoPreset("mes_anterior", HOY), { desde: "2026-09-01", hasta: "2026-09-30" });
    assert.deepEqual(p.rangoPreset("mes_anterior", "2024-03-10"), { desde: "2024-02-01", hasta: "2024-02-29" });
    assert.deepEqual(p.rangoPreset("mes_anterior", "2026-01-15"), { desde: "2025-12-01", hasta: "2025-12-31" });
  });

  it("año actual desde el 1 de enero hasta hoy", () => {
    assert.deepEqual(p.rangoPreset("anio_actual", HOY), { desde: "2026-01-01", hasta: "2026-10-19" });
  });

  it("personalizado no tiene rango automático", () => {
    assert.equal(p.rangoPreset("personalizado", HOY), null);
  });
});

describe("validación y extremos del rango", () => {
  it("desde posterior a hasta se rechaza", () => {
    assert.match(p.validarRango({ desde: "2026-10-19", hasta: "2026-10-18" }), /posterior/);
  });

  it("fechas inválidas o incompletas se rechazan", () => {
    assert.ok(p.validarRango({ desde: "", hasta: "2026-10-18" }));
    assert.ok(p.validarRango({ desde: "2026-02-30", hasta: "2026-10-18" }));
    assert.ok(p.validarRango({ desde: "19/10/2026", hasta: "2026-10-19" }));
  });

  it("un día exacto es válido y cuenta como 1 día (fin incluido)", () => {
    assert.equal(p.validarRango({ desde: "2026-10-19", hasta: "2026-10-19" }), null);
    assert.equal(p.diasEnRango({ desde: "2026-10-19", hasta: "2026-10-19" }), 1);
    assert.equal(p.diasEnRango({ desde: "2026-10-01", hasta: "2026-10-31" }), 31);
  });
});

describe("formato de montos (bolivianos)", () => {
  it("separador de miles y decimales en formato boliviano; negativos con signo delante", () => {
    assert.equal(r.formatBs(1234.5), "Bs 1.234,50");
    assert.equal(r.formatBs(0), "Bs 0,00");
    assert.equal(r.formatBs(-35), "-Bs 35,00");
  });
});

const sale = (over) => ({
  id: 1, fecha: "2026-10-18 15:00:00", total: 135, sucursal_id: 1, metodo_pago: "QR", modalidad: "entrega_directa",
  departamento: null, provincia: null, cliente_nombre: "Ana", cliente_telefono: "70000000", estado: "completada", ...over,
});
const names = (id) => (id === 1 ? "MISSI Cochabamba" : "MISSI Santa Cruz");
const rango = { desde: "2026-10-18", hasta: "2026-10-18" };

describe("detalle de ventas: el total solo cuenta completadas", () => {
  it("las anuladas se listan pero no suman al total", () => {
    const m = r.buildVentasModel([sale({ id: 1, total: 135 }), sale({ id: 2, total: 200, estado: "cancelada" })], names, rango, "Todas", false);
    assert.equal(m.resumen.find((x) => x.label === "Total de ventas completadas").value, "Bs 135,00");
    assert.equal(m.resumen.find((x) => x.label === "Ventas anuladas (no suman)").value, "1");
    assert.equal(m.filas.length, 2, "ambas aparecen en el detalle");
    assert.equal(m.filas[1][7], "Anulada");
  });

  it("marca el límite cuando el listado llega al tope", () => {
    const m = r.buildVentasModel([sale({})], names, rango, "Todas", true);
    assert.match(m.nota, /limitado a 500/);
  });
});

describe("operaciones: devoluciones, cambios y anulaciones separados", () => {
  const op = (over) => ({
    id: 1, tipo: "devolucion", venta_id: 4, sucursal_id: 1, operador: "Vend CB", motivo: "talla", fecha: "2026-10-18T10:00:00Z",
    valor_devuelto: 135, valor_entregado: 0, diferencia: -135, pago: { tipo: "reembolso", estado: "completado", metodo: "efectivo", monto: 135 }, items: [], ...over,
  });

  it("suma devueltos, entregados y reembolsos por estado", () => {
    const m = r.buildOperacionesModel([
      op({}),
      op({ id: 2, tipo: "cambio", valor_devuelto: 90, valor_entregado: 200, diferencia: 110, pago: { tipo: "cobro", estado: "completado", metodo: "qr", monto: 110 } }),
      op({ id: 3, tipo: "anulacion", valor_devuelto: 50, diferencia: -50, pago: { tipo: "reembolso", estado: "pendiente", metodo: null, monto: 50 } }),
    ], names, rango, "Todas", false);
    const val = (label) => m.resumen.find((x) => x.label === label).value;
    assert.equal(val("Devoluciones"), "1");
    assert.equal(val("Cambios"), "1");
    assert.equal(val("Anulaciones"), "1");
    assert.equal(val("Valor devuelto"), "Bs 225,00", "la anulación también devuelve valor");
    assert.equal(val("Valor de cambios entregados"), "Bs 200,00");
    assert.equal(val("Cobros de diferencia (completados)"), "Bs 110,00");
    assert.equal(val("Reembolsos entregados"), "Bs 135,00");
    assert.equal(val("Reembolsos pendientes"), "Bs 50,00");
  });
});

describe("movimientos de inventario y stock", () => {
  it("el resumen de movimientos separa entradas, salidas y cuarentena según su efecto", () => {
    const m = r.buildMovimientosModel({
      total_movimientos: 3, truncado: false, totales: [],
      filas: [
        { fecha: "x", sucursal: "A", producto: "P", talla: "S", color: "N", tipo: "Ingreso", efecto: "Entrada", cantidad: 5, referencia: "", observaciones: "" },
        { fecha: "x", sucursal: "A", producto: "P", talla: "S", color: "N", tipo: "Venta", efecto: "Salida", cantidad: 2, referencia: "", observaciones: "" },
        { fecha: "x", sucursal: "A", producto: "P", talla: "S", color: "N", tipo: "Ajuste", efecto: "Cuarentena (no vendible)", cantidad: 1, referencia: "", observaciones: "" },
      ],
    }, rango, "Todas");
    const val = (label) => m.resumen.find((x) => x.label.startsWith(label)).value;
    assert.equal(val("Unidades que entran"), "5");
    assert.equal(val("Unidades que salen"), "2");
    assert.equal(val("Prendas dañadas"), "1");
  });

  it("stock: totales por sucursal vendible y dañado; sin periodo", () => {
    const m = r.buildStockModel({
      generado: "2026-10-19T07:00:00Z",
      totales_por_sucursal: [{ sucursal: "MISSI Cochabamba", vendible: 27, danado: 1 }],
      filas: [{ sucursal: "MISSI Cochabamba", producto: "P", talla: "S", color: "N", estado: "Vendible", cantidad: 27 }],
    }, "Todas");
    assert.equal(m.resumen[0].value, "27");
    assert.equal(m.resumen[1].value, "1");
    assert.match(m.nota, /No depende del periodo/);
  });
});

describe("resumen de ventas y pagos", () => {
  it("el ingreso neto se calcula como bruto − devoluciones + cambios entregados", () => {
    const balance = {
      resumen: { ventas: 3, ingresos: 500, unidades: 5, ticket_promedio: 166.67 },
      por_metodo: [{ clave: "QR", ventas: 2, ingresos: 300 }, { clave: "efectivo", ventas: 1, ingresos: 200 }],
      por_sucursal: [], por_departamento: [], por_modalidad: [], por_dia: [], top_productos: [],
      traspasos: { total: 0, pendientes: 0, enviados: 0, recibidos: 0, cancelados: 0, unidades_recibidas: 0 },
      operaciones: {
        devoluciones: 1, cambios: 1, anulaciones: 0, valor_devuelto: 135, valor_cambio_entregado: 200, valor_anulado: 0,
        ingresos_brutos: 500, ingresos_netos: 565, cobros_completados: 0, reembolsos_completados: 0,
        reembolsos_pendientes: 0, creditos_pendientes: 0, pagos: [],
      },
    };
    const m = r.buildResumenModel(balance, rango, "Todas");
    assert.equal(m.resumen.find((x) => x.label === "Ingreso neto").value, "Bs 565,00");
    const proporcion = m.filas.find((f) => f[1] === "QR")[4];
    assert.equal(proporcion, "60.0%");
  });
});

describe("impresión: estilos de página y reglas de visibilidad", () => {
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const reportePrint = css.slice(css.indexOf("/* ---------- Impresión de reportes"));

  it("el reporte se oculta en pantalla y solo aparece al imprimir", () => {
    assert.match(reportePrint, /\.reporte-print\s*\{\s*display:\s*none;/);
    assert.match(reportePrint, /@media print[\s\S]*body\.printing-reporte > #root\s*\{\s*display:\s*none !important;/);
    assert.match(reportePrint, /body\.printing-reporte \.reporte-print\s*\{\s*display:\s*block !important;/);
  });

  it("A4 horizontal, numeración de páginas y encabezados de tabla repetidos", () => {
    assert.match(reportePrint, /size:\s*A4 landscape/);
    assert.match(reportePrint, /counter\(page\)/);
    assert.match(reportePrint, /\.reporte-tabla thead\s*\{\s*display:\s*table-header-group;/);
    assert.match(reportePrint, /page-break-inside:\s*avoid/);
  });
});
