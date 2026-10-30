

export const BOLIVIA_TZ = "America/La_Paz";

export interface ReceiptItem {
  producto: string;
  talla: string;
  color: string;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
}

export interface SaleReceipt {
  id: number;
  fecha: string;
  total: number;
  sucursal: string | null;
  vendedor: string | null;
  metodo_pago: "QR" | "efectivo" | null;
  modalidad: "entrega_directa" | "envio" | "envio_interprovincial" | null;
  departamento: string | null;
  provincia: string | null;
  cliente_nombre: string | null;
  cliente_telefono: string | null;
  referencias: string | null;
  observaciones?: string | null;
  estado: "completada" | "cancelada";
  items: ReceiptItem[];
  repetida: boolean;
}

export const money = (value: number) => `Bs ${value.toFixed(2)}`;

/** "15/10/2026, 14:35" en hora de Bolivia. */
export function formatBoliviaDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-BO", {
    timeZone: BOLIVIA_TZ,
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const PAYMENT_TEXT: Record<"QR" | "efectivo", string> = { QR: "QR", efectivo: "Efectivo" };

export const MODE_TEXT: Record<NonNullable<SaleReceipt["modalidad"]>, string> = {
  entrega_directa: "Entrega directa",
  envio: "Envío",
  envio_interprovincial: "Envío interprovincial",
};

/** Texto de entrega para el recibo; vacío cuando no aplica (entrega directa). */
export function deliveryText(receipt: Pick<SaleReceipt, "modalidad" | "departamento" | "provincia">): string {
  if (receipt.modalidad === "envio") return receipt.departamento ? `Departamento: ${receipt.departamento}` : "";
  if (receipt.modalidad === "envio_interprovincial") {
    return [receipt.provincia && `Provincia: ${receipt.provincia}`, receipt.departamento && `Departamento: ${receipt.departamento}`]
      .filter(Boolean)
      .join(" · ");
  }
  return "";
}

/** Total recalculado a partir de las líneas (para verificar que el recibo cuadra con el servidor). */
export function receiptTotal(items: ReceiptItem[]): number {
  return Math.round(items.reduce((sum, item) => sum + item.subtotal, 0) * 100) / 100;
}



/** Número de venta con formato fijo, p. ej. 123 → "V-000123". */
export const saleNumber = (id: number) => `V-${String(id).padStart(6, "0")}`;

/** Total de unidades de una venta (suma de cantidades de todas las líneas). */
export const totalUnits = (items: { cantidad: number }[]) => items.reduce((sum, item) => sum + item.cantidad, 0);
