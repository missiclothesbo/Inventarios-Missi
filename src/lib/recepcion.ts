/**
 * Recepción de mercadería y lotes: lógica pura (sin React ni API) para poder probarla en Node.
 * Las fechas se escriben en hora de Bolivia (UTC−4, sin horario de verano) y viajan a la API con su zona.
 */
export interface ReceiptLine {
  key: string;
  productoId: string;
  tallaId: string;
  colorId: string;
  cantidad: string;
}

export interface ReceiptForm {
  /** Fecha y hora local de Bolivia, formato del campo datetime-local: AAAA-MM-DDTHH:MM */
  fecha: string;
  proveedor: string;
  referencia: string;
  notas: string;
  lineas: ReceiptLine[];
}

export type ReceiptErrors = { fecha?: string; lineas?: string } & Record<string, string | undefined>;

const BOLIVIA_OFFSET_MS = 4 * 3_600_000;
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Ahora en Bolivia como valor de <input type="datetime-local">. */
export function nowBoliviaLocal(now: Date = new Date()): string {
  return new Date(now.getTime() - BOLIVIA_OFFSET_MS).toISOString().slice(0, 16);
}

/** "2026-10-26T09:30" (hora de Bolivia) → "2026-10-26T09:30:00-04:00" (lo que acepta la API). */
export function boliviaLocalToIso(local: string): string | null {
  if (!LOCAL.test(local)) return null;
  const d = new Date(`${local}:00-04:00`);
  return Number.isNaN(d.getTime()) ? null : `${local}:00-04:00`;
}

let seq = 0;
export const emptyLine = (): ReceiptLine => ({ key: `l${++seq}`, productoId: "", tallaId: "", colorId: "", cantidad: "" });

export const emptyReceipt = (now: Date = new Date()): ReceiptForm => ({
  fecha: nowBoliviaLocal(now),
  proveedor: "",
  referencia: "",
  notas: "",
  lineas: [emptyLine()],
});

/** Errores por campo (clave de la línea → mensaje). Vacío = se puede guardar. */
export function validateReceipt(f: ReceiptForm, now: Date = new Date()): ReceiptErrors {
  const e: ReceiptErrors = {};
  const iso = boliviaLocalToIso(f.fecha);
  if (!iso) e.fecha = "Elige la fecha y hora en que llegó la mercadería.";
  else if (Date.parse(iso) > now.getTime() + 10 * 60_000) e.fecha = "La fecha de llegada no puede estar en el futuro.";

  const seen = new Set<string>();
  f.lineas.forEach((l, i) => {
    const n = Number(l.cantidad);
    if (!l.productoId || !l.tallaId || !l.colorId) e[l.key] = `Prenda ${i + 1}: elige modelo, talla y color.`;
    else if (!Number.isInteger(n) || n <= 0) e[l.key] = `Prenda ${i + 1}: escribe cuántas unidades llegaron (número mayor a 0).`;
    else {
      const k = `${l.productoId}-${l.tallaId}-${l.colorId}`;
      if (seen.has(k)) e[l.key] = `Prenda ${i + 1}: esa talla y color ya está en la lista; suma las cantidades en una sola línea.`;
      seen.add(k);
    }
  });
  if (f.lineas.length === 0) e.lineas = "Agrega al menos una prenda.";
  return e;
}

export const totalUnits = (f: ReceiptForm) => f.lineas.reduce((a, l) => a + (Number(l.cantidad) || 0), 0);

/** Cuerpo para POST /api/recepciones (sin la clave de idempotencia, que agrega el servicio). */
export function receiptPayload(f: ReceiptForm, sucursalId: number) {
  return {
    sucursal_id: sucursalId,
    fecha_recepcion: boliviaLocalToIso(f.fecha),
    proveedor: f.proveedor.trim() || null,
    referencia: f.referencia.trim() || null,
    notas: f.notas.trim() || null,
    items: f.lineas.map((l) => ({ producto_id: Number(l.productoId), talla_id: Number(l.tallaId), color_id: Number(l.colorId), cantidad: Number(l.cantidad) })),
  };
}

// ---------------------------------------------------------------- lotes: textos

export type LotState = "en_stock" | "parcialmente_vendido" | "en_transito" | "traspasado" | "agotado";

export const LOT_STATE_TEXT: Record<LotState, string> = {
  en_stock: "Sin ventas aún",
  parcialmente_vendido: "Vendiéndose",
  en_transito: "En camino",
  traspasado: "Enviado a otra sucursal",
  agotado: "Agotado",
};

export const LOT_STATE_CLASS: Record<LotState, string> = {
  en_stock: "bg-gray-100 text-gray-700",
  parcialmente_vendido: "bg-green-50 text-green-700",
  en_transito: "bg-blue-50 text-blue-700",
  traspasado: "bg-gray-100 text-gray-500",
  agotado: "bg-red-50 text-red-700",
};

/** Texto de la fecha y hora de ingreso (numérica) de una talla/color en una ubicación. */
export function entryText(
  ingreso: { fecha: string | null; registrado: string | null; lotes: number } | null | undefined,
  format: (iso: string) => string,
): string {
  if (!ingreso) return "";
  const extra = ingreso.lotes > 1 ? ` (+${ingreso.lotes - 1} lotes más recientes)` : "";
  if (ingreso.fecha) return `Ingresó ${format(ingreso.fecha)}${extra}`;
  return ingreso.registrado ? `Ingreso: fecha desconocida · registrado en el sistema ${format(ingreso.registrado)}` : "Ingreso: fecha desconocida";
}

/** "hoy", "1 día", "12 días"; null = fecha desconocida (no se inventa). */
export function daysText(d: number | null): string {
  if (d === null) return "Fecha desconocida";
  if (d === 0) return "Menos de 1 día";
  return d === 1 ? "1 día" : `${d} días`;
}
