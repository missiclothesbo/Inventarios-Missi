import { api } from "../lib/api";

export interface DashboardStats {
  totalStock: number;
  totalProducts: number;
  salesToday: number;
  incomeToday: number;
}

export interface RecentSale {
  id: number;
  fecha: string;
  total: number;
}

export interface LowStockItem {
  id: number;
  producto: string;
  talla: string;
  color: string;
  cantidad: number;
}

export interface DashboardData {
  stats: DashboardStats;
  recentSales: RecentSale[];
  lowStockItems: LowStockItem[];
}

export async function getDashboardData(
  sucursalId: number | null,
): Promise<DashboardData> {
  const query = sucursalId === null ? "" : `?sucursal_id=${sucursalId}`;
  return api.get<DashboardData>(`/api/dashboard${query}`);
}
