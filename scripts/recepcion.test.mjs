// Pruebas de la lógica de recepción de mercadería y textos de lotes. Ejecutar: npm run test:unit
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as r from "../src/lib/recepcion.ts";
import * as u from "../src/lib/ubicaciones.ts";

const AHORA = new Date("2026-10-26T15:00:00Z"); // 11:00 en Bolivia

describe("fechas de recepción (hora de Bolivia, UTC−4)", () => {
  it("ahora en Bolivia y conversión a ISO con zona", () => {
    assert.equal(r.nowBoliviaLocal(AHORA), "2026-10-26T11:00");
    assert.equal(r.boliviaLocalToIso("2026-10-26T09:30"), "2026-10-26T09:30:00-04:00");
    assert.equal(new Date(r.boliviaLocalToIso("2026-10-26T09:30")).toISOString(), "2026-10-26T13:30:00.000Z");
    assert.equal(r.boliviaLocalToIso("26/10/2026"), null);
    assert.equal(r.boliviaLocalToIso(""), null);
  });
});

describe("validación de la recepción", () => {
  const ok = { ...r.emptyReceipt(AHORA), lineas: [{ key: "a", productoId: "1", tallaId: "2", colorId: "3", cantidad: "5" }] };

  it("formulario válido: sin errores y cuerpo para la API", () => {
    assert.deepEqual(r.validateReceipt(ok, AHORA), {});
    const p = r.receiptPayload({ ...ok, proveedor: " Andina ", referencia: "" }, 3);
    assert.deepEqual(p, {
      sucursal_id: 3, fecha_recepcion: `${ok.fecha}:00-04:00`, proveedor: "Andina", referencia: null, notas: null,
      items: [{ producto_id: 1, talla_id: 2, color_id: 3, cantidad: 5 }],
    });
  });

  it("fecha futura o vacía, línea incompleta, cantidad inválida y variante repetida", () => {
    assert.ok(r.validateReceipt({ ...ok, fecha: "2026-10-26T12:00" }, AHORA).fecha, "una hora en el futuro");
    assert.ok(r.validateReceipt({ ...ok, fecha: "" }, AHORA).fecha);
    const incompleta = { ...ok, lineas: [{ ...ok.lineas[0], colorId: "" }] };
    assert.match(r.validateReceipt(incompleta, AHORA).a, /elige modelo, talla y color/);
    for (const c of ["0", "-1", "1.5", ""]) assert.ok(r.validateReceipt({ ...ok, lineas: [{ ...ok.lineas[0], cantidad: c }] }, AHORA).a, c);
    const repetida = { ...ok, lineas: [ok.lineas[0], { ...ok.lineas[0], key: "b" }] };
    assert.match(r.validateReceipt(repetida, AHORA).b, /ya está en la lista/);
  });

  it("total de unidades y líneas nuevas con clave única", () => {
    const f = { ...ok, lineas: [ok.lineas[0], { ...ok.lineas[0], key: "b", tallaId: "9", cantidad: "3" }] };
    assert.equal(r.totalUnits(f), 8);
    assert.notEqual(r.emptyLine().key, r.emptyLine().key);
  });
});

describe("textos de lotes y ubicaciones", () => {
  it("días: fecha desconocida nunca se inventa", () => {
    assert.equal(r.daysText(null), "Fecha desconocida");
    assert.equal(r.daysText(0), "Menos de 1 día");
    assert.equal(r.daysText(1), "1 día");
    assert.equal(r.daysText(12), "12 días");
  });
  it("cada estado de lote tiene texto y estilo", () => {
    for (const k of ["en_stock", "parcialmente_vendido", "en_transito", "traspasado", "agotado"]) {
      assert.ok(r.LOT_STATE_TEXT[k] && r.LOT_STATE_CLASS[k], k);
    }
  });
  it("ya no se muestra MISSI BOLIVIA como ubicación y la fecha de ingreso es numérica", () => {
    assert.equal(u.branchLabel({ nombre: "Almacén Central", es_almacen: true }), "Almacén Central");
    assert.equal(u.TODAS_LAS_UBICACIONES, "Todas las ubicaciones");
    const f = (iso) => `fmt(${iso})`;
    assert.equal(r.entryText({ fecha: "2026-10-26T22:07:00Z", registrado: null, lotes: 1 }, f), "Ingresó fmt(2026-10-26T22:07:00Z)");
    assert.match(r.entryText({ fecha: "2026-10-26T22:07:00Z", registrado: null, lotes: 3 }, f), /\+2 lotes/);
    assert.match(r.entryText({ fecha: null, registrado: "2026-10-19T00:29:00Z", lotes: 1 }, f), /fecha desconocida · registrado en el sistema/);
    assert.equal(r.entryText(null, f), "");
  });
});
