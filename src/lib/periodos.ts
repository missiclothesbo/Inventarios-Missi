/**
 * Periodos de reporte en fecha local de Bolivia (America/La_Paz, UTC-4, sin horario de verano).
 * Todas las fechas son AAAA-MM-DD; la aritmética se hace en UTC para no depender de la zona del equipo.
 * Semana: de lunes a domingo. "Semana actual" y "mes actual" y "año actual" llegan hasta hoy (sin fechas futuras).
 */

export const BOLIVIA_TZ = "America/La_Paz";

export type PeriodoPreset =
  | "hoy"
  | "ayer"
  | "semana_actual"
  | "semana_anterior"
  | "mes_actual"
  | "mes_anterior"
  | "anio_actual"
  | "personalizado";

export const PERIODO_TEXT: Record<PeriodoPreset, string> = {
  hoy: "Hoy",
  ayer: "Ayer",
  semana_actual: "Semana actual",
  semana_anterior: "Semana anterior",
  mes_actual: "Mes actual",
  mes_anterior: "Mes anterior",
  anio_actual: "Año actual",
  personalizado: "Rango personalizado",
};

export interface Rango {
  desde: string;
  hasta: string;
}

const DAY = 86_400_000;

/** Fecha de hoy en Bolivia (AAAA-MM-DD), independiente de la zona horaria del navegador. */
export function hoyBolivia(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BOLIVIA_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const toMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number) => fromMs(toMs(ymd) + n * DAY);

/** Lunes de la semana de la fecha dada. */
export function lunes(ymd: string): string {
  const dow = (new Date(toMs(ymd)).getUTCDay() + 6) % 7; // lunes = 0
  return addDays(ymd, -dow);
}

export function inicioMes(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

export function finMes(ymd: string): string {
  const [y, m] = ymd.split("-").map(Number);
  return fromMs(Date.UTC(y, m, 0));
}

/** Rango de un preset. "personalizado" no tiene rango automático (lo elige el usuario). */
export function rangoPreset(preset: PeriodoPreset, hoy: string): Rango | null {
  switch (preset) {
    case "hoy":
      return { desde: hoy, hasta: hoy };
    case "ayer":
      return { desde: addDays(hoy, -1), hasta: addDays(hoy, -1) };
    case "semana_actual":
      return { desde: lunes(hoy), hasta: hoy };
    case "semana_anterior": {
      const inicio = lunes(hoy);
      return { desde: addDays(inicio, -7), hasta: addDays(inicio, -1) };
    }
    case "mes_actual":
      return { desde: inicioMes(hoy), hasta: hoy };
    case "mes_anterior": {
      const ultimoMesAnterior = addDays(inicioMes(hoy), -1);
      return { desde: inicioMes(ultimoMesAnterior), hasta: finMes(ultimoMesAnterior) };
    }
    case "anio_actual":
      return { desde: `${hoy.slice(0, 4)}-01-01`, hasta: hoy };
    case "personalizado":
      return null;
  }
}

/** Mensaje de error del rango, o null si es válido. */
export function validarRango(rango: Rango): string | null {
  if (!isYmd(rango.desde) || !isYmd(rango.hasta)) return "Indica las dos fechas (desde y hasta).";
  if (rango.desde > rango.hasta) return "La fecha inicial no puede ser posterior a la fecha final.";
  return null;
}

/** Cuántos días abarca el rango (ambos extremos incluidos). */
export function diasEnRango(rango: Rango): number {
  return Math.round((toMs(rango.hasta) - toMs(rango.desde)) / DAY) + 1;
}

export function formatFecha(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}
