/**
 * Flujo de una venta en un solo formulario. Lógica pura (sin React ni red), probada en Node.
 *
 *   editando --REALIZAR VENTA (válido)--> revisando --CONFIRMAR--> enviando --éxito--> confirmada
 *                                              |                        |
 *                                         VOLVER A EDITAR          fallo (vuelve a editando, datos intactos)
 *
 * Una venta puede tener VARIAS líneas (carrito): el vendedor arma una línea (modelo, talla, color, cantidad,
 * precio), la agrega al carrito y repite con otros productos. Se guarda UNA sola venta con todas las líneas.
 * Los importes se calculan en centavos enteros (sin errores de coma flotante).
 *
 * No se guarda nada hasta confirmar. Editar limpia la clave de idempotencia para que un cambio
 * nunca reutilice el registro de un intento anterior.
 */
import { deliveryError, deliveryPayload, phoneError, type DeliveryMode } from "./validation.ts";
import type { SaleReceipt } from "./receipt.ts";

export type PaymentChoice = "efectivo" | "QR";

/** Una línea del carrito. El precio se guarda en centavos enteros. */
export interface CartLine {
  productId: number;
  sizeId: number;
  colorId: number;
  quantity: number;
  unitCents: number;
}

export interface VentaForm {
  /** Líneas ya agregadas a la venta. */
  cart: CartLine[];
  // Línea en construcción (aún no agregada al carrito):
  productId: string;
  sizeId: string;
  colorId: string;
  quantity: string;
  unitPrice: string;
  // Datos de la venta (se capturan una sola vez):
  notes: string;
  payment: PaymentChoice;
  mode: DeliveryMode;
  department: string;
  province: string;
  customerName: string;
  customerPhone: string;
}

export type FormField = keyof VentaForm;
export type FormErrors = Partial<Record<FormField, string>>;

export const EMPTY_VENTA: VentaForm = {
  cart: [],
  productId: "",
  sizeId: "",
  colorId: "",
  quantity: "1",
  unitPrice: "",
  notes: "",
  payment: "efectivo",
  mode: "entrega_directa",
  department: "",
  province: "",
  customerName: "",
  customerPhone: "",
};

export const NOTES_MAX = 300;
export const NAME_MAX = 120;

/** Cambiar de método borra los campos que ya no aplican, para que nunca viajen datos obsoletos. */
export function changeDelivery(form: VentaForm, mode: DeliveryMode): VentaForm {
  if (mode === "entrega_directa") return { ...form, mode, department: "", province: "" };
  if (mode === "envio") return { ...form, mode, province: "" };
  return { ...form, mode, department: "" }; // interprovincial: solo provincia (texto)
}

// ----------------------------------------------------------------- dinero (centavos enteros)

/** "135", "135.5", "135,50" → centavos. null si no es un importe válido (máximo 2 decimales). */
export function toCents(text: string): number | null {
  const clean = text.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

type VariantRef = Pick<CartLine, "productId" | "sizeId" | "colorId">;

export const lineKey = (l: VariantRef) => `${l.productId}-${l.sizeId}-${l.colorId}`;
export const lineCents = (l: CartLine) => l.quantity * l.unitCents;
export const cartCents = (cart: CartLine[]) => cart.reduce((sum, l) => sum + lineCents(l), 0);
export const cartUnits = (cart: CartLine[]) => cart.reduce((sum, l) => sum + l.quantity, 0);
export const fromCents = (cents: number) => cents / 100;

/** Subtotal de la línea en construcción (0 si cantidad o precio no son válidos). */
export function subtotalOf(form: VentaForm): number {
  const qty = Number(form.quantity);
  const cents = toCents(form.unitPrice);
  if (!Number.isInteger(qty) || qty <= 0 || cents === null) return 0;
  return fromCents(qty * cents);
}

/** Total de la venta = suma de los subtotales de todas las líneas del carrito. */
export function totalOf(form: VentaForm): number {
  return fromCents(cartCents(form.cart));
}

/** Cantidad ya reservada en el carrito para una variante. */
export function inCart(cart: CartLine[], key: string): number {
  return cart.filter((l) => lineKey(l) === key).reduce((sum, l) => sum + l.quantity, 0);
}

/** Valida la línea en construcción contra el stock disponible (descontando lo que ya está en el carrito). */
export function validateLine(form: VentaForm, availableStock: number): FormErrors {
  const errors: FormErrors = {};

  if (!form.productId) errors.productId = "Selecciona el modelo.";
  if (!form.sizeId) errors.sizeId = "Selecciona la talla.";
  if (!form.colorId) errors.colorId = "Selecciona el color.";

  const qty = Number(form.quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    errors.quantity = "La cantidad debe ser un número entero mayor que cero.";
  } else if (form.productId && form.sizeId && form.colorId) {
    const key = lineKey({ productId: Number(form.productId), sizeId: Number(form.sizeId), colorId: Number(form.colorId) });
    const reserved = inCart(form.cart, key);
    if (reserved + qty > availableStock) {
      errors.quantity =
        reserved > 0
          ? `Stock insuficiente. Disponible: ${availableStock}; ya tienes ${reserved} en la venta.`
          : `Stock insuficiente. Disponible: ${availableStock}.`;
    }
  }

  const cents = toCents(form.unitPrice);
  if (cents === null || cents <= 0) errors.unitPrice = "Ingresa el precio unitario en Bs (mayor que cero, máximo 2 decimales).";

  return errors;
}

/** Agrega o fusiona una línea. La misma variante se fusiona; con otro precio se rechaza para no cambiarlo en silencio. */
export function addToCart(cart: CartLine[], line: CartLine): { cart: CartLine[]; error?: string } {
  const key = lineKey(line);
  const existing = cart.find((l) => lineKey(l) === key);
  if (!existing) return { cart: [...cart, line] };
  if (existing.unitCents !== line.unitCents) {
    return {
      cart,
      error: `Ese producto ya está en la venta a Bs ${fromCents(existing.unitCents).toFixed(2)}. Cambia su cantidad en el carrito o quítalo para agregarlo con otro precio.`,
    };
  }
  return { cart: cart.map((l) => (lineKey(l) === key ? { ...l, quantity: l.quantity + line.quantity } : l)) };
}

export interface SaleValidationContext {
  /** Stock disponible de la variante en la sucursal. */
  stockOf: (line: VariantRef) => number;
  /** Nombre legible de la línea para los mensajes de error. */
  labelOf?: (line: CartLine) => string;
}

/** Validación completa de la venta (carrito + pago, entrega y cliente). Vacío = listo para revisar. */
export function validateVenta(form: VentaForm, ctx: SaleValidationContext): FormErrors {
  const errors: FormErrors = {};

  if (form.cart.length === 0) {
    errors.cart = "Agrega al menos un producto a la venta.";
  } else {
    for (const line of form.cart) {
      const available = ctx.stockOf(line);
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        errors.cart = "La cantidad debe ser mayor que cero.";
        break;
      }
      if (!(line.unitCents > 0)) {
        errors.cart = "Hay una línea sin precio válido.";
        break;
      }
      if (line.quantity > available) {
        const name = ctx.labelOf ? ctx.labelOf(line) : "un producto de la venta";
        errors.cart = `Stock insuficiente para ${name}. Disponible: ${available}; en la venta: ${line.quantity}.`;
        break;
      }
    }
  }

  // Un producto completamente elegido pero sin agregar se perdería al guardar: se avisa.
  if (!errors.cart && form.productId && form.sizeId && form.colorId) {
    errors.cart = "Tienes un producto elegido sin agregar. Pulsa AGREGAR A LA VENTA o cámbialo antes de continuar.";
  }

  if (form.notes.length > NOTES_MAX) errors.notes = `Máximo ${NOTES_MAX} caracteres.`;
  if (form.customerName.length > NAME_MAX) errors.customerName = `Máximo ${NAME_MAX} caracteres.`;

  const deliveryProblem = deliveryError(form.mode, { department: form.department, province: form.province });
  if (deliveryProblem) {
    if (form.mode === "envio") errors.department = deliveryProblem;
    else errors.province = deliveryProblem;
  }

  const phone = phoneError(form.customerPhone);
  if (phone) errors.customerPhone = phone;

  return errors;
}

export interface SalePayload {
  sucursal_id: number;
  metodo_pago: PaymentChoice;
  modalidad: DeliveryMode;
  departamento: string;
  provincia: string;
  observaciones: string;
  cliente_nombre: string;
  cliente_telefono: string;
  items: { producto_id: number; talla_id: number; color_id: number; cantidad: number; precio_unitario: number }[];
  idempotency_key: string;
}

/** Carga útil de UNA venta con todas sus líneas. Solo incluye datos del método elegido. */
export function buildSalePayload(form: VentaForm, sucursalId: number, idempotencyKey: string): SalePayload {
  const delivery = deliveryPayload(form.mode, { department: form.department, province: form.province });
  return {
    sucursal_id: sucursalId,
    metodo_pago: form.payment,
    modalidad: form.mode,
    departamento: delivery.departamento,
    provincia: delivery.provincia,
    observaciones: form.notes.trim(),
    cliente_nombre: form.customerName.trim(),
    cliente_telefono: form.customerPhone,
    items: form.cart.map((l) => ({
      producto_id: l.productId,
      talla_id: l.sizeId,
      color_id: l.colorId,
      cantidad: l.quantity,
      precio_unitario: fromCents(l.unitCents),
    })),
    idempotency_key: idempotencyKey,
  };
}

// ----------------------------------------------------------------- máquina de estados

export type FlowState =
  | { step: "editando"; form: VentaForm; errors: FormErrors; serverError: string; key: string | null }
  | { step: "revisando"; form: VentaForm; key: string; branchId: number }
  | { step: "enviando"; form: VentaForm; key: string; branchId: number }
  | { step: "confirmada"; form: VentaForm; receipt: SaleReceipt };

export type FlowEvent =
  | { type: "editar"; patch: Partial<VentaForm> }
  | { type: "agregar"; availableStock: number }
  | { type: "quitar"; key: string }
  | { type: "cantidad"; key: string; quantity: number }
  | { type: "vaciar" }
  | { type: "revisar"; errors: FormErrors; newKey: string; branchId: number }
  | { type: "volver" }
  | { type: "confirmar" }
  | { type: "exito"; receipt: SaleReceipt }
  | { type: "fallo"; message: string }
  | { type: "nueva" };

export function initialFlow(form: VentaForm = EMPTY_VENTA): FlowState {
  return { step: "editando", form, errors: {}, serverError: "", key: null };
}

export function flowReducer(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case "editar": {
      // Solo se edita mientras el formulario está abierto; los cambios borran la clave de intento previa.
      if (state.step !== "editando") return state;
      const form = { ...state.form, ...event.patch };
      return { ...state, form, key: null, errors: stripFields(state.errors, Object.keys(event.patch) as FormField[]), serverError: "" };
    }
    case "agregar": {
      if (state.step !== "editando") return state;
      const found = validateLine(state.form, event.availableStock);
      if (Object.keys(found).length > 0) return { ...state, errors: { ...state.errors, ...found }, serverError: "" };
      const line: CartLine = {
        productId: Number(state.form.productId),
        sizeId: Number(state.form.sizeId),
        colorId: Number(state.form.colorId),
        quantity: Number(state.form.quantity),
        unitCents: toCents(state.form.unitPrice) as number,
      };
      const added = addToCart(state.form.cart, line);
      if (added.error) return { ...state, errors: { ...state.errors, unitPrice: added.error }, serverError: "" };
      // La línea en construcción se limpia para elegir el siguiente producto; carrito, pago y cliente se conservan.
      const form = { ...state.form, cart: added.cart, productId: "", sizeId: "", colorId: "", quantity: "1", unitPrice: "" };
      return { ...state, form, key: null, errors: {}, serverError: "" };
    }
    case "quitar": {
      if (state.step !== "editando") return state;
      const form = { ...state.form, cart: state.form.cart.filter((l) => lineKey(l) !== event.key) };
      return { ...state, form, key: null, errors: stripFields(state.errors, ["cart"]), serverError: "" };
    }
    case "cantidad": {
      if (state.step !== "editando") return state;
      if (!Number.isFinite(event.quantity)) return state;
      const quantity = Math.max(1, Math.floor(event.quantity));
      const form = { ...state.form, cart: state.form.cart.map((l) => (lineKey(l) === event.key ? { ...l, quantity } : l)) };
      return { ...state, form, key: null, errors: stripFields(state.errors, ["cart"]), serverError: "" };
    }
    case "vaciar": {
      if (state.step !== "editando") return state;
      return { ...state, form: { ...state.form, cart: [] }, key: null, errors: {}, serverError: "" };
    }
    case "revisar": {
      if (state.step !== "editando") return state;
      if (Object.keys(event.errors).length > 0) return { ...state, errors: event.errors, serverError: "" };
      // La sucursal se fija al revisar: cambiar el selector después no mueve la venta a otra sucursal.
      return { step: "revisando", form: state.form, key: state.key ?? event.newKey, branchId: event.branchId };
    }
    case "volver": {
      if (state.step !== "revisando") return state;
      // La clave se conserva: si no hubo envío, el reintento sigue siendo la misma venta.
      return { step: "editando", form: state.form, errors: {}, serverError: "", key: state.key };
    }
    case "confirmar": {
      if (state.step !== "revisando") return state; // doble clic: ignorado
      return { step: "enviando", form: state.form, key: state.key, branchId: state.branchId };
    }
    case "exito": {
      if (state.step !== "enviando") return state;
      return { step: "confirmada", form: state.form, receipt: event.receipt };
    }
    case "fallo": {
      if (state.step !== "enviando") return state;
      // Nunca se muestra éxito: vuelve a editar con el carrito y los datos intactos y con la misma clave
      // para reintentar sin duplicar.
      return { step: "editando", form: state.form, errors: {}, serverError: event.message, key: state.key };
    }
    case "nueva": {
      return initialFlow(EMPTY_VENTA);
    }
  }
}

function stripFields(errors: FormErrors, fields: FormField[]): FormErrors {
  const next = { ...errors };
  for (const f of fields) delete next[f];
  return next;
}
