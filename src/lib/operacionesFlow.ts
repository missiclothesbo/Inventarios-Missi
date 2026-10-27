import type { ReturnReason } from "../../shared/catalogo.ts";
/**
 * Flujo de devoluciones, cambios y anulaciones. Lógica pura (sin red ni React), probada en Node.
 * Los cálculos reflejan los del servidor (api/src/routes/operations.ts); el servidor vuelve a validar todo.
 *
 *   buscar → detalle (venta elegida) → editar (devolución | cambio | anulación) → revisar → enviar → confirmada
 *
 * Nada se escribe antes de "confirmar". Volver a editar conserva todos los valores.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

export type OpMode = "devolucion" | "cambio" | "anulacion";
export type Condition = "vendible" | "danado";
export type Liquidacion = "reembolso_inmediato" | "reembolso_pendiente" | "credito";

export interface SaleLine {
  detalle_id: number;
  producto_id: number;
  talla_id: number;
  color_id: number;
  producto: string;
  talla: string;
  color: string;
  cantidad: number;
  precio_unitario: number;
  devuelta: number;
  pendiente: number;
}

export interface ReplacementRow {
  producto_id: string;
  talla_id: string;
  color_id: string;
  cantidad: string;
  precio: string;
}

export interface OpForm {
  mode: OpMode;
  /** Motivo estructurado (obligatorio) y explicación (obligatoria solo con «Otro»). */
  motivoCodigo: ReturnReason | "";
  motivo: string;
  /** cantidad a devolver por línea (texto), y condición del artículo */
  devolver: Record<number, { cantidad: string; condicion: Condition }>;
  reemplazos: ReplacementRow[];
  liquidacion: Liquidacion | "";
  metodo: "qr" | "efectivo" | "";
}

export type FieldErrors = Partial<Record<string, string>>;

export const MOTIVO_MAX = 300;

export function emptyOp(mode: OpMode): OpForm {
  return {
    mode,
    motivoCodigo: "",
    motivo: "",
    devolver: {},
    reemplazos: [{ producto_id: "", talla_id: "", color_id: "", cantidad: "1", precio: "" }],
    liquidacion: "",
    metodo: "",
  };
}

const qtyOf = (text: string | undefined) => (text === undefined || text.trim() === "" ? 0 : Number(text));

/** Unidades que el usuario marcó para devolver, por línea (solo líneas con cantidad > 0). */
export function selectedLines(lines: SaleLine[], form: OpForm) {
  return lines
    .map((l) => ({ line: l, cantidad: qtyOf(form.devolver[l.detalle_id]?.cantidad), condicion: form.devolver[l.detalle_id]?.condicion ?? "vendible" }))
    .filter((x) => x.cantidad > 0);
}

export function valorDevuelto(lines: SaleLine[], form: OpForm, anulacion = false): number {
  if (anulacion) return round2(lines.reduce((a, l) => a + l.pendiente * l.precio_unitario, 0));
  return round2(selectedLines(lines, form).reduce((a, x) => a + x.cantidad * x.line.precio_unitario, 0));
}

/** Valor de lo que se entrega como reemplazo. El precio por defecto es el del modelo (si lo hay). */
export function valorEntregado(form: OpForm, precioModelo: (productoId: number) => number): number {
  if (form.mode !== "cambio") return 0;
  return round2(
    form.reemplazos.reduce((a, r) => {
      const price = r.precio.trim() !== "" ? Number(r.precio) : precioModelo(Number(r.producto_id));
      return a + qtyOf(r.cantidad) * (Number.isFinite(price) ? price : 0);
    }, 0),
  );
}

/** Lo que cobra o debe la tienda. > 0 el cliente paga; < 0 se le debe; 0 sin pago. */
export function diferencia(devuelto: number, entregado: number): number {
  return round2(entregado - devuelto);
}

export function liquidacionFor(diff: number): "none" | "cobro" | "reembolso" {
  if (diff > 0) return "cobro";
  if (diff < 0) return "reembolso";
  return "none";
}

export const LIQUIDACION_TEXT: Record<Liquidacion, string> = {
  reembolso_inmediato: "Devolver el dinero ahora",
  reembolso_pendiente: "Devolver el dinero después",
  credito: "Dejar saldo a favor del cliente",
};

/** Validación completa de la operación. Un mensaje por campo. */
export function validateOp(
  lines: SaleLine[],
  form: OpForm,
  precioModelo: (productoId: number) => number,
  stockDisponible: (productoId: number, tallaId: number, colorId: number) => number,
): FieldErrors {
  const errors: FieldErrors = {};

  if (form.motivoCodigo === "") errors.motivoCodigo = "Elige el motivo.";
  if (form.motivoCodigo === "OTRO" && form.motivo.trim() === "") errors.motivo = "Explica el motivo (obligatorio con «Otro»).";
  if (form.motivo.length > MOTIVO_MAX) errors.motivo = `Máximo ${MOTIVO_MAX} caracteres.`;

  if (form.mode === "anulacion") {
    if (lines.every((l) => l.pendiente <= 0)) errors.anulacion = "No quedan unidades por anular.";
  } else {
    for (const line of lines) {
      const raw = form.devolver[line.detalle_id]?.cantidad ?? "";
      if (raw.trim() === "") continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        errors[`cantidad_${line.detalle_id}`] = "Cantidad inválida.";
      } else if (n > line.pendiente) {
        errors[`cantidad_${line.detalle_id}`] = `Solo quedan ${line.pendiente} por devolver.`;
      }
    }
    if (selectedLines(lines, form).length === 0) errors.items = "Indica al menos una cantidad a devolver.";
  }

  if (form.mode === "cambio") {
    form.reemplazos.forEach((r, i) => {
      if (!r.producto_id || !r.talla_id || !r.color_id) {
        errors[`reemplazo_${i}`] = "Selecciona modelo, talla y color del reemplazo.";
        return;
      }
      const n = qtyOf(r.cantidad);
      if (!Number.isInteger(n) || n <= 0) {
        errors[`reemplazo_cantidad_${i}`] = "Cantidad mayor a 0.";
        return;
      }
      const price = r.precio.trim() !== "" ? Number(r.precio) : precioModelo(Number(r.producto_id));
      if (!Number.isFinite(price) || price <= 0) errors[`reemplazo_precio_${i}`] = "Indica el precio del reemplazo (el modelo no tiene precio).";
      const disponible = stockDisponible(Number(r.producto_id), Number(r.talla_id), Number(r.color_id));
      if (n > disponible) errors[`reemplazo_cantidad_${i}`] = `Stock insuficiente para el reemplazo. Disponible: ${disponible}.`;
    });
  }

  const devuelto = valorDevuelto(lines, form, form.mode === "anulacion");
  const entregado = valorEntregado(form, precioModelo);
  const diff = diferencia(devuelto, entregado);
  if (diff > 0 && form.metodo === "") {
    errors.metodo = "El cliente paga la diferencia: elige QR o efectivo.";
  }
  if (diff < 0 && form.liquidacion === "reembolso_inmediato" && form.metodo === "") {
    errors.metodo = "Para reembolso inmediato elige con qué método se entrega el dinero.";
  }

  return errors;
}

/** Todo lo que el usuario confirmará, para la pantalla de revisión (sin escribir nada). */
export function revisionOf(lines: SaleLine[], form: OpForm, precioModelo: (productoId: number) => number) {
  const anulacion = form.mode === "anulacion";
  const devueltos = anulacion
    ? lines.filter((l) => l.pendiente > 0).map((l) => ({ ...l, cantidad: l.pendiente, condicion: "vendible" as Condition }))
    : selectedLines(lines, form).map((x) => ({ ...x.line, cantidad: x.cantidad, condicion: x.condicion }));
  const devuelto = valorDevuelto(lines, form, anulacion);
  const entregado = valorEntregado(form, precioModelo);
  const diff = diferencia(devuelto, entregado);
  return {
    devueltos,
    reemplazos: form.mode === "cambio" ? form.reemplazos : [],
    valorDevuelto: devuelto,
    valorEntregado: entregado,
    diferencia: diff,
    accion: diff > 0 ? "El cliente paga" : diff < 0 ? "Se le debe al cliente" : "Sin pago",
    liquidacion: liquidacionFor(diff),
  };
}

// ----------------------------------------------------------------- flujo de pantalla

export type OpStep = "buscar" | "detalle" | "editar" | "revisar" | "enviar" | "confirmada";

export interface OpState {
  step: OpStep;
  ventaId: number | null;
  form: OpForm | null;
  key: string | null;
  serverError: string;
}

export type OpEvent =
  | { type: "elegirVenta"; ventaId: number }
  | { type: "volverBuscar" }
  | { type: "elegirModo"; mode: OpMode }
  | { type: "editar"; patch: Partial<OpForm> }
  | { type: "revisar"; newKey: string }
  | { type: "volver" }
  | { type: "confirmar" }
  | { type: "exito" }
  | { type: "fallo"; message: string }
  | { type: "nueva" };

export const initialOp: OpState = { step: "buscar", ventaId: null, form: null, key: null, serverError: "" };

export function opReducer(state: OpState, event: OpEvent): OpState {
  switch (event.type) {
    case "elegirVenta":
      return { ...initialOp, step: "detalle", ventaId: event.ventaId };
    case "volverBuscar":
      return initialOp;
    case "elegirModo":
      if (state.step !== "detalle" && state.step !== "editar") return state;
      return { ...state, step: "editar", form: emptyOp(event.mode), key: null, serverError: "" };
    case "editar":
      if (state.step !== "editar" || !state.form) return state;
      // Cualquier cambio invalida la clave del intento anterior (los valores pueden ser otros).
      return { ...state, form: { ...state.form, ...event.patch }, key: null, serverError: "" };
    case "revisar":
      if (state.step !== "editar") return state;
      return { ...state, step: "revisar", key: state.key ?? event.newKey, serverError: "" };
    case "volver":
      if (state.step !== "revisar") return state;
      return { ...state, step: "editar" };
    case "confirmar":
      if (state.step !== "revisar") return state; // doble clic: ignorado
      return { ...state, step: "enviar" };
    case "exito":
      if (state.step !== "enviar") return state;
      return { ...state, step: "confirmada" };
    case "fallo":
      // Nunca un éxito falso: vuelve a editar con los datos y conserva la clave para reintentar sin duplicar.
      if (state.step !== "enviar") return state;
      return { ...state, step: "editar", serverError: event.message };
    case "nueva":
      return initialOp;
  }
}
