import { api } from "../lib/api";
import type { LotState } from "../lib/recepcion";

export interface LotRow {
  id: number;
  codigo: string;
  raiz_id: number;
  origen: string;
  origen_texto: string;
  sucursal: { id: number; nombre: string; tipo: string };
  producto: { id: number; nombre: string };
  talla: { id: number; nombre: string };
  color: { id: number; nombre: string };
  cantidad_inicial: number;
  cantidad_restante: number;
  vendidas: number;
  traspasadas: number;
  otras_salidas: number;
  devueltas: number;
  en_transito: number;
  /** Llegada a la empresa (ISO UTC) o null si es desconocida. */
  fecha_recepcion: string | null;
  /** Llegada a esta ubicación (ISO UTC) o null. */
  fecha_llegada: string | null;
  dias_en_inventario: number | null;
  dias_en_ubicacion: number | null;
  primera_venta: string | null;
  ultima_venta: string | null;
  dias_hasta_primera_venta: number | null;
  promedio_diario: number | null;
  estado: LotState;
  proveedor: string | null;
  referencia: string | null;
  notas: string | null;
  recepcion: { id: number; codigo: string } | null;
  traspaso: { id: number; codigo: string } | null;
  creado_por: string | null;
}

export interface LotFilters {
  sucursal_id?: number | null;
  producto_id?: number;
  talla_id?: number;
  color_id?: number;
  estado?: LotState | "";
  desde?: string;
  hasta?: string;
  q?: string;
  con_stock?: boolean;
}

export function lotQuery(f: LotFilters): string {
  const p = new URLSearchParams();
  if (f.sucursal_id) p.set("sucursal_id", String(f.sucursal_id));
  if (f.producto_id) p.set("producto_id", String(f.producto_id));
  if (f.talla_id) p.set("talla_id", String(f.talla_id));
  if (f.color_id) p.set("color_id", String(f.color_id));
  if (f.estado) p.set("estado", f.estado);
  if (f.desde) p.set("desde", f.desde);
  if (f.hasta) p.set("hasta", f.hasta);
  if (f.q?.trim()) p.set("q", f.q.trim());
  if (f.con_stock) p.set("con_stock", "1");
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const listLots = (f: LotFilters) =>
  api.get<{ filas: LotRow[]; total: number; truncado: boolean; unidades_restantes: number }>(`/api/lotes${lotQuery(f)}`);

export interface ReceiptResult {
  id: number;
  referencia_recepcion: string;
  total_unidades: number;
  lotes: { id: number; codigo: string; producto: string; talla: string; color: string; cantidad_inicial: number }[];
  repetida: boolean;
}

/** Registra una recepción. La clave hace que un reintento (doble toque, red lenta) no la registre dos veces. */
export const createReceipt = (
  idempotencyKey: string,
  payload: {
    sucursal_id: number;
    fecha_recepcion: string | null;
    proveedor?: string | null;
    referencia?: string | null;
    notas?: string | null;
    items: { producto_id: number; talla_id: number; color_id: number; cantidad: number }[];
  },
) => api.post<ReceiptResult>("/api/recepciones", { idempotency_key: idempotencyKey, ...payload });
