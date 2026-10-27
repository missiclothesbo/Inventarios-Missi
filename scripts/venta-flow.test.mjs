// Pruebas del formulario de venta con carrito: validación, importes en centavos, entrega condicional,
// carga útil de UNA venta con varias líneas y flujo revisar → confirmar.
// Lógica pura (sin red ni React). Ejecutar: npm run test:unit
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as f from "../src/lib/ventaFlow.ts";
import { saleNumber, totalUnits } from "../src/lib/receipt.ts";

// Línea en construcción válida (modelo 1, talla 2, color 3, 2 u. a Bs 135).
const builder = { ...f.EMPTY_VENTA, productId: "1", sizeId: "2", colorId: "3", quantity: "2", unitPrice: "135" };
const line = (productId, sizeId, colorId, quantity, unitCents) => ({ productId, sizeId, colorId, quantity, unitCents });
// Venta lista: carrito con una línea y línea en construcción vacía.
const valid = { ...f.EMPTY_VENTA, cart: [line(1, 2, 3, 2, 13500)] };
const stock5 = { stockOf: () => 5 };

describe("importes en centavos enteros", () => {
  it("toCents acepta hasta 2 decimales (punto o coma) y rechaza el resto", () => {
    assert.equal(f.toCents("135"), 13500);
    assert.equal(f.toCents("99.5"), 9950);
    assert.equal(f.toCents("65,25"), 6525);
    assert.equal(f.toCents("0.1") + f.toCents("0.2"), 30, "0.1 + 0.2 = 0.30 exacto");
    for (const bad of ["", "abc", "-5", "1.234", "1e3", "12.", ".5"]) assert.equal(f.toCents(bad), null, bad);
  });

  it("subtotal de la línea en construcción = cantidad × precio", () => {
    assert.equal(f.subtotalOf({ ...builder, quantity: "3", unitPrice: "99.5" }), 298.5);
    assert.equal(f.subtotalOf({ ...builder, unitPrice: "" }), 0);
    assert.equal(f.subtotalOf({ ...builder, quantity: "1.5" }), 0);
  });

  it("sin errores de coma flotante en sumas de muchas líneas", () => {
    const cart = Array.from({ length: 10 }, (_, i) => line(1, 1, i + 1, 3, 1999)); // 3 × 19.99 por línea
    assert.equal(f.cartCents(cart), 10 * 3 * 1999);
    assert.equal(f.totalOf({ ...f.EMPTY_VENTA, cart }), 599.7);
  });
});

describe("validación de la línea (antes de agregar)", () => {
  it("una línea completa no tiene errores", () => {
    assert.deepEqual(f.validateLine(builder, 5), {});
  });

  it("pide modelo, talla y color", () => {
    const e = f.validateLine({ ...builder, productId: "", sizeId: "", colorId: "" }, 5);
    assert.ok(e.productId && e.sizeId && e.colorId);
  });

  it("cantidad: entero mayor que cero y no mayor al stock de la sucursal", () => {
    assert.match(f.validateLine({ ...builder, quantity: "0" }, 5).quantity, /mayor que cero/);
    assert.match(f.validateLine({ ...builder, quantity: "-2" }, 5).quantity, /mayor que cero/);
    assert.match(f.validateLine({ ...builder, quantity: "1.5" }, 5).quantity, /entero/);
    assert.match(f.validateLine({ ...builder, quantity: "abc" }, 5).quantity, /entero/);
    assert.match(f.validateLine({ ...builder, quantity: "6" }, 5).quantity, /Stock insuficiente. Disponible: 5/);
    assert.equal(f.validateLine({ ...builder, quantity: "5" }, 5).quantity, undefined);
  });

  it("el stock descuenta lo que ya está en el carrito para la misma variante", () => {
    const withCart = { ...builder, cart: [line(1, 2, 3, 4, 13500)], quantity: "2" };
    assert.match(f.validateLine(withCart, 5).quantity, /ya tienes 4 en la venta/);
    assert.equal(f.validateLine({ ...withCart, quantity: "1" }, 5).quantity, undefined);
  });

  it("precio obligatorio, mayor que cero y con máximo 2 decimales", () => {
    for (const bad of ["", "0", "-3", "abc", "1.999"]) assert.ok(f.validateLine({ ...builder, unitPrice: bad }, 5).unitPrice, bad);
    assert.equal(f.validateLine({ ...builder, unitPrice: "0.5" }, 5).unitPrice, undefined);
  });
});

describe("validación de la venta completa", () => {
  it("una venta con carrito y datos válidos no tiene errores", () => {
    assert.deepEqual(f.validateVenta(valid, stock5), {});
  });

  it("carrito vacío: 'Agrega al menos un producto a la venta.'", () => {
    assert.equal(f.validateVenta(f.EMPTY_VENTA, stock5).cart, "Agrega al menos un producto a la venta.");
  });

  it("cada línea se valida contra el stock; el mensaje nombra el producto", () => {
    const cart = [line(1, 2, 3, 2, 13500), line(2, 1, 1, 9, 6500)];
    const e = f.validateVenta(
      { ...f.EMPTY_VENTA, cart },
      { stockOf: (l) => (l.productId === 1 ? 5 : 3), labelOf: (l) => `Modelo ${l.productId}` },
    );
    assert.match(e.cart, /Stock insuficiente para Modelo 2/);
    assert.match(e.cart, /Disponible: 3; en la venta: 9/);
  });

  it("cantidad cero o precio cero en el carrito se rechazan", () => {
    assert.match(f.validateVenta({ ...f.EMPTY_VENTA, cart: [line(1, 1, 1, 0, 100)] }, stock5).cart, /mayor que cero/);
    assert.match(f.validateVenta({ ...f.EMPTY_VENTA, cart: [line(1, 1, 1, 1, 0)] }, stock5).cart, /precio/);
  });

  it("un producto elegido por completo pero sin agregar se avisa (no se pierde en silencio)", () => {
    const e = f.validateVenta({ ...valid, productId: "4", sizeId: "1", colorId: "1" }, stock5);
    assert.match(e.cart, /sin agregar/);
    // un modelo a medio elegir (sin talla/color) no bloquea
    assert.equal(f.validateVenta({ ...valid, productId: "4" }, stock5).cart, undefined);
  });

  it("descripción y nombre con límite de largo; la descripción es opcional", () => {
    assert.ok(f.validateVenta({ ...valid, notes: "x".repeat(301) }, stock5).notes);
    assert.ok(f.validateVenta({ ...valid, customerName: "x".repeat(121) }, stock5).customerName);
    assert.equal(f.validateVenta({ ...valid, notes: "" }, stock5).notes, undefined);
  });

  it("cliente opcional: una venta sin nombre ni teléfono es válida", () => {
    assert.deepEqual(f.validateVenta({ ...valid, customerName: "", customerPhone: "" }, stock5), {});
  });

  it("teléfono opcional; si se escribe, exactamente 8 dígitos", () => {
    assert.equal(f.validateVenta({ ...valid, customerPhone: "" }, stock5).customerPhone, undefined);
    assert.equal(f.validateVenta({ ...valid, customerPhone: "07123456" }, stock5).customerPhone, undefined);
    assert.match(f.validateVenta({ ...valid, customerPhone: "7123456" }, stock5).customerPhone, /8 dígitos/);
    assert.match(f.validateVenta({ ...valid, customerPhone: "7123456a" }, stock5).customerPhone, /solo acepta números/);
  });
});

describe("carrito: agregar, fusionar, cambiar cantidad, quitar, vaciar", () => {
  const add = (state, patch, stock = 10) => {
    let s = f.flowReducer(state, { type: "editar", patch });
    s = f.flowReducer(s, { type: "agregar", availableStock: stock });
    return s;
  };
  const sel = (p, t, c, q, price) => ({ productId: String(p), sizeId: String(t), colorId: String(c), quantity: String(q), unitPrice: String(price) });

  it("EJEMPLO María: 1 palazzo (120) + 1 pantalón con hebilla (135) + 2 shorts (65) = 3 líneas, 4 unidades, Bs 385", () => {
    let s = f.initialFlow();
    s = add(s, sel(1, 1, 1, 1, 120));
    s = add(s, sel(2, 1, 1, 1, 135));
    s = add(s, sel(3, 1, 1, 2, 65));
    assert.equal(s.form.cart.length, 3, "tres líneas distintas");
    assert.equal(f.cartUnits(s.form.cart), 4);
    assert.equal(f.totalOf(s.form), 385);
    assert.deepEqual(s.form.cart.map(f.lineCents), [12000, 13500, 13000]);
    // la línea en construcción queda limpia para el siguiente producto
    assert.equal(s.form.productId, "");
    assert.equal(s.form.unitPrice, "");
    assert.equal(s.form.quantity, "1");
  });

  it("agregar conserva el pago, la entrega y el cliente (se capturan una sola vez)", () => {
    let s = f.flowReducer(f.initialFlow(), { type: "editar", patch: { payment: "QR", customerName: "María", customerPhone: "71234567", mode: "envio", department: "La Paz" } });
    s = add(s, sel(1, 1, 1, 1, 120));
    s = add(s, sel(2, 1, 1, 1, 135));
    assert.equal(s.form.payment, "QR");
    assert.equal(s.form.customerName, "María");
    assert.equal(s.form.department, "La Paz");
  });

  it("la misma variante con el mismo precio se fusiona en una línea (sin duplicados)", () => {
    let s = add(f.initialFlow(), sel(1, 1, 1, 1, 120));
    s = add(s, sel(1, 1, 1, 2, 120));
    assert.equal(s.form.cart.length, 1);
    assert.equal(s.form.cart[0].quantity, 3);
  });

  it("variantes distintas (otra talla o color) son líneas distintas", () => {
    let s = add(f.initialFlow(), sel(1, 1, 1, 1, 120));
    s = add(s, sel(1, 2, 1, 1, 120));
    s = add(s, sel(1, 1, 2, 1, 120));
    assert.equal(s.form.cart.length, 3);
  });

  it("la misma variante con OTRO precio no cambia el precio en silencio: error y carrito intacto", () => {
    let s = add(f.initialFlow(), sel(1, 1, 1, 1, 120));
    s = add(s, sel(1, 1, 1, 1, 100));
    assert.equal(s.form.cart.length, 1);
    assert.equal(s.form.cart[0].unitCents, 12000);
    assert.equal(s.form.cart[0].quantity, 1);
    assert.match(s.errors.unitPrice, /ya está en la venta a Bs 120.00/);
  });

  it("agregar con stock insuficiente o datos inválidos no toca el carrito", () => {
    let s = add(f.initialFlow(), sel(1, 1, 1, 5, 120), 3);
    assert.equal(s.form.cart.length, 0);
    assert.match(s.errors.quantity, /Stock insuficiente. Disponible: 3/);
    s = add(f.initialFlow(), sel(1, 1, 1, 0, 120));
    assert.equal(s.form.cart.length, 0);
    s = add(f.initialFlow(), sel(1, 1, 1, 1, 0));
    assert.equal(s.form.cart.length, 0);
    assert.ok(s.errors.unitPrice);
  });

  it("cambiar cantidad recalcula el subtotal y el total al instante; mínimo 1", () => {
    let s = add(f.initialFlow(), sel(1, 1, 1, 1, 120));
    s = add(s, sel(2, 1, 1, 1, 135));
    const key = f.lineKey(s.form.cart[1]);
    s = f.flowReducer(s, { type: "cantidad", key, quantity: 3 });
    assert.equal(s.form.cart[1].quantity, 3);
    assert.equal(f.totalOf(s.form), 120 + 405);
    s = f.flowReducer(s, { type: "cantidad", key, quantity: 0 });
    assert.equal(s.form.cart[1].quantity, 1, "nunca baja de 1: para quitar se usa 'quitar'");
    assert.equal(f.flowReducer(s, { type: "cantidad", key, quantity: Number.NaN }), s);
  });

  it("quitar una línea recalcula el total; quitar la última deja el carrito vacío", () => {
    let s = add(f.initialFlow(), sel(1, 1, 1, 1, 120));
    s = add(s, sel(2, 1, 1, 2, 65));
    s = f.flowReducer(s, { type: "quitar", key: f.lineKey(s.form.cart[0]) });
    assert.equal(s.form.cart.length, 1);
    assert.equal(f.totalOf(s.form), 130);
    s = f.flowReducer(s, { type: "quitar", key: f.lineKey(s.form.cart[0]) });
    assert.equal(s.form.cart.length, 0);
    assert.equal(f.totalOf(s.form), 0);
  });

  it("vaciar deja el carrito en blanco y conserva pago/cliente", () => {
    let s = f.flowReducer(f.initialFlow(), { type: "editar", patch: { customerName: "María" } });
    s = add(s, sel(1, 1, 1, 1, 120));
    s = f.flowReducer(s, { type: "vaciar" });
    assert.equal(s.form.cart.length, 0);
    assert.equal(s.form.customerName, "María");
  });

  it("cualquier cambio del carrito borra la clave de idempotencia (nunca reutiliza un intento previo)", () => {
    let s = add(f.initialFlow(), sel(1, 1, 1, 1, 120));
    s = f.flowReducer(s, { type: "revisar", errors: {}, newKey: "k1", branchId: 1 });
    s = f.flowReducer(s, { type: "volver" });
    assert.equal(s.key, "k1");
    s = add(s, sel(2, 1, 1, 1, 135));
    assert.equal(s.key, null);
    s = f.flowReducer(s, { type: "revisar", errors: {}, newKey: "k2", branchId: 1 });
    s = f.flowReducer(s, { type: "volver" });
    s = f.flowReducer(s, { type: "cantidad", key: f.lineKey(s.form.cart[0]), quantity: 2 });
    assert.equal(s.key, null);
  });

  it("el carrito no se puede modificar durante la revisión ni el envío", () => {
    let s = add(f.initialFlow(), sel(1, 1, 1, 1, 120));
    s = f.flowReducer(s, { type: "revisar", errors: {}, newKey: "k1", branchId: 1 });
    for (const ev of [
      { type: "quitar", key: f.lineKey(s.form.cart[0]) },
      { type: "cantidad", key: f.lineKey(s.form.cart[0]), quantity: 9 },
      { type: "vaciar" },
      { type: "agregar", availableStock: 9 },
    ]) assert.equal(f.flowReducer(s, ev), s, ev.type);
    const sending = f.flowReducer(s, { type: "confirmar" });
    assert.equal(f.flowReducer(sending, { type: "vaciar" }), sending);
  });
});

describe("entrega condicional", () => {
  it("entrega directa no exige destino", () => {
    const e = f.validateVenta({ ...valid, mode: "entrega_directa", department: "", province: "" }, stock5);
    assert.equal(e.department, undefined);
    assert.equal(e.province, undefined);
  });

  it("envío a departamento exige el departamento (el error va en department)", () => {
    const e = f.validateVenta({ ...valid, mode: "envio", department: "" }, stock5);
    assert.match(e.department, /departamento/);
    assert.equal(f.validateVenta({ ...valid, mode: "envio", department: "La Paz" }, stock5).department, undefined);
  });

  it("interprovincial exige provincia (texto) y NO exige departamento", () => {
    const e = f.validateVenta({ ...valid, mode: "envio_interprovincial", province: "", department: "" }, stock5);
    assert.match(e.province, /provincia/);
    assert.equal(e.department, undefined);
    assert.deepEqual(f.validateVenta({ ...valid, mode: "envio_interprovincial", province: "Nor Chichas" }, stock5), {});
  });

  it("cambiar de método borra los campos que ya no aplican (y conserva el carrito)", () => {
    const withDept = { ...valid, mode: "envio", department: "Potosí", province: "" };
    const toInter = f.changeDelivery(withDept, "envio_interprovincial");
    assert.equal(toInter.department, "", "interprovincial no conserva departamento");
    assert.equal(toInter.cart.length, 1);
    const toDirect = f.changeDelivery({ ...valid, mode: "envio_interprovincial", province: "Omasuyos" }, "entrega_directa");
    assert.equal(toDirect.province, "");
    assert.equal(toDirect.department, "");
    const toEnvio = f.changeDelivery({ ...valid, mode: "envio_interprovincial", province: "Omasuyos", department: "" }, "envio");
    assert.equal(toEnvio.province, "", "envío no conserva provincia");
  });

  it("la carga útil no lleva datos obsoletos del otro método", () => {
    const p1 = f.buildSalePayload({ ...valid, mode: "envio", department: "La Paz", province: "Omasuyos" }, 1, "k");
    assert.equal(p1.departamento, "La Paz");
    assert.equal(p1.provincia, "");
    const p2 = f.buildSalePayload({ ...valid, mode: "envio_interprovincial", department: "La Paz", province: "Omasuyos" }, 1, "k");
    assert.equal(p2.departamento, "");
    assert.equal(p2.provincia, "Omasuyos");
    const p3 = f.buildSalePayload({ ...valid, mode: "entrega_directa", department: "La Paz", province: "Omasuyos" }, 1, "k");
    assert.equal(p3.departamento, "");
    assert.equal(p3.provincia, "");
  });
});

describe("carga útil de UNA venta con varias líneas", () => {
  it("una sola petición con todas las líneas, sucursal, cliente y clave de idempotencia", () => {
    const form = {
      ...f.EMPTY_VENTA,
      cart: [line(1, 1, 1, 1, 12000), line(2, 1, 1, 1, 13500), line(3, 1, 1, 2, 6500)],
      notes: "  regalo  ",
      customerName: " María ",
      customerPhone: "07123456",
    };
    const p = f.buildSalePayload(form, 9, "abc");
    assert.equal(p.sucursal_id, 9);
    assert.equal(p.idempotency_key, "abc");
    assert.deepEqual(p.items, [
      { producto_id: 1, talla_id: 1, color_id: 1, cantidad: 1, precio_unitario: 120 },
      { producto_id: 2, talla_id: 1, color_id: 1, cantidad: 1, precio_unitario: 135 },
      { producto_id: 3, talla_id: 1, color_id: 1, cantidad: 2, precio_unitario: 65 },
    ]);
    assert.equal(p.observaciones, "regalo");
    assert.equal(p.cliente_nombre, "María");
    assert.equal(p.cliente_telefono, "07123456", "teléfono como texto");
    assert.equal(p.metodo_pago, "efectivo");
    assert.equal("total" in p, false, "el total lo calcula el servidor: el cliente no lo envía");
  });

  it("no envía la línea en construcción, solo el carrito", () => {
    const p = f.buildSalePayload({ ...valid, productId: "9", sizeId: "9", colorId: "9" }, 1, "k");
    assert.equal(p.items.length, 1);
  });
});

describe("número de venta y unidades", () => {
  it("formato V-000123", () => {
    assert.equal(saleNumber(123), "V-000123");
    assert.equal(saleNumber(7), "V-000007");
    assert.equal(saleNumber(1234567), "V-1234567");
  });
  it("total de unidades = suma de cantidades", () => {
    assert.equal(totalUnits([{ cantidad: 1 }, { cantidad: 1 }, { cantidad: 2 }]), 4);
  });
});

const receipt = { id: 7, items: [], total: 270, fecha: "2026-10-19T03:00:00Z", repetida: false };

describe("flujo: revisar antes de guardar, volver a editar y confirmar", () => {
  const edited = () => f.flowReducer(f.initialFlow(), { type: "editar", patch: valid });

  it("con errores no pasa a revisión", () => {
    const s = f.flowReducer(f.initialFlow(), { type: "revisar", errors: { cart: "x" }, newKey: "k1", branchId: 1 });
    assert.equal(s.step, "editando");
    assert.equal(s.errors.cart, "x");
  });

  it("válido pasa a revisión SIN guardar: no hay envío ni confirmación", () => {
    const s = f.flowReducer(edited(), { type: "revisar", errors: {}, newKey: "k1", branchId: 1 });
    assert.equal(s.step, "revisando");
    assert.equal(s.key, "k1");
    assert.equal(s.branchId, 1);
  });

  it("VOLVER A EDITAR conserva el carrito, los valores y la clave", () => {
    let s = f.flowReducer(f.initialFlow(), { type: "editar", patch: { ...valid, notes: "nota", customerPhone: "71234567" } });
    s = f.flowReducer(s, { type: "revisar", errors: {}, newKey: "k1", branchId: 1 });
    s = f.flowReducer(s, { type: "volver" });
    assert.equal(s.step, "editando");
    assert.equal(s.form.notes, "nota");
    assert.equal(s.form.customerPhone, "71234567");
    assert.equal(s.form.cart.length, 1);
    assert.equal(s.key, "k1", "sin cambios, el reintento sigue siendo la misma venta");
  });

  it("editar tras volver borra la clave: un cambio nunca reutiliza un intento anterior", () => {
    let s = f.flowReducer(edited(), { type: "revisar", errors: {}, newKey: "k1", branchId: 1 });
    s = f.flowReducer(s, { type: "volver" });
    s = f.flowReducer(s, { type: "editar", patch: { notes: "otra" } });
    assert.equal(s.key, null);
  });

  it("confirmar pasa a enviando; un segundo confirmar (doble clic) no hace nada", () => {
    const s = f.flowReducer(edited(), { type: "revisar", errors: {}, newKey: "k1", branchId: 1 });
    const sending = f.flowReducer(s, { type: "confirmar" });
    assert.equal(sending.step, "enviando");
    assert.equal(f.flowReducer(sending, { type: "confirmar" }), sending);
  });

  it("éxito muestra el recibo confirmado; nunca antes", () => {
    let s = f.flowReducer(edited(), { type: "revisar", errors: {}, newKey: "k1", branchId: 1 });
    assert.equal(s.step, "revisando", "todavía no hay recibo");
    s = f.flowReducer(s, { type: "confirmar" });
    assert.equal(s.step, "enviando", "todavía no hay éxito");
    s = f.flowReducer(s, { type: "exito", receipt });
    assert.equal(s.step, "confirmada");
    assert.equal(s.receipt.id, 7);
  });

  it("fallo del API: vuelve a editar con TODO el carrito intacto, con mensaje, sin éxito falso", () => {
    let s = f.flowReducer(f.initialFlow(), { type: "editar", patch: { ...valid, cart: [line(1, 2, 3, 2, 13500), line(4, 1, 1, 1, 6500)] } });
    s = f.flowReducer(s, { type: "revisar", errors: {}, newKey: "k1", branchId: 1 });
    s = f.flowReducer(s, { type: "confirmar" });
    s = f.flowReducer(s, { type: "fallo", message: "Stock insuficiente." });
    assert.equal(s.step, "editando");
    assert.equal(s.serverError, "Stock insuficiente.");
    assert.equal(s.form.cart.length, 2, "el carrito NO se vacía tras un fallo");
    assert.equal(s.form.cart[0].quantity, 2);
    assert.equal(s.key, "k1", "reintento con la misma clave: no se duplica si el primer envío sí llegó");
  });

  it("la sucursal se fija al revisar: cambiar de sucursal después no mueve la venta", () => {
    let s = f.flowReducer(edited(), { type: "revisar", errors: {}, newKey: "k1", branchId: 1 });
    s = f.flowReducer(s, { type: "confirmar" });
    assert.equal(s.branchId, 1);
    s = f.flowReducer(s, { type: "fallo", message: "x" });
    s = f.flowReducer(s, { type: "editar", patch: { notes: "y" } });
    s = f.flowReducer(s, { type: "revisar", errors: {}, newKey: "k2", branchId: 2 });
    assert.equal(s.branchId, 2, "la nueva revisión usa la sucursal elegida en ese momento");
  });

  it("en revisión el formulario no se puede editar", () => {
    const s = f.flowReducer(edited(), { type: "revisar", errors: {}, newKey: "k1", branchId: 1 });
    assert.equal(f.flowReducer(s, { type: "editar", patch: { notes: "9" } }), s);
  });

  it("NUEVA VENTA reinicia el formulario y el carrito", () => {
    let s = f.flowReducer(edited(), { type: "revisar", errors: {}, newKey: "k1", branchId: 1 });
    s = f.flowReducer(s, { type: "confirmar" });
    s = f.flowReducer(s, { type: "exito", receipt });
    s = f.flowReducer(s, { type: "nueva" });
    assert.equal(s.step, "editando");
    assert.equal(s.form.cart.length, 0);
    assert.equal(s.form.productId, "");
    assert.equal(s.key, null);
  });
});
