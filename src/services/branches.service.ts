import { api } from "../lib/api";

export interface Branch {
  id: number;
  codigo: string;
  nombre: string;
  es_central: boolean;
  /** Organización matriz a la que pertenece la sucursal (MISSI BOLIVIA). */
  organizacion_id?: number | null;
  organizacion?: string | null;
  /** MISSI BOLIVIA: almacén central (ubicación con stock propio, distinta de las tiendas). */
  es_almacen?: boolean;
}

/** Sucursales visibles para el usuario autenticado (un vendedor ve solo la suya). */
export async function getBranches(): Promise<Branch[]> {
  return api.get<Branch[]>("/api/sucursales");
}

export const getSucursales = getBranches;
