// Pruebas unitarias del frontend (sin navegador): reglas de venta, teléfono, entrega, fotos y formato del recibo.
// Ejecutar: npm run test:unit   (Node 24 ejecuta los .ts importados directamente)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as v from "../src/lib/validation.ts";
import * as r from "../src/lib/receipt.ts";

describe("teléfono: 8 dígitos numéricos", () => {
  it("vacío es válido (opcional); 8 dígitos conservan el cero inicial", () => {
    assert.equal(v.phoneError(""), null);
    assert.equal(v.phoneError("07123456"), null);
    assert.equal(v.phoneError("71234567"), null);
  });
  it("rechaza 7 y 9 dígitos, letras, espacios, signos y símbolos", () => {
    assert.match(v.phoneError("1234567"), /exactamente 8/);
    assert.match(v.phoneError("123456789"), /exactamente 8/);
    for (const bad of ["7123 456", "+59171234567", "7123-456", "7123456a", "abcdefgh", "(7123456", "71234567."]) {
      assert.match(v.phoneError(bad), /solo acepta números/, bad);
    }
  });
  it("digitsOnly solo sirve para texto ya validado; corta a 8", () => {
    assert.equal(v.digitsOnly("0712-3456789"), "07123456");
    assert.equal(v.hasNonDigits("71a"), true);
    assert.equal(v.hasNonDigits("71234567"), false);
  });
  it("el teléfono se trata como texto (no como número)", () => {
    assert.equal(typeof v.phoneError("07123456"), "object");
    assert.equal(v.phoneError("07123456"), null);
  });
});

describe("entrega según método", () => {
  it("envío exige departamento y nada más", () => {
    assert.match(v.deliveryError("envio", { department: "", province: "x" }), /departamento/);
    assert.equal(v.deliveryError("envio", { department: "La Paz", province: "" }), null);
  });
  it("interprovincial exige provincia (texto) y nada más", () => {
    assert.match(v.deliveryError("envio_interprovincial", { department: "Potosí", province: "  " }), /provincia/);
    assert.equal(v.deliveryError("envio_interprovincial", { department: "", province: "Nor Chichas" }), null);
  });
  it("entrega directa no pide nada", () => {
    assert.equal(v.deliveryError("entrega_directa", { department: "", province: "" }), null);
  });
  it("solo viaja lo del método elegido (no datos obsoletos)", () => {
    assert.deepEqual(v.deliveryPayload("envio", { department: " Santa Cruz ", province: "Nor Chichas" }), { departamento: "Santa Cruz", provincia: "" });
    assert.deepEqual(v.deliveryPayload("envio_interprovincial", { department: "La Paz", province: " Omasuyos " }), { departamento: "", provincia: "Omasuyos" });
    assert.deepEqual(v.deliveryPayload("entrega_directa", { department: "La Paz", province: "Omasuyos" }), { departamento: "", provincia: "" });
  });
});

describe("fotos: tipo y tamaño antes de subir", () => {
  const file = (type, size) => ({ type, size });
  it("acepta JPG, PNG y WebP hasta 2 MB", () => {
    for (const t of ["image/jpeg", "image/png", "image/webp"]) assert.equal(v.photoFileError(file(t, 1000)), null, t);
    assert.equal(v.photoFileError(file("image/jpeg", 2 * 1024 * 1024)), null);
  });
  it("rechaza otros tipos, archivos vacíos y los de más de 2 MB", () => {
    assert.match(v.photoFileError(file("image/gif", 1000)), /JPG, PNG o WebP/);
    assert.match(v.photoFileError(file("image/png", 0)), /vacía/);
    assert.match(v.photoFileError(file("image/png", 2 * 1024 * 1024 + 1)), /2 MB/);
  });
});

describe("recibo", () => {
  const items = [
    { producto: "Palazzo", talla: "M", color: "Negro", cantidad: 2, precio_unitario: 135, subtotal: 270 },
    { producto: "Short", talla: "36", color: "Beige", cantidad: 1, precio_unitario: 90.5, subtotal: 90.5 },
  ];
  it("la hora se muestra en Bolivia aunque el equipo esté en otra zona (02:30 UTC = 22:30 del día anterior)", () => {
    const text = r.formatBoliviaDateTime("2026-10-10T02:30:00Z");
    assert.match(text, /09\/10\/2026/);
    assert.match(text, /22:30/);
  });
  it("el total del recibo cuadra con la suma de las líneas", () => {
    assert.equal(r.receiptTotal(items), 360.5);
  });
  it("texto de entrega: vacío en entrega directa; departamento o provincia en envíos", () => {
    assert.equal(r.deliveryText({ modalidad: "entrega_directa", departamento: null, provincia: null }), "");
    assert.equal(r.deliveryText({ modalidad: "envio", departamento: "La Paz", provincia: null }), "Departamento: La Paz");
    assert.equal(
      r.deliveryText({ modalidad: "envio_interprovincial", departamento: null, provincia: "Nor Chichas" }),
      "Provincia: Nor Chichas",
    );
  });
  it("formato de montos con dos decimales y prefijo Bs", () => {
    assert.equal(r.money(270), "Bs 270.00");
    assert.equal(r.money(90.5), "Bs 90.50");
  });
});
