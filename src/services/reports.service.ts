import { api } from "../lib/api";
import { getInventory } from "./inventory.service";

import type { Sale } from "./sales.service";

export interface ReportFilters {
  desde: string; // YYYY-MM-DD o ""
  hasta: string;
  sucursalId: number | null;
  metodoPago: string; // "" = todos
  departamento: string;
  modalidad: string;
}

export interface GroupRow {
  clave: string;
  ventas: number;
  ingresos: number;
}

export interface TopProduct {
  producto: string;
  unidades: number;
  ingresos: number;
}

export interface TransferSummary {
  total: number;
  pendientes: number;
  enviados: number;
  recibidos: number;
  cancelados: number;
  unidades_recibidas: number;
}

export interface OperationsSummary {
  devoluciones: number;
  cambios: number;
  anulaciones: number;
  valor_devuelto: number;
  valor_cambio_entregado: number;
  valor_anulado: number;
  ingresos_brutos: number;
  ingresos_netos: number;
  cobros_completados: number;
  reembolsos_completados: number;
  reembolsos_pendientes: number;
  creditos_pendientes: number;
}

export interface Balance {
  operaciones: OperationsSummary;
  resumen: { ventas: number; ingresos: number; unidades: number; ticket_promedio: number };
  por_metodo: GroupRow[];
  por_sucursal: GroupRow[];
  por_departamento: GroupRow[];
  por_modalidad: GroupRow[];
  por_dia: GroupRow[];
  por_hora: GroupRow[];
  por_semana: GroupRow[];
  por_mes: GroupRow[];
  top_productos: TopProduct[];
  traspasos: TransferSummary;
}

export interface LowStockReport {
  id: number;
  producto: string;
  talla: string;
  color: string;
  cantidad: number;
}

export interface ReportsData {
  balance: Balance;
  sales: Sale[];
  lowStock: LowStockReport[];
}

function filterQuery(filters: ReportFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.desde) params.set("desde", filters.desde);
  if (filters.hasta) params.set("hasta", filters.hasta);
  if (filters.sucursalId !== null) params.set("sucursal_id", String(filters.sucursalId));
  if (filters.metodoPago) params.set("metodo_pago", filters.metodoPago);
  if (filters.departamento) params.set("departamento", filters.departamento);
  if (filters.modalidad) params.set("modalidad", filters.modalidad);
  return params;
}

/**
 * Balance calculado en el servidor (una sola fuente de verdad):
 * ingresos = suma de ventas completadas, sin contar traspasos ni canceladas.
 */
export async function getBalance(
  filters: ReportFilters,
): Promise<Balance> {
  return api.get<Balance>(`/api/reportes/balance?${filterQuery(filters).toString()}`);
}

async function getLowStock(
  sucursalId: number | null,
): Promise<LowStockReport[]> {
  const inventory = await getInventory(sucursalId);

  return inventory
    .filter((item) => item.cantidad >= 1 && item.cantidad <= 3)
    .sort((a, b) => a.cantidad - b.cantidad)
    .slice(0, 20)
    .map((item) => ({
      id: item.id,
      producto: item.producto.nombre,
      talla: item.talla.nombre,
      color: item.color.nombre,
      cantidad: item.cantidad,
    }));
}

/** Ventas completadas del período, con los mismos filtros que el balance. */
async function getFilteredSales(filters: ReportFilters): Promise<Sale[]> {
  const params = filterQuery(filters);
  params.set("estado", "completada");
  params.set("limit", "500");
  return api.get<Sale[]>(`/api/ventas?${params.toString()}`);
}

export async function getReportsData(
  filters: ReportFilters,
): Promise<ReportsData> {
  const [balance, sales, lowStock] = await Promise.all([
    getBalance(filters),
    getFilteredSales(filters),
    getLowStock(filters.sucursalId),
  ]);

  return { balance, sales, lowStock };
}

// ----------------------------------------------------------------- reportes por periodo (servidor)

export interface PeriodoParams {
  desde: string;
  hasta: string;
  sucursalId: number | null;
}

/** Query común: periodo inclusivo (AAAA-MM-DD) y sucursal (omitida = consolidado, solo administrador). */
export function periodoQuery(p: PeriodoParams): string {
  const params = new URLSearchParams({ desde: p.desde, hasta: p.hasta });
  if (p.sucursalId !== null) params.set("sucursal_id", String(p.sucursalId));
  return params.toString();
}

export const getMovimientosPeriodo = (p: PeriodoParams) =>
  api.get<import("../lib/reportes").MovimientosData & { periodo: { desde: string; hasta: string } }>(`/api/reportes/movimientos?${periodoQuery(p)}`);

export const getStockActual = (sucursalId: number | null) =>
  api.get<import("../lib/reportes").StockData>(`/api/reportes/stock${sucursalId !== null ? `?sucursal_id=${sucursalId}` : ""}`);

export const getBalancePeriodo = (p: PeriodoParams) => api.get<Balance>(`/api/reportes/balance?${periodoQuery(p)}`);
