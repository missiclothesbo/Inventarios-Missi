import { api } from "../lib/api";

export interface InventoryItem {
  id: number;
  /** null cuando la fila es el consolidado de todas las sucursales */
  sucursal_id: number | null;
  cantidad: number;
  producto: {
    id: number;
    nombre: string;
  };
  talla: {
    id: number;
    nombre: string;
  };
  color: {
    id: number;
    nombre: string;
  };
  /** Ingreso a esta ubicación. fecha = null cuando se desconoce (stock anterior a los lotes). */
  ingreso?: { fecha: string | null; registrado: string | null; lotes: number } | null;
}

/**
 * Inventario de una sucursal, o consolidado (suma de todas, solo administrador) si sucursalId es null.
 */
export async function getInventory(
  sucursalId: number | null,
): Promise<InventoryItem[]> {
  const query = sucursalId === null ? "" : `?sucursal_id=${sucursalId}`;
  return api.get<InventoryItem[]>(`/api/inventario${query}`);
}
