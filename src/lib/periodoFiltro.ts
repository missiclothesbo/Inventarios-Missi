import { PERIODO_TEXT, rangoPreset, validarRango, type PeriodoPreset, type Rango } from "./periodos.ts";

/** Periodos de las pantallas de análisis: los de siempre + todo el historial. */
export type PeriodoAnalisis = PeriodoPreset | "todo";

export const PERIODOS_ANALISIS: PeriodoAnalisis[] = [
  "hoy",
  "ayer",
  "semana_actual",
  "semana_anterior",
  "mes_actual",
  "mes_anterior",
  "anio_actual",
  "todo",
  "personalizado",
];

export const PERIODO_ANALISIS_TEXT: Record<PeriodoAnalisis, string> = {
  ...PERIODO_TEXT,
  todo: "Todo el historial",
};

export interface PeriodoResuelto {
  /** Sin desde/hasta = todo el historial. */
  desde?: string;
  hasta?: string;
  error: string | null;
}

/** Convierte la selección en fechas AAAA-MM-DD (día de Bolivia, extremos incluidos). */
export function resolverPeriodo(preset: PeriodoAnalisis, custom: Rango, hoy: string): PeriodoResuelto {
  if (preset === "todo") return { error: null };
  const rango = preset === "personalizado" ? custom : rangoPreset(preset, hoy);
  if (!rango) return { error: "Elige las fechas del periodo." };
  const error = validarRango(rango);
  return error ? { error } : { desde: rango.desde, hasta: rango.hasta, error: null };
}
