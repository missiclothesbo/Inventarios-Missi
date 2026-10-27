import { api } from "../lib/api";
import { buildQuery } from "./movements.service";

/** Filtros comunes. Sin desde/hasta = todo el historial. */
export interface AnalyticsFilters {
  desde?: string;
  hasta?: string;
  sucursal_id?: number | null;
}

/** Filtros de venta compartidos con el historial de ventas (mismas reglas en el servidor). */
export interface SaleScopeFilters extends AnalyticsFilters {
  metodo_pago?: "QR" | "efectivo";
  modalidad?: "entrega_directa" | "envio" | "envio_interprovincial";
  departamento?: string;
  provincia?: string;
  municipio?: string;
  usuario_id?: number | null;
  producto_id?: number | null;
  talla_id?: number | null;
  color_id?: number | null;
}

export interface ModelFilters extends SaleScopeFilters {
  limite?: number;
}

export interface ModelRow {
  producto_id: number;
  producto: string;
  unidades: number;
  ventas: number;
  ingresos: number;
  devueltas: number;
  cambios_entregados: number;
  netas: number;
  por_talla: { talla: string; unidades: number }[];
  por_color: { color: string; unidades: number }[];
  por_sucursal: { sucursal: string; unidades: number; ventas: number; ingresos: number }[];
  tendencia: { clave: string; unidades: number }[];
}

export interface ModelReport {
  filtros: { desde: string | null; hasta: string | null; branch: number | null; granularidad: "dia" | "mes" };
  definiciones: Record<string, string>;
  totales: { ventas: number; unidades: number; ingresos: number; unidades_devueltas: number; unidades_netas: number };
  modelos: ModelRow[];
}

export interface ShippingDepartment {
  departamento: string;
  reconocido: boolean;
  pedidos: number;
  unidades: number;
  ingresos_brutos: number;
  devuelto: number;
  entregado: number;
  ingresos_netos: number;
  ticket_promedio: number | null;
  posicion: number;
  posicion_historica: number | null;
  pedidos_historicos: number;
  por_sucursal: { sucursal: string; sucursal_id: number; pedidos: number; unidades: number; ingresos: number }[];
}

export interface ShippingReport {
  definiciones: Record<string, string>;
  totales: { pedidos: number; unidades: number; ingresos_brutos: number; ingresos_netos: number; ticket_promedio: number | null; ventas_sin_envio_excluidas: number };
  respuestas: {
    mas_pedidos: { departamento: string; valor: number } | null;
    mas_unidades: { departamento: string; valor: number } | null;
    mas_ingresos: { departamento: string; valor: number } | null;
    la_paz: number;
    oruro: number;
  };
  departamentos: ShippingDepartment[];
  historico: { departamento: string; pedidos: number; unidades: number; posicion: number }[] | null;
  sin_reconocer: { valor: string; pedidos: number }[];
}

type Named<T> = T & { sucursal?: string };

export interface SummaryReport {
  definiciones: Record<string, string>;
  ventas: {
    completadas: number;
    unidades: number;
    ingresos_brutos: number;
    devoluciones_y_cambios_valor_devuelto: number;
    cambios_valor_entregado: number;
    ingresos_netos: number;
    ticket_promedio: number;
    por_sucursal: { sucursal: string; ventas: number; ingresos: number }[];
    por_modelo: { producto: string; unidades: number; ventas: number; ingresos: number }[];
    por_talla: { talla: string; unidades: number }[];
    por_color: { color: string; unidades: number }[];
  };
  traspasos: {
    referencias: number;
    unidades: number;
    unidades_recibidas: number;
    por_estado: { pendiente: number; enviado: number; recibido: number; cancelado: number };
    por_ruta: { origen: string; destino: string; traspasos: number; unidades: number }[];
    por_modelo: { producto: string; unidades: number }[];
    por_talla: { talla: string; unidades: number }[];
    por_color: { color: string; unidades: number }[];
  };
  devoluciones_y_cambios: {
    devoluciones: number;
    cambios: number;
    anulaciones: number;
    unidades_devueltas: number;
    unidades_cambiadas: number;
    unidades_entregadas_por_cambio: number;
    unidades_anuladas: number;
    por_motivo: { codigo: string; etiqueta: string; devoluciones: number; cambios: number; anulaciones: number; unidades: number }[];
    motivos_de_talla: number;
    modelos_mas_devueltos: { producto: string; unidades: number; operaciones: number }[];
    por_sucursal: Named<{ devoluciones: number; cambios: number; anulaciones: number }>[];
    por_usuario: { usuario: string; operaciones: number }[] | null;
    periodo_anterior: { desde: string; hasta: string; devoluciones: number; cambios: number; unidades_devueltas: number; unidades_cambiadas: number } | null;
  };
  movimientos: {
    por_categoria: { categoria: string; etiqueta: string; movimientos: number; unidades: number }[];
    unidades_ingresadas: number;
    unidades_vendidas: number;
    cambio_unidades_entrantes: number;
    cambio_unidades_salientes: number;
    unidades_devueltas_al_stock: number;
    unidades_en_cuarentena: number;
    salidas_autorizadas: number;
    traspaso_unidades_salidas: number;
    traspaso_unidades_entradas: number;
    ajustes_positivos: number;
    ajustes_negativos: number;
  };
}

const withQuery = (path: string, params: Record<string, unknown>) => {
  const q = buildQuery(params);
  return q ? `${path}?${q}` : path;
};

export const getModelReport = (filters: ModelFilters) => api.get<ModelReport>(withQuery("/api/reportes/modelos", { ...filters }));
export const getShippingReport = (filters: SaleScopeFilters) => api.get<ShippingReport>(withQuery("/api/reportes/envios", { ...filters }));
export const getSummaryReport = (filters: AnalyticsFilters) => api.get<SummaryReport>(withQuery("/api/reportes/resumen", { ...filters }));
