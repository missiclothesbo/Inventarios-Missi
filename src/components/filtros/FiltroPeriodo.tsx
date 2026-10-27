import { PERIODOS_ANALISIS, PERIODO_ANALISIS_TEXT, type PeriodoAnalisis } from "../../lib/periodoFiltro";
import type { Rango } from "../../lib/periodos";

export const FILTRO_INPUT =
  "w-full min-h-11 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-black outline-none focus:border-black disabled:bg-gray-100 disabled:text-gray-400";

interface FiltroPeriodoProps {
  preset: PeriodoAnalisis;
  custom: Rango;
  onPreset: (value: PeriodoAnalisis) => void;
  onCustom: (value: Rango) => void;
  error?: string | null;
}

/** Periodo (hoy, ayer, semanas, meses, año, todo el historial o rango propio). Fechas de Bolivia, extremos incluidos. */
export function FiltroPeriodo({ preset, custom, onPreset, onCustom, error }: FiltroPeriodoProps) {
  return (
    <>
      <label className="text-xs font-medium text-gray-600">
        Periodo
        <select className={`${FILTRO_INPUT} mt-1`} value={preset} onChange={(e) => onPreset(e.target.value as PeriodoAnalisis)}>
          {PERIODOS_ANALISIS.map((p) => (
            <option key={p} value={p}>
              {PERIODO_ANALISIS_TEXT[p]}
            </option>
          ))}
        </select>
      </label>

      {preset === "personalizado" && (
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          <label className="text-xs font-medium text-gray-600">
            Desde
            <input type="date" className={`${FILTRO_INPUT} mt-1`} value={custom.desde} onChange={(e) => onCustom({ ...custom, desde: e.target.value })} />
          </label>
          <label className="text-xs font-medium text-gray-600">
            Hasta (incluido)
            <input type="date" className={`${FILTRO_INPUT} mt-1`} value={custom.hasta} onChange={(e) => onCustom({ ...custom, hasta: e.target.value })} />
          </label>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-red-600 sm:col-span-2 lg:col-span-4">
          {error}
        </p>
      )}
    </>
  );
}
