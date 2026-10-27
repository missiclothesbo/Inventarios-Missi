import { api } from "../lib/api";

export type TransferStatus =
  | "pendiente"
  | "enviado"
  | "recibido"
  | "cancelado";

export interface TransferItemInput {
  producto_id: number;
  talla_id: number;
  color_id: number;
  cantidad: number;
}

export interface Transfer {
  id: number;
  origen_id: number;
  destino_id: number;
  estado: TransferStatus;
  responsable: string;
  notas: string | null;
  fecha: string;
  enviado_at: string | null;
  recibido_at: string | null;
  cancelado_at: string | null;
}

export interface TransferItem extends TransferItemInput {
  id: number;
  traspaso_id: number;
}

export interface NewTransferInput {
  origen_id: number;
  destino_id: number;
  responsable: string;
  notas: string;
  items: TransferItemInput[];
  idempotency_key: string;
}

export const getTransfers = () => api.get<Transfer[]>("/api/traspasos");

export const getTransferItems = () => api.get<TransferItem[]>("/api/traspasos/items");

export async function createTransfer(
  input: NewTransferInput,
): Promise<number> {
  if (input.origen_id === input.destino_id) {
    throw new Error("El origen y el destino deben ser distintos.");
  }

  if (input.items.length === 0) {
    throw new Error("Agrega al menos un producto al traspaso.");
  }

  const result = await api.post<{ id: number }>("/api/traspasos", {
    origen_id: input.origen_id,
    destino_id: input.destino_id,
    // El responsable real es el usuario autenticado (lo fija el servidor); este texto es opcional.
    ...(input.responsable.trim() ? { responsable: input.responsable.trim() } : {}),
    notas: input.notas,
    items: input.items,
    idempotency_key: input.idempotency_key,
  });

  return result.id;
}

/** pendiente → enviado: descuenta el stock del origen. */
export const dispatchTransfer = (id: number) =>
  api.post(`/api/traspasos/${id}/despachar`);

/** enviado → recibido: suma el stock al destino. */
export const receiveTransfer = (id: number) =>
  api.post(`/api/traspasos/${id}/recibir`);

/** pendiente/enviado → cancelado (si estaba enviado, devuelve al origen). */
export const cancelTransfer = (id: number) =>
  api.post(`/api/traspasos/${id}/cancelar`);

// ---------------------------------------------------------------- historial y detalle (trazabilidad)

export interface TransferUser {
  id: number;
  nombre: string;
}

export interface TransferHistoryLine {
  producto_id: number;
  producto: string;
  talla_id: number;
  talla: string;
  color_id: number;
  color: string;
  cantidad: number;
}

export interface TransferHistoryRow {
  id: number;
  referencia: string;
  estado: TransferStatus;
  origen: { id: number; nombre: string };
  destino: { id: number; nombre: string };
  fecha: string;
  enviado_at: string | null;
  recibido_at: string | null;
  cancelado_at: string | null;
  responsable: string;
  notas: string | null;
  /** null = traspaso anterior a que se guardara el usuario ("No registrado"). */
  creado_por: TransferUser | null;
  despachado_por: TransferUser | null;
  recibido_por: TransferUser | null;
  cancelado_por: TransferUser | null;
  items: TransferHistoryLine[];
  unidades: number;
}

export interface TransferHistoryPage {
  filas: TransferHistoryRow[];
  total: number;
  unidades: number;
  pagina: number;
  limite: number;
}

export interface TransferHistoryFilters {
  estado?: TransferStatus | "";
  origen_id?: number | null;
  destino_id?: number | null;
  producto_id?: number | null;
  talla_id?: number | null;
  color_id?: number | null;
  usuario_id?: number | null;
  desde?: string;
  hasta?: string;
  q?: string;
  pagina?: number;
  limite?: number;
}

export function getTransferHistory(filters: TransferHistoryFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return api.get<TransferHistoryPage>(`/api/traspasos/historial${query ? `?${query}` : ""}`);
}

export interface TransferDetail extends TransferHistoryRow {
  movimientos: {
    id: number;
    fecha: string;
    categoria: string;
    signo: number | null;
    cantidad: number;
    cantidad_anterior: number | null;
    cantidad_resultante: number | null;
    sucursal: string;
    producto: string;
    talla: string;
    color: string;
    usuario: string | null;
  }[];
}

export const getTransferDetail = (id: number) => api.get<TransferDetail>(`/api/traspasos/${id}`);
