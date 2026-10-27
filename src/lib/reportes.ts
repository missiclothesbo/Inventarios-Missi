/**
 * Modelos de reporte: convierten los datos reales del servidor en un formato único (resumen + tabla)
 * que usan la pantalla y la impresión. Nada se inventa: cada cifra sale de una fila o de un total del servidor.
 */
import type { Balance } from "../services/reports.service.ts";
import type { Sale } from "../services/sales.service.ts";
import type { OperationResult } from "../services/operations.service.ts";
import { BOLIVIA_TZ, formatFecha, type Rango } from "./periodos.ts";

export type ReportType = "resumen" | "ventas" | "operaciones" | "movimientos" | "stock";

export const REPORT_TEXT: Record<ReportType, string> = {
  resumen: "Resumen de ventas y pagos",
  ventas: "Detalle de ventas",
  operaciones: "Devoluciones, cambios y anulaciones",
  movimientos: "Movimientos de inventario",
  stock: "Stock actual",
};

export interface ReportModel {
  titulo: string;
  tipo: ReportType;
  resumen: { label: string; value: string }[];
  columnas: string[];
  filas: (string | number)[][];
  /** índices de columnas numéricas (alineadas a la derecha) */
  numericas: number[];
  nota?: string;
}

/** Monto en bolivianos con formato boliviano: Bs 1.234,56 (negativo: -Bs 12,00). */
export function formatBs(value: number): string {
  const abs = Math.abs(value).toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0 ? "-" : ""}Bs ${abs}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const fechaHora = (iso: string) =>
  new Date(iso).toLocaleString("es-BO", { timeZone: BOLIVIA_TZ, hourCycle: "h23", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

// ----------------------------------------------------------------- resumen de ventas y pagos

export function buildResumenModel(b: Balance, rango: Rango, sucursalTexto: string): ReportModel {
  const o = b.operaciones;
  const filas: (string | number)[][] = [];
  const addGroup = (grupo: string, rows: Balance["por_metodo"]) => {
    const total = b.resumen.ingresos;
    for (const r of rows) {
      filas.push([grupo, r.clave, r.ventas, formatBs(r.ingresos), total > 0 ? `${((r.ingresos / total) * 100).toFixed(1)}%` : "—"]);
    }
  };
  addGroup("Método de pago", b.por_metodo);
  addGroup("Sucursal", b.por_sucursal);
  addGroup("Modalidad", b.por_modalidad);
  addGroup("Departamento", b.por_departamento);
  for (const p of b.top_productos) filas.push(["Producto", p.producto, p.unidades, formatBs(p.ingresos), "—"]);

  return {
    titulo: REPORT_TEXT.resumen,
    tipo: "resumen",
    resumen: [
      { label: "Ventas completadas", value: String(b.resumen.ventas) },
      { label: "Ingresos brutos", value: formatBs(b.resumen.ingresos) },
      { label: "Devoluciones (valor)", value: formatBs(o.valor_devuelto) },
      { label: "Cambios entregados (valor)", value: formatBs(o.valor_cambio_entregado) },
      { label: "Ingreso neto", value: formatBs(o.ingresos_netos) },
      { label: "Ticket promedio", value: formatBs(b.resumen.ticket_promedio) },
      { label: "Unidades vendidas", value: String(b.resumen.unidades) },
      { label: "Cobros de diferencia (completados)", value: formatBs(o.cobros_completados) },
      { label: "Reembolsos entregados", value: formatBs(o.reembolsos_completados) },
      { label: "Reembolsos pendientes", value: formatBs(o.reembolsos_pendientes) },
      { label: "Créditos pendientes", value: formatBs(o.creditos_pendientes) },
      { label: "Anulaciones", value: `${o.anulaciones} por ${formatBs(o.valor_anulado)}` },
    ],
    columnas: ["Grupo", "Detalle", "Ventas / unidades", "Ingresos", "Proporción"],
    filas,
    numericas: [2],
    nota: `Periodo ${formatFecha(rango.desde)} al ${formatFecha(rango.hasta)} · ${sucursalTexto}. Ingreso neto = ingresos brutos − devoluciones + cambios entregados. Las anulaciones se informan aparte y no suman a ingresos.`,
  };
}

// ----------------------------------------------------------------- detalle de ventas

export function buildVentasModel(ventas: Sale[], nombreSucursal: (id: number) => string, rango: Rango, sucursalTexto: string, truncado: boolean): ReportModel {
  const completadas = ventas.filter((v) => v.estado === "completada");
  const anuladas = ventas.filter((v) => v.estado === "cancelada");
  const bruto = round2(completadas.reduce((a, v) => a + v.total, 0));
  const pago = (m: Sale["metodo_pago"]) => (m === "QR" ? "QR" : m === "efectivo" ? "Efectivo" : "Sin registrar");
  const entrega = (m: Sale["modalidad"]) =>
    m === "entrega_directa" ? "Entrega directa" : m === "envio" ? "Envío" : m === "envio_interprovincial" ? "Interprovincial" : "Sin registrar";

  return {
    titulo: REPORT_TEXT.ventas,
    tipo: "ventas",
    resumen: [
      { label: "Ventas completadas", value: String(completadas.length) },
      { label: "Total de ventas completadas", value: formatBs(bruto) },
      { label: "Ventas anuladas (no suman)", value: String(anuladas.length) },
    ],
    columnas: ["N.º", "Fecha y hora", "Sucursal", "Cliente", "Teléfono", "Pago", "Entrega", "Estado", "Total"],
    filas: ventas.map((v) => [
      v.id,
      fechaHora(v.fecha),
      nombreSucursal(v.sucursal_id),
      v.cliente_nombre ?? "—",
      v.cliente_telefono ?? "—",
      pago(v.metodo_pago),
      entrega(v.modalidad),
      v.estado === "completada" ? "Completada" : "Anulada",
      formatBs(v.total),
    ]),
    numericas: [8],
    nota: `Periodo ${formatFecha(rango.desde)} al ${formatFecha(rango.hasta)} · ${sucursalTexto}.${truncado ? " Listado limitado a 500 ventas: acota el periodo para ver el detalle completo." : ""}`,
  };
}

// ----------------------------------------------------------------- devoluciones, cambios y anulaciones

export function buildOperacionesModel(ops: OperationResult[], nombreSucursal: (id: number) => string, rango: Rango, sucursalTexto: string, truncado: boolean): ReportModel {
  const tipo = (t: OperationResult["tipo"]) => (t === "devolucion" ? "Devolución" : t === "cambio" ? "Cambio" : "Anulación");
  const suma = (f: (o: OperationResult) => boolean, g: (o: OperationResult) => number) => round2(ops.filter(f).reduce((a, o) => a + g(o), 0));
  const devueltos = suma((o) => o.tipo !== "anulacion", (o) => o.valor_devuelto);
  const entregados = suma((o) => o.tipo === "cambio", (o) => o.valor_entregado);
  const reembolsadoOk = suma((o) => o.pago.tipo === "reembolso" && o.pago.estado === "completado", (o) => o.pago.monto);
  const reembolsoPend = suma((o) => o.pago.tipo === "reembolso" && o.pago.estado === "pendiente", (o) => o.pago.monto);
  const cobrado = suma((o) => o.pago.tipo === "cobro" && o.pago.estado === "completado", (o) => o.pago.monto);

  return {
    titulo: REPORT_TEXT.operaciones,
    tipo: "operaciones",
    resumen: [
      { label: "Devoluciones", value: String(ops.filter((o) => o.tipo === "devolucion").length) },
      { label: "Cambios", value: String(ops.filter((o) => o.tipo === "cambio").length) },
      { label: "Anulaciones", value: String(ops.filter((o) => o.tipo === "anulacion").length) },
      { label: "Valor devuelto", value: formatBs(devueltos) },
      { label: "Valor de cambios entregados", value: formatBs(entregados) },
      { label: "Cobros de diferencia (completados)", value: formatBs(cobrado) },
      { label: "Reembolsos entregados", value: formatBs(reembolsadoOk) },
      { label: "Reembolsos pendientes", value: formatBs(reembolsoPend) },
    ],
    columnas: ["N.º op.", "Fecha y hora", "Tipo", "Venta N.º", "Sucursal", "Operador", "Motivo", "Valor devuelto", "Valor entregado", "Diferencia", "Pago"],
    filas: ops.map((o) => [
      o.id,
      fechaHora(o.fecha),
      tipo(o.tipo),
      o.venta_id,
      nombreSucursal(o.sucursal_id),
      o.operador,
      o.motivo,
      formatBs(o.valor_devuelto),
      o.tipo === "cambio" ? formatBs(o.valor_entregado) : "—",
      formatBs(o.diferencia),
      o.pago.tipo === "ninguno" ? "No aplica" : `${o.pago.tipo} (${o.pago.estado})${o.pago.metodo ? ` · ${o.pago.metodo === "qr" ? "QR" : "Efectivo"}` : ""}`,
    ]),
    numericas: [7, 8, 9],
    nota: `Periodo ${formatFecha(rango.desde)} al ${formatFecha(rango.hasta)} · ${sucursalTexto}. Los montos de devolución y cambio son del periodo; la venta original no se modifica.${truncado ? " Listado limitado a 200 operaciones: acota el periodo." : ""}`,
  };
}

// ----------------------------------------------------------------- movimientos de inventario

export interface MovimientosData {
  total_movimientos: number;
  truncado: boolean;
  totales: { tipo: string; referencia: string; movimientos: number; unidades: number }[];
  filas: { fecha: string; sucursal: string; producto: string; talla: string; color: string; tipo: string; efecto: string; cantidad: number; referencia: string; observaciones: string }[];
}

export function buildMovimientosModel(m: MovimientosData, rango: Rango, sucursalTexto: string): ReportModel {
  const suma = (efecto: string) => m.filas.filter((f) => f.efecto === efecto).reduce((a, f) => a + f.cantidad, 0);
  return {
    titulo: REPORT_TEXT.movimientos,
    tipo: "movimientos",
    resumen: [
      { label: "Movimientos", value: String(m.total_movimientos) },
      { label: "Unidades que entran al stock", value: String(suma("Entrada")) },
      { label: "Unidades que salen del stock", value: String(suma("Salida")) },
      { label: "Prendas dañadas (no se venden)", value: String(suma("Cuarentena (no vendible)")) },
    ],
    columnas: ["Fecha y hora", "Sucursal", "Modelo", "Talla", "Color", "Movimiento", "Efecto", "Cantidad", "Referencia", "Observaciones"],
    filas: m.filas.map((f) => [f.fecha, f.sucursal, f.producto, f.talla, f.color, f.tipo, f.efecto, f.cantidad, f.referencia, f.observaciones]),
    numericas: [7],
    nota: `Periodo ${formatFecha(rango.desde)} al ${formatFecha(rango.hasta)} · ${sucursalTexto}.${m.truncado ? " Listado limitado a 2000 movimientos: acota el periodo." : ""}`,
  };
}

// ----------------------------------------------------------------- stock actual

export interface StockData {
  generado: string;
  totales_por_sucursal: { sucursal: string; vendible: number; danado: number }[];
  filas: { sucursal: string; producto: string; talla: string; color: string; estado: string; cantidad: number }[];
}

export function buildStockModel(s: StockData, sucursalTexto: string): ReportModel {
  return {
    titulo: REPORT_TEXT.stock,
    tipo: "stock",
    resumen: s.totales_por_sucursal.flatMap((t) => [
      { label: `${t.sucursal}: unidades para vender`, value: String(t.vendible) },
      { label: `${t.sucursal}: dañadas`, value: String(t.danado) },
    ]),
    columnas: ["Sucursal", "Modelo", "Talla", "Color", "Estado", "Cantidad"],
    filas: s.filas.map((f) => [f.sucursal, f.producto, f.talla, f.color, f.estado, f.cantidad]),
    numericas: [5],
    nota: `Stock al momento de generar el reporte (${fechaHora(s.generado)}) · ${sucursalTexto}. No depende del periodo.`,
  };
}
