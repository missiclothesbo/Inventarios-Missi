// Pruebas de devoluciones, cambios y anulaciones en el frontend: cálculos, validaciones y flujo de revisión.
// Lógica pura, sin red. Ejecutar: npm run test:unit
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as o from "../src/lib/operacionesFlow.ts";

const line = (id, over = {}) => ({
  detalle_id: id, producto_id: 1, talla_id: 1, color_id: 1, producto: "Palazzo", talla: "M", color: "Negro",
  cantidad: 3, precio_unitario: 135, devuelta: 0, pendiente: 3, ...over,
});
const lines = [line(10), line(11, { producto_id: 2, precio_unitario: 90, cantidad: 2, pendiente: 2, talla: "S", color: "Beige" })];
const precio = (id) => (id === 1 ? 135 : id === 2 ? 90 : 0);
const stockOk = () => 99;

describe("cálculos", () => {
  it("valor devuelto = cantidades marcadas × precio ORIGINAL de la venta", () => {
    const f = { ...o.emptyOp("devolucion"), motivoCodigo: "OTRO", motivo: "x", devolver: { 10: { cantidad: "1", condicion: "vendible" }, 11: { cantidad: "2", condicion: "danado" } } };
    assert.equal(o.valorDevuelto(lines, f), 135 + 2 * 90);
  });

  it("anulación devuelve todo lo pendiente, no lo ya devuelto", () => {
    const parcial = [line(10, { devuelta: 2, pendiente: 1 }), line(11, { pendiente: 2, precio_unitario: 90 })];
    assert.equal(o.valorDevuelto(parcial, o.emptyOp("anulacion"), true), 135 + 180);
  });

  it("diferencia: positiva = el cliente paga; negativa = se le debe; cero = sin pago", () => {
    assert.equal(o.diferencia(135, 200), 65);
    assert.equal(o.diferencia(135, 100), -35);
    assert.equal(o.diferencia(135, 135), 0);
    assert.equal(o.liquidacionFor(65), "cobro");
    assert.equal(o.liquidacionFor(-35), "reembolso");
    assert.equal(o.liquidacionFor(0), "none");
  });

  it("el reemplazo usa el precio del modelo si no se escribe otro", () => {
    const f = { ...o.emptyOp("cambio"), reemplazos: [{ producto_id: "2", talla_id: "1", color_id: "1", cantidad: "2", precio: "" }] };
    assert.equal(o.valorEntregado(f, precio), 180);
    const g = { ...f, reemplazos: [{ ...f.reemplazos[0], precio: "200" }] };
    assert.equal(o.valorEntregado(g, precio), 400);
  });
});

describe("validación", () => {
  it("devolución válida no tiene errores", () => {
    const f = { ...o.emptyOp("devolucion"), motivoCodigo: "OTRO", motivo: "talla", devolver: { 10: { cantidad: "1", condicion: "vendible" } }, liquidacion: "credito" };
    assert.deepEqual(o.validateOp(lines, f, precio, stockOk), {});
  });

  it("exige motivo y al menos una cantidad", () => {
    const e = o.validateOp(lines, o.emptyOp("devolucion"), precio, stockOk);
    assert.ok(e.motivoCodigo);
    assert.ok(e.items);
  });

  it("no permite devolver más de lo pendiente (por línea)", () => {
    const f = { ...o.emptyOp("devolucion"), motivoCodigo: "OTRO", motivo: "x", devolver: { 10: { cantidad: "4", condicion: "vendible" } } };
    assert.match(o.validateOp(lines, f, precio, stockOk)["cantidad_10"], /Solo quedan 3/);
  });

  it("cambio: exige reemplazo completo, precio válido y stock suficiente en la sucursal", () => {
    const base = { ...o.emptyOp("cambio"), motivoCodigo: "OTRO", motivo: "x", devolver: { 10: { cantidad: "1", condicion: "vendible" } } };
    assert.ok(o.validateOp(lines, base, precio, stockOk)["reemplazo_0"], "sin reemplazo");
    const sinPrecio = { ...base, reemplazos: [{ producto_id: "3", talla_id: "1", color_id: "1", cantidad: "1", precio: "" }] };
    assert.ok(o.validateOp(lines, sinPrecio, precio, stockOk)["reemplazo_precio_0"], "modelo sin precio");
    const sinStock = { ...base, reemplazos: [{ producto_id: "1", talla_id: "2", color_id: "1", cantidad: "5", precio: "" }] };
    assert.match(o.validateOp(lines, sinStock, precio, () => 1)["reemplazo_cantidad_0"], /Disponible: 1/);
  });

  it("cobro (diferencia > 0) exige método de pago", () => {
    const f = { ...o.emptyOp("cambio"), motivoCodigo: "OTRO", motivo: "sube", devolver: { 10: { cantidad: "1", condicion: "vendible" } },
      reemplazos: [{ producto_id: "2", talla_id: "1", color_id: "1", cantidad: "1", precio: "200" }] };
    assert.ok(o.validateOp(lines, f, precio, stockOk).metodo);
    assert.equal(o.validateOp(lines, { ...f, metodo: "qr" }, precio, stockOk).metodo, undefined);
  });

  it("reembolso inmediato exige método; reembolso pendiente y crédito no", () => {
    const base = { ...o.emptyOp("devolucion"), motivoCodigo: "OTRO", motivo: "x", devolver: { 10: { cantidad: "1", condicion: "vendible" } } };
    assert.ok(o.validateOp(lines, { ...base, liquidacion: "reembolso_inmediato" }, precio, stockOk).metodo);
    assert.equal(o.validateOp(lines, { ...base, liquidacion: "reembolso_pendiente" }, precio, stockOk).metodo, undefined);
    assert.equal(o.validateOp(lines, { ...base, liquidacion: "credito" }, precio, stockOk).metodo, undefined);
  });

  it("anulación sin nada pendiente no se puede", () => {
    const hechas = [line(10, { pendiente: 0, devuelta: 3 })];
    assert.ok(o.validateOp(hechas, { ...o.emptyOp("anulacion"), motivoCodigo: "OTRO", motivo: "x" }, precio, stockOk).anulacion);
  });
});

describe("revisión", () => {
  it("muestra cada efecto antes de confirmar: stock, valores, acción y liquidación", () => {
    const f = { ...o.emptyOp("cambio"), motivoCodigo: "OTRO", motivo: "x", devolver: { 10: { cantidad: "1", condicion: "danado" } },
      reemplazos: [{ producto_id: "2", talla_id: "1", color_id: "1", cantidad: "1", precio: "" }] };
    const r = o.revisionOf(lines, f, precio);
    assert.equal(r.valorDevuelto, 135);
    assert.equal(r.valorEntregado, 90);
    assert.equal(r.diferencia, -45);
    assert.equal(r.accion, "Se le debe al cliente");
    assert.equal(r.liquidacion, "reembolso");
    assert.equal(r.devueltos[0].condicion, "danado");
  });
});

describe("flujo de pantalla", () => {
  it("nada se confirma sin revisar; el formulario queda bloqueado al revisar", () => {
    let s = o.opReducer(o.initialOp, { type: "elegirVenta", ventaId: 5 });
    s = o.opReducer(s, { type: "elegirModo", mode: "devolucion" });
    assert.equal(o.opReducer(s, { type: "confirmar" }), s, "confirmar sin revisar no hace nada");
    s = o.opReducer(s, { type: "editar", patch: { motivoCodigo: "OTRO", motivo: "x" } });
    s = o.opReducer(s, { type: "revisar", newKey: "k1" });
    assert.equal(s.step, "revisar");
    assert.equal(o.opReducer(s, { type: "editar", patch: { motivoCodigo: "OTRO", motivo: "otro" } }), s, "no se edita al revisar");
  });

  it("volver a editar conserva los valores y la clave", () => {
    let s = o.opReducer(o.initialOp, { type: "elegirVenta", ventaId: 5 });
    s = o.opReducer(s, { type: "elegirModo", mode: "cambio" });
    s = o.opReducer(s, { type: "editar", patch: { motivoCodigo: "OTRO", motivo: "talla", liquidacion: "credito" } });
    s = o.opReducer(s, { type: "revisar", newKey: "k1" });
    s = o.opReducer(s, { type: "volver" });
    assert.equal(s.step, "editar");
    assert.equal(s.form.motivo, "talla");
    assert.equal(s.form.liquidacion, "credito");
    assert.equal(s.key, "k1");
  });

  it("confirmar dos veces (doble clic) envía una sola vez", () => {
    let s = o.opReducer(o.initialOp, { type: "elegirVenta", ventaId: 5 });
    s = o.opReducer(s, { type: "elegirModo", mode: "anulacion" });
    s = o.opReducer(s, { type: "editar", patch: { motivoCodigo: "OTRO", motivo: "x" } });
    s = o.opReducer(s, { type: "revisar", newKey: "k1" });
    s = o.opReducer(s, { type: "confirmar" });
    assert.equal(s.step, "enviar");
    assert.equal(o.opReducer(s, { type: "confirmar" }), s);
  });

  it("fallo del servidor: vuelve a editar con los datos, con el error, y conserva la clave", () => {
    let s = o.opReducer(o.initialOp, { type: "elegirVenta", ventaId: 5 });
    s = o.opReducer(s, { type: "elegirModo", mode: "devolucion" });
    s = o.opReducer(s, { type: "editar", patch: { motivoCodigo: "OTRO", motivo: "x" } });
    s = o.opReducer(s, { type: "revisar", newKey: "k1" });
    s = o.opReducer(s, { type: "confirmar" });
    s = o.opReducer(s, { type: "fallo", message: "Stock insuficiente" });
    assert.equal(s.step, "editar", "sin éxito falso");
    assert.equal(s.serverError, "Stock insuficiente");
    assert.equal(s.form.motivo, "x");
    assert.equal(s.key, "k1");
  });

  it("éxito solo tras confirmar", () => {
    let s = o.opReducer(o.initialOp, { type: "elegirVenta", ventaId: 5 });
    s = o.opReducer(s, { type: "elegirModo", mode: "devolucion" });
    assert.equal(o.opReducer(s, { type: "exito" }), s, "no hay éxito antes de enviar");
  });

  it("editar invalida la clave: un cambio nunca reutiliza un intento anterior", () => {
    let s = o.opReducer(o.initialOp, { type: "elegirVenta", ventaId: 5 });
    s = o.opReducer(s, { type: "elegirModo", mode: "devolucion" });
    s = o.opReducer(s, { type: "editar", patch: { motivoCodigo: "OTRO", motivo: "x" } });
    s = o.opReducer(s, { type: "revisar", newKey: "k1" });
    s = o.opReducer(s, { type: "volver" });
    s = o.opReducer(s, { type: "editar", patch: { motivoCodigo: "OTRO", motivo: "y" } });
    assert.equal(s.key, null);
  });

  it("la sucursal de la venta no cambia con el selector: el flujo siempre trabaja con la venta elegida", () => {
    const s = o.opReducer(o.initialOp, { type: "elegirVenta", ventaId: 77 });
    assert.equal(s.ventaId, 77);
    assert.equal(o.opReducer(s, { type: "volverBuscar" }).ventaId, null);
  });
});
