/**
 * Filtros del historial de ventas: estado de la pantalla → parámetros del servidor. Lógica pura y probada en Node.
 * Los filtros se envían al backend (la consulta, la paginación y los totales se calculan allí), nunca se aplican solo a la página cargada.
 */
import { resolverPeriodo, type PeriodoAnalisis } from "./periodoFiltro.ts";
import type { Rango } from "./periodos.ts";

export interface VentasFiltrosState {
  preset: PeriodoAnalisis;
  custom: Rango;
  estado: "" | "completada" | "cancelada";
  /** "MENU" = la sucursal elegida en el menú lateral; "TODAS" = toda la organización; o el id de una sucursal. */
  sucursal: "MENU" | "TODAS" | string;
  metodo: "" | "QR" | "efectivo";
  modalidad: "" | "entrega_directa" | "envio" | "envio_interprovincial";
  departamento: string;
  provincia: string;
  municipio: string;
  producto: string;
  talla: string;
  color: string;
  usuario: string;
  q: string;
}

export const FILTROS_VACIOS = (hoy: string): VentasFiltrosState => ({
  preset: "todo",
  custom: { desde: hoy, hasta: hoy },
  estado: "",
  sucursal: "MENU",
  metodo: "",
  modalidad: "",
  departamento: "",
  provincia: "",
  municipio: "",
  producto: "",
  talla: "",
  color: "",
  usuario: "",
  q: "",
});

/** Cantidad de filtros activos (sin contar el periodo "todo el historial" ni la sucursal del menú). */
export function filtrosActivos(f: VentasFiltrosState): number {
  const flags = [
    f.preset !== "todo",
    f.estado !== "",
    f.sucursal !== "MENU",
    f.metodo !== "",
    f.modalidad !== "",
    f.departamento !== "",
    f.provincia.trim() !== "",
    f.municipio.trim() !== "",
    f.producto !== "",
    f.talla !== "",
    f.color !== "",
    f.usuario !== "",
    f.q.trim() !== "",
  ];
  return flags.filter(Boolean).length;
}

export interface ContextoVentas {
  hoy: string;
  isAdmin: boolean;
  /** Sucursal del vendedor. */
  userBranchId: number | null;
  /** Sucursal elegida en el menú lateral (null = consolidado). */
  menuBranchId: number | null;
}

export interface FiltrosServidor {
  estado?: "completada" | "cancelada";
  sucursal_id?: number | null;
  desde?: string;
  hasta?: string;
  metodo_pago?: "QR" | "efectivo";
  modalidad?: "entrega_directa" | "envio" | "envio_interprovincial";
  departamento?: string;
  provincia?: string;
  municipio?: string;
  producto_id?: number | null;
  talla_id?: number | null;
  color_id?: number | null;
  usuario_id?: number | null;
  q?: string;
}

const num = (v: string) => (v ? Number(v) : null);

/** Convierte el estado de los filtros en parámetros del servidor, o devuelve el error del periodo. */
export function aFiltrosServidor(f: VentasFiltrosState, ctx: ContextoVentas): { filtros: FiltrosServidor; error: string | null } {
  const periodo = resolverPeriodo(f.preset, f.custom, ctx.hoy);
  if (periodo.error) return { filtros: {}, error: periodo.error };

  let sucursal: number | null;
  if (!ctx.isAdmin) sucursal = ctx.userBranchId; // el vendedor siempre queda en su sucursal
  else if (f.sucursal === "MENU") sucursal = ctx.menuBranchId;
  else if (f.sucursal === "TODAS") sucursal = null;
  else sucursal = Number(f.sucursal);

  return {
    error: null,
    filtros: {
      estado: f.estado || undefined,
      sucursal_id: sucursal,
      desde: periodo.desde,
      hasta: periodo.hasta,
      metodo_pago: f.metodo || undefined,
      modalidad: f.modalidad || undefined,
      departamento: f.departamento || undefined,
      provincia: f.provincia.trim() || undefined,
      municipio: f.municipio.trim() || undefined,
      producto_id: num(f.producto),
      talla_id: num(f.talla),
      color_id: num(f.color),
      usuario_id: ctx.isAdmin ? num(f.usuario) : null,
      q: f.q.trim() || undefined,
    },
  };
}
