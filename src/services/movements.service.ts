import { api } from "../lib/api";
import type { MovementCategory } from "../lib/catalogo";

export interface MovementFilters {
  /** Una o varias categorías (vacío = todas). */
  categoria?: MovementCategory[];
  desde?: string;
  hasta?: string;
  sucursal_id?: number | null;
  producto_id?: number | null;
  talla_id?: number | null;
  color_id?: number | null;
  usuario_id?: number | null;
  estado?: string;
  q?: string;
  pagina?: number;
  limite?: number;
}

export interface MovementRow {
  id: number;
  referencia: string;
  fecha: string;
  categoria: MovementCategory;
  categoria_etiqueta: string;
  signo: number | null;
  efecto: string;
  cantidad: number;
  cantidad_anterior: number | null;
  cantidad_resultante: number | null;
  producto: { id: number; nombre: string };
  talla: { id: number; nombre: string };
  color: { id: number; nombre: string };
  sucursal: { id: number; nombre: string };
  origen: string | null;
  destino: string | null;
  estado_traspaso: string | null;
  /** null = registro anterior a que se guardara el responsable ("No registrado"). */
  usuario: { id: number; nombre: string } | null;
  documento: { tipo: string; id: number; codigo: string } | null;
  motivo_codigo: string | null;
  motivo_etiqueta: string | null;
  motivo: string | null;
  observaciones: string | null;
}

export interface MovementPage {
  filas: MovementRow[];
  total: number;
  unidades: number;
  /** Unidades que entraron / salieron del stock con los filtros elegidos. */
  entradas: number;
  salidas: number;
  pagina: number;
  limite: number;
  por_categoria: { categoria: MovementCategory; etiqueta: string; movimientos: number; unidades: number }[];
}

/** Arma la query string omitiendo vacíos; las listas se envían separadas por coma. */
export function buildQuery(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    q.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return q.toString();
}

export const getMovements = (filters: MovementFilters) => {
  const query = buildQuery({ ...filters });
  return api.get<MovementPage>(`/api/movimientos${query ? `?${query}` : ""}`);
};

export const registerStockExit = (body: {
  sucursal_id: number;
  producto_id: number;
  talla_id: number;
  color_id: number;
  cantidad: number;
  motivo_codigo: string;
  detalle: string;
  idempotency_key: string;
}) => {
  const { idempotency_key, ...rest } = body;
  return api.post<{ repetido: boolean }>("/api/inventario/salida", rest, { "Idempotency-Key": idempotency_key });
};

export const registerStockAdjustment = (body: {
  sucursal_id: number;
  producto_id: number;
  talla_id: number;
  color_id: number;
  delta: number;
  motivo: string;
  idempotency_key: string;
}) => {
  const { idempotency_key, ...rest } = body;
  return api.post<{ repetido: boolean }>("/api/inventario/ajuste", rest, { "Idempotency-Key": idempotency_key });
};
