import { api } from "../lib/api";
import type { Condition, Liquidacion, OpForm, SaleLine } from "../lib/operacionesFlow";

export interface SearchFilters {
  /** Búsqueda universal: cualquier dato de la venta (número, cliente, teléfono, modelo, color, fecha...). */
  q?: string;
  numero?: string;
  cliente?: string;
  telefono?: string;
  desde?: string;
  hasta?: string;
  producto?: string;
  talla?: string;
  color?: string;
  sucursal_id?: number | null;
  modalidad?: string;
  departamento?: string;
  provincia?: string;
  direccion?: string;
}

export interface SearchItem {
  producto: string;
  talla: string;
  color: string;
  cantidad: number;
  precio_unitario: number;
}

export interface FoundSale {
  id: number;
  fecha: string;
  total: number;
  estado: "completada" | "cancelada";
  sucursal: string | null;
  sucursal_id: number;
  cliente_nombre: string | null;
  cliente_telefono: string | null;
  metodo_pago: "QR" | "efectivo" | null;
  modalidad: "entrega_directa" | "envio" | "envio_interprovincial" | null;
  departamento: string | null;
  provincia: string | null;
  ciudad: string | null;
  direccion: string | null;
  items: SearchItem[];
}

export interface SaleDetailResponse {
  venta: FoundSale & { observaciones: string | null };
  lineas: SaleLine[];
  unidades_pendientes: number;
  puede_anular: boolean;
  operaciones: OperationResult[];
}

export interface OperationItem {
  rol: "devuelto" | "entregado";
  producto: string;
  talla: string;
  color: string;
  cantidad: number;
  precio_unitario: number;
  condicion: Condition | null;
}

export interface OperationResult {
  id: number;
  tipo: "devolucion" | "cambio" | "anulacion";
  venta_id: number;
  sucursal_id: number;
  referencia?: string;
  operador: string;
  motivo: string;
  motivo_codigo?: string | null;
  motivo_etiqueta?: string | null;
  fecha: string;
  valor_devuelto: number;
  valor_entregado: number;
  diferencia: number;
  pago: { tipo: string; estado: string; metodo: string | null; monto: number };
  items: OperationItem[];
  venta?: { id: number; fecha: string; total: number; sucursal: string | null; cliente: string | null };
  repetida?: boolean;
}

export function buildSearchQuery(filters: SearchFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export const searchSales = (filters: SearchFilters) =>
  api.get<FoundSale[]>(`/api/ventas/buscar${buildSearchQuery(filters) ? `?${buildSearchQuery(filters)}` : ""}`);

export const getSaleDetail = (ventaId: number) => api.get<SaleDetailResponse>(`/api/ventas/${ventaId}/detalle-completo`);

export const listOperations = (ventaId?: number) =>
  api.get<OperationResult[]>(`/api/operaciones${ventaId ? `?venta_id=${ventaId}` : ""}`);

interface ReturnPayload {
  idempotency_key: string;
  venta_id: number;
  motivo: string;
  motivo_codigo: string;
  items: { detalle_id: number; cantidad: number; condicion: Condition }[];
  liquidacion?: Liquidacion;
  metodo_pago?: "qr" | "efectivo";
  reemplazos?: { producto_id: number; talla_id: number; color_id: number; cantidad: number; precio_unitario?: number }[];
}

/** Arma la carga útil de devolución o cambio a partir del formulario ya validado. */
export function buildOperationPayload(
  ventaId: number,
  lines: SaleLine[],
  form: OpForm,
  key: string,
): ReturnPayload {
  const items = lines
    .map((l) => ({ l, raw: form.devolver[l.detalle_id] }))
    .filter((x) => x.raw && Number(x.raw.cantidad) > 0)
    .map((x) => ({ detalle_id: x.l.detalle_id, cantidad: Number(x.raw!.cantidad), condicion: x.raw!.condicion }));

  const payload: ReturnPayload = { idempotency_key: key, venta_id: ventaId, motivo: form.motivo.trim(), motivo_codigo: form.motivoCodigo, items };
  if (form.liquidacion) payload.liquidacion = form.liquidacion;
  if (form.metodo) payload.metodo_pago = form.metodo;
  if (form.mode === "cambio") {
    payload.reemplazos = form.reemplazos.map((r) => ({
      producto_id: Number(r.producto_id),
      talla_id: Number(r.talla_id),
      color_id: Number(r.color_id),
      cantidad: Number(r.cantidad),
      ...(r.precio.trim() !== "" ? { precio_unitario: Number(r.precio) } : {}),
    }));
  }
  return payload;
}

export const postDevolucion = (payload: ReturnPayload) => api.post<OperationResult>("/api/operaciones/devolucion", payload);
export const postCambio = (payload: ReturnPayload) => api.post<OperationResult>("/api/operaciones/cambio", payload);

export const postAnulacion = (ventaId: number, motivo: string, motivoCodigo: string, liquidacion: Liquidacion | "", metodo: "qr" | "efectivo" | "") =>
  api.post<{ id: number; estado: string; operacion: OperationResult | null }>(`/api/ventas/${ventaId}/cancelar`, {
    motivo,
    motivo_codigo: motivoCodigo,
    ...(liquidacion ? { liquidacion } : {}),
    ...(metodo ? { metodo_pago: metodo } : {}),
  });

/** Devoluciones, cambios y anulaciones del periodo inclusivo (fecha local de Bolivia). */
export async function listOperationsPeriodo(
  desde: string,
  hasta: string,
  sucursalId: number | null,
): Promise<{ operaciones: OperationResult[]; truncado: boolean }> {
  const params = new URLSearchParams({ desde, hasta });
  if (sucursalId !== null) params.set("sucursal_id", String(sucursalId));
  const operaciones = await api.get<OperationResult[]>(`/api/operaciones?${params.toString()}`);
  return { operaciones, truncado: operaciones.length >= 200 };
}

// ---------------------------------------------------------------- historial buscable

export interface OperationHistoryItem {
  detalle_venta_id?: number | null;
  producto_id: number;
  producto: string;
  talla_id: number;
  talla: string;
  color_id: number;
  color: string;
  cantidad: number;
  precio_unitario: number;
  condicion: Condition | null;
}

export interface OperationHistoryRow {
  id: number;
  referencia: string;
  tipo: "devolucion" | "cambio" | "anulacion";
  venta_id: number;
  venta_referencia: string;
  venta_fecha: string;
  venta_total: number;
  sucursal: string;
  fecha: string;
  operador: { id: number; nombre: string };
  cliente_nombre: string | null;
  cliente_telefono: string | null;
  motivo: string;
  motivo_codigo: string | null;
  motivo_etiqueta: string;
  valor_devuelto: number;
  valor_entregado: number;
  diferencia: number;
  pago: { tipo: string; estado: string; metodo: string | null; monto: number };
  devueltos: OperationHistoryItem[];
  entregados: OperationHistoryItem[];
}

export interface OperationHistoryPage {
  filas: OperationHistoryRow[];
  total: number;
  pagina: number;
  limite: number;
}

export interface OperationHistoryFilters {
  tipo?: "devolucion" | "cambio" | "anulacion" | "";
  motivo_codigo?: string;
  usuario_id?: number | null;
  sucursal_id?: number | null;
  producto_id?: number | null;
  talla_id?: number | null;
  color_id?: number | null;
  desde?: string;
  hasta?: string;
  q?: string;
  pagina?: number;
  limite?: number;
}

export function getOperationHistory(filters: OperationHistoryFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return api.get<OperationHistoryPage>(`/api/operaciones/historial${query ? `?${query}` : ""}`);
}
