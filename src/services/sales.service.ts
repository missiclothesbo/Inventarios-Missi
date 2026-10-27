import { api } from "../lib/api";
import type { SaleReceipt } from "../lib/receipt";
import type { SalePayload as VentaPayload } from "../lib/ventaFlow";

export const DEPARTAMENTOS_BOLIVIA = [
  "Beni",
  "Chuquisaca",
  "Cochabamba",
  "La Paz",
  "Oruro",
  "Pando",
  "Potosí",
  "Santa Cruz",
  "Tarija",
] as const;

export type PaymentMethod = "QR" | "efectivo";
export type DeliveryMode =
  | "entrega_directa"
  | "envio"
  | "envio_interprovincial";

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  QR: "QR",
  efectivo: "Efectivo",
};

export const MODE_LABELS: Record<DeliveryMode, string> = {
  entrega_directa: "Entrega directa",
  envio: "Envío",
  envio_interprovincial: "Envío interprovincial",
};

export interface SaleItemInput {
  producto_id: number;
  talla_id: number;
  color_id: number;
  cantidad: number;
  precio_unitario: number;
}

export interface NewSaleInput {
  sucursal_id: number;
  metodo_pago: PaymentMethod;
  modalidad: DeliveryMode;
  departamento: string;
  ciudad: string;
  provincia: string;
  municipio: string;
  direccion: string;
  agencia_transporte: string;
  referencias: string;
  cliente_nombre: string;
  cliente_telefono: string;
  items: SaleItemInput[];
  /** Se genera una vez por intento de venta: reintentar no duplica. */
  idempotency_key: string;
}

export interface Sale {
  id: number;
  fecha: string;
  total: number;
  sucursal_id: number;
  metodo_pago: PaymentMethod | null;
  modalidad: DeliveryMode | null;
  departamento: string | null;
  ciudad: string | null;
  provincia: string | null;
  municipio: string | null;
  direccion: string | null;
  agencia_transporte: string | null;
  referencias: string | null;
  cliente_nombre: string | null;
  cliente_telefono: string | null;
  observaciones?: string | null;
  vendedor?: string | null;
  estado: "completada" | "cancelada";
  motivo_cancelacion: string | null;
}

export interface SaleDetail {
  id: number;
  venta_id: number;
  producto_id: number;
  talla_id: number;
  color_id: number;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
}

/**
 * Ventas registradas (más recientes primero). sucursalId null = todas (solo administrador).
 */
export async function getSales(
  sucursalId: number | null,
  limit = 50,
): Promise<Sale[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (sucursalId !== null) params.set("sucursal_id", String(sucursalId));

  return api.get<Sale[]>(`/api/ventas?${params.toString()}`);
}

export async function getSaleDetails(
  saleId: number,
): Promise<SaleDetail[]> {
  return api.get<SaleDetail[]>(`/api/ventas/${saleId}/detalle`);
}

/**
 * Registra una venta en UNA transacción del servidor y devuelve el recibo CONFIRMADO
 * (número real, total, líneas y datos de entrega tal como quedaron guardados).
 */
export async function createSaleReceipt(input: NewSaleInput): Promise<SaleReceipt> {
  if (input.items.length === 0) {
    throw new Error("Debes agregar al menos un producto a la venta.");
  }

  if (input.modalidad === "envio" && !input.departamento.trim()) {
    throw new Error("Selecciona el departamento de envío.");
  }

  if (input.modalidad === "envio_interprovincial" && !input.provincia.trim()) {
    throw new Error("Escribe la provincia para el envío interprovincial.");
  }

  // El servidor valida de nuevo todo, calcula el total y descuenta el stock en una sola transacción.
  return api.post<SaleReceipt>("/api/ventas", {
    idempotency_key: input.idempotency_key,
    sucursal_id: input.sucursal_id,
    metodo_pago: input.metodo_pago,
    modalidad: input.modalidad,
    departamento: input.departamento,
    provincia: input.provincia,
    referencias: input.referencias,
    cliente_nombre: input.cliente_nombre,
    cliente_telefono: input.cliente_telefono,
    items: input.items,
  });
}

/**
 * Envía una venta de una sola línea (formulario unificado). Una sola petición = una venta.
 * La misma clave de idempotencia nunca crea dos ventas.
 */
export async function createVentaReceipt(payload: VentaPayload): Promise<SaleReceipt> {
  return api.post<SaleReceipt>("/api/ventas", payload);
}

/** Compatibilidad: devuelve solo el id de la venta confirmada. */
export async function createSale(input: NewSaleInput): Promise<number> {
  return (await createSaleReceipt(input)).id;
}

/** Cancela una venta (solo administrador), repone el stock de su sucursal y deja el motivo. */
export async function cancelSale(
  saleId: number,
  reason: string,
): Promise<void> {
  if (!reason.trim()) {
    throw new Error("Escribe el motivo de la cancelación.");
  }

  await api.post(`/api/ventas/${saleId}/cancelar`, { motivo: reason });
}

/** Texto de destino de una venta, para detalle, comanda y reportes. */
export function formatDestination(sale: Sale): string {
  if (sale.modalidad === "entrega_directa") {
    return "Entrega directa";
  }

  if (sale.modalidad === "envio") {
    return [sale.departamento, sale.ciudad, sale.direccion]
      .filter(Boolean)
      .join(" · ");
  }

  if (sale.modalidad === "envio_interprovincial") {
    return [
      sale.departamento,
      sale.provincia,
      sale.municipio,
      sale.direccion,
      sale.agencia_transporte
        ? `Agencia: ${sale.agencia_transporte}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  return "Sin registrar";
}

/** Ventas (todas las estados) del periodo inclusivo, con el mismo filtro de fecha local de Bolivia que el balance. */
export async function getSalesPeriodo(
  desde: string,
  hasta: string,
  sucursalId: number | null,
): Promise<{ ventas: Sale[]; truncado: boolean }> {
  const params = new URLSearchParams({ desde, hasta, limit: "500" });
  if (sucursalId !== null) params.set("sucursal_id", String(sucursalId));
  const ventas = await api.get<Sale[]>(`/api/ventas?${params.toString()}`);
  return { ventas, truncado: ventas.length >= 500 };
}

// ---------------------------------------------------------------- historial con filtros y paginación en el servidor

export interface SaleHistoryFilters {
  estado?: "completada" | "cancelada" | "";
  sucursal_id?: number | null;
  desde?: string;
  hasta?: string;
  metodo_pago?: PaymentMethod | "";
  modalidad?: DeliveryMode | "";
  /** Departamento de destino (nombre oficial) o SIN_REGISTRAR. */
  departamento?: string;
  provincia?: string;
  municipio?: string;
  producto_id?: number | null;
  talla_id?: number | null;
  color_id?: number | null;
  usuario_id?: number | null;
  /** Referencia (V-000123), número, cliente o teléfono. */
  q?: string;
  pagina?: number;
  limite?: number;
}

export interface SaleHistoryItem {
  producto: string;
  talla: string;
  color: string;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
}

export interface SaleHistoryRow extends Sale {
  referencia: string;
  sucursal: string | null;
  vendedor: string | null;
  unidades: number;
  items: SaleHistoryItem[];
}

export interface SaleHistoryPage {
  filas: SaleHistoryRow[];
  total: number;
  pagina: number;
  limite: number;
  /** Totales de las ventas COMPLETADAS que cumplen los filtros (no solo la página visible). */
  totales: { ventas: number; unidades: number; ingresos: number; base: "ventas" | "lineas" };
}

export function getSalesHistory(filters: SaleHistoryFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return api.get<SaleHistoryPage>(`/api/ventas/historial${query ? `?${query}` : ""}`);
}
