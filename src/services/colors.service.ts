import { api } from "../lib/api";
import type { ColorItem } from "../lib/colores";

/** Todos los colores (activos e inactivos) con sus modelos. Solo administrador. */
export const listAllColors = () => api.get<ColorItem[]>("/api/colores?todos=1");

export const createColor = (nombre: string, productoIds: number[]) =>
  api.post<ColorItem>("/api/colores", { nombre, producto_ids: productoIds });

export const updateColor = (
  id: number,
  patch: Partial<{ nombre: string; activo: boolean; asignar: number[]; quitar: number[] }>,
) => api.patch<ColorItem & { ya_asignados: number[] }>(`/api/colores/${id}`, patch);
