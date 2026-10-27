import { useMemo, useState } from "react";
import { BarChart3, LoaderCircle, Printer, RefreshCw } from "lucide-react";

import { useAuth } from "../../context/useAuth";
import { useSucursal } from "../../context/useSucursal";
import { PERIODO_TEXT, diasEnRango, formatFecha, hoyBolivia, rangoPreset, validarRango, type PeriodoPreset, type Rango } from "../../lib/periodos";
import {
  REPORT_TEXT,
  buildMovimientosModel,
  buildOperacionesModel,
  buildResumenModel,
  buildStockModel,
  buildVentasModel,
  type ReportModel,
  type ReportType,
} from "../../lib/reportes";
import { getBalancePeriodo, getMovimientosPeriodo, getStockActual } from "../../services/reports.service";
import { getSalesPeriodo } from "../../services/sales.service";
import { listOperationsPeriodo } from "../../services/operations.service";
import { ReporteImpresion } from "../../components/reportes/ReporteImpresion";
import Analisis from "./Analisis";

const INPUT = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-black outline-none focus:border-black disabled:bg-gray-100 disabled:text-gray-400";

const PRESETS: PeriodoPreset[] = ["hoy", "ayer", "semana_actual", "semana_anterior", "mes_actual", "mes_anterior", "anio_actual", "personalizado"];

interface Generated {
  model: ReportModel;
  rango: Rango | null;
  sucursalTexto: string;
  generado: string;
}

function ReportesBalance() {
  const { user } = useAuth();
  const { branches, selectedId } = useSucursal();
  const isAdmin = user?.rol === "admin";

  const [tipo, setTipo] = useState<ReportType>("resumen");
  const [preset, setPreset] = useState<PeriodoPreset>("mes_actual");
  const [custom, setCustom] = useState<Rango>({ desde: hoyBolivia(), hasta: hoyBolivia() });
  // Administrador: por defecto la sucursal elegida en el menú (vacío = consolidado). Vendedor: siempre la suya.
  const [sucursalSel, setSucursalSel] = useState<number | null>(isAdmin ? selectedId : (user?.sucursal_id ?? null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<Generated | null>(null);
  const [printing, setPrinting] = useState(false);

  const sucursalId = isAdmin ? sucursalSel : (user?.sucursal_id ?? null);
  const nombreSucursal = (id: number) => branches.find((b) => b.id === id)?.nombre ?? "—";
  const sucursalTexto = sucursalId === null ? "Todas las sucursales" : nombreSucursal(sucursalId);
  const esStock = tipo === "stock";

  const rangoActual: Rango | null = useMemo(
    () => (preset === "personalizado" ? custom : rangoPreset(preset, hoyBolivia())),
    [preset, custom],
  );
  const errorRango = esStock ? null : rangoActual ? validarRango(rangoActual) : "Elige las fechas del periodo.";

  async function generar() {
    setError("");
    setPrinting(false);
    if (!esStock && (errorRango || !rangoActual)) {
      setError(errorRango ?? "Periodo inválido.");
      setReport(null);
      return;
    }
    setLoading(true);
    try {
      const generado = new Date().toISOString();
      let model: ReportModel;
      if (tipo === "stock") {
        model = buildStockModel(await getStockActual(sucursalId), sucursalTexto);
        setReport({ model, rango: null, sucursalTexto, generado });
        return;
      }
      const rango = rangoActual!;
      if (tipo === "resumen") {
        model = buildResumenModel(await getBalancePeriodo({ ...rango, sucursalId }), rango, sucursalTexto);
      } else if (tipo === "ventas") {
        const { ventas, truncado } = await getSalesPeriodo(rango.desde, rango.hasta, sucursalId);
        model = buildVentasModel(ventas, nombreSucursal, rango, sucursalTexto, truncado);
      } else if (tipo === "operaciones") {
        const { operaciones, truncado } = await listOperationsPeriodo(rango.desde, rango.hasta, sucursalId);
        model = buildOperacionesModel(operaciones, nombreSucursal, rango, sucursalTexto, truncado);
      } else {
        model = buildMovimientosModel(await getMovimientosPeriodo({ ...rango, sucursalId }), rango, sucursalTexto);
      }
      setReport({ model, rango, sucursalTexto, generado });
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : "No se pudo generar el reporte.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="space-y-4 sm:space-y-6">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <BarChart3 size={20} className="text-gray-700" />
            <span className="text-sm font-medium text-gray-500">Análisis del negocio</span>
          </div>
          <h1 className="text-xl font-semibold text-black sm:text-2xl">Reportes</h1>
          <p className="mt-1 text-sm text-gray-500">Elige el tipo de reporte y el periodo. Las cifras salen de las ventas y movimientos guardados (hora de Bolivia).</p>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void generar();
        }}
        className="grid gap-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5 md:grid-cols-2 xl:grid-cols-4"
      >
        <label className="text-xs font-medium text-gray-600">
          Tipo de reporte
          <select className={`${INPUT} mt-1`} value={tipo} onChange={(e) => setTipo(e.target.value as ReportType)}>
            {(Object.keys(REPORT_TEXT) as ReportType[]).map((t) => (
              <option key={t} value={t}>
                {REPORT_TEXT[t]}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-medium text-gray-600">
          Periodo
          <select className={`${INPUT} mt-1`} value={preset} onChange={(e) => setPreset(e.target.value as PeriodoPreset)} disabled={esStock}>
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {PERIODO_TEXT[p]}
              </option>
            ))}
          </select>
        </label>

        {preset === "personalizado" && !esStock && (
          <div className="grid grid-cols-2 gap-3 md:col-span-2 xl:col-span-2">
            <label className="text-xs font-medium text-gray-600">
              Desde
              <input type="date" className={`${INPUT} mt-1`} value={custom.desde} max={custom.hasta} onChange={(e) => setCustom((c) => ({ ...c, desde: e.target.value }))} />
            </label>
            <label className="text-xs font-medium text-gray-600">
              Hasta (incluido)
              <input type="date" className={`${INPUT} mt-1`} value={custom.hasta} min={custom.desde} onChange={(e) => setCustom((c) => ({ ...c, hasta: e.target.value }))} />
            </label>
          </div>
        )}

        <label className="text-xs font-medium text-gray-600">
          Sucursal
          {isAdmin ? (
            <select
              className={`${INPUT} mt-1`}
              value={sucursalSel ?? ""}
              onChange={(e) => setSucursalSel(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Todas las sucursales</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.nombre}
                </option>
              ))}
            </select>
          ) : (
            <input className={`${INPUT} mt-1`} value={sucursalTexto} disabled readOnly />
          )}
        </label>

        <div className="grid gap-3 sm:flex sm:flex-wrap sm:items-end md:col-span-2 xl:col-span-4">
          <button
            type="submit"
            disabled={loading || (!esStock && !!errorRango)}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-black px-5 py-2.5 text-sm font-semibold tracking-wide text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300 sm:min-h-11"
          >
            {loading ? <LoaderCircle size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            GENERAR REPORTE
          </button>
          <button
            type="button"
            onClick={() => setPrinting(true)}
            disabled={!report || loading}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-black px-5 py-2.5 text-sm font-semibold tracking-wide text-black hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:border-gray-300 disabled:text-gray-400 sm:min-h-11"
          >
            <Printer size={16} /> IMPRIMIR REPORTE
          </button>
          {!esStock && rangoActual && !errorRango && (
            <p className="text-xs text-gray-500">
              {formatFecha(rangoActual.desde)} al {formatFecha(rangoActual.hasta)} · {diasEnRango(rangoActual)} día(s)
            </p>
          )}
          {esStock && <p className="text-xs text-gray-500">El stock actual no depende del periodo.</p>}
        </div>

        {!esStock && errorRango && <p className="text-sm text-red-600 md:col-span-2 xl:col-span-4">{errorRango}</p>}
      </form>

      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {loading && (
        <div className="flex min-h-[200px] items-center justify-center gap-3 text-gray-500">
          <LoaderCircle size={22} className="animate-spin" /> Generando reporte...
        </div>
      )}

      {!loading && !report && !error && (
        <p className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          Elige el tipo de reporte y el periodo, luego pulsa GENERAR REPORTE.
        </p>
      )}

      {report && !loading && (
        <div className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
            <h2 className="text-lg font-semibold text-black">{report.model.titulo}</h2>
            <p className="text-xs text-gray-500">
              {report.rango ? `${formatFecha(report.rango.desde)} al ${formatFecha(report.rango.hasta)} · ` : ""}
              {report.sucursalTexto}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
              {report.model.resumen.map((r) => (
                <div key={r.label} className="rounded-lg border border-gray-200 p-3">
                  <p className="text-xs text-gray-500">{r.label}</p>
                  <p className="mt-1 font-semibold text-black">{r.value}</p>
                </div>
              ))}
            </div>
            {report.model.nota && <p className="mt-3 text-xs text-gray-500">{report.model.nota}</p>}
          </div>

          <div className="rounded-xl border border-gray-200 bg-white">
            {report.model.filas.length === 0 ? (
              <p className="p-6 text-center text-sm text-gray-500">No hay datos en este periodo con estos filtros.</p>
            ) : (
              <>
                {/* Móvil: cada fila como tarjeta con sus etiquetas (los mismos datos que la tabla). */}
                <ul className="divide-y divide-gray-100 md:hidden">
                  {report.model.filas.map((fila, i) => (
                    <li key={i} className="p-4">
                      <p className="font-medium text-black">{fila[0] || "—"}</p>
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                        {fila.slice(1).map((celda, k) => {
                          const j = k + 1;
                          const numerica = report.model.numericas.includes(j);
                          return (
                            <div key={j} className="min-w-0">
                              <dt className="text-xs text-gray-500">{report.model.columnas[j]}</dt>
                              <dd className={numerica ? "font-semibold text-black" : "text-gray-800"}>{celda === "" ? "—" : celda}</dd>
                            </div>
                          );
                        })}
                      </dl>
                    </li>
                  ))}
                </ul>

                {/* Tablet y escritorio: tabla; por debajo de 1280 px se desplaza dentro de su recuadro. */}
                <p className="hidden border-b border-gray-100 px-3 py-2 text-xs text-gray-500 md:block xl:hidden">
                  Desliza la tabla hacia los lados para ver todas las columnas.
                </p>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                      <tr>
                        {report.model.columnas.map((c, j) => (
                          <th key={c} className={`px-3 py-2 ${report.model.numericas.includes(j) ? "text-right" : ""}`}>
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {report.model.filas.map((fila, i) => (
                        <tr key={i}>
                          {fila.map((celda, j) => (
                            <td key={j} className={`px-3 py-2 ${report.model.numericas.includes(j) ? "whitespace-nowrap text-right" : ""}`}>
                              {celda}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {printing && report && (
        <ReporteImpresion
          model={report.model}
          rango={report.rango ?? { desde: "", hasta: "" }}
          sucursalTexto={report.sucursalTexto}
          generado={report.generado}
          onDone={() => setPrinting(false)}
        />
      )}
    </section>
  );
}

/** Reportes: informes imprimibles por periodo + análisis (modelos, envíos y resumen consolidado). */
function Reportes() {
  const [section, setSection] = useState<"informes" | "analisis">("analisis");
  return (
    <div className="space-y-4 sm:space-y-6">
      <div role="tablist" aria-label="Sección de reportes" className="flex gap-2">
        {([["analisis", "Análisis"], ["informes", "Informes imprimibles"]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={section === key}
            onClick={() => setSection(key)}
            className={`min-h-11 rounded-lg border px-4 text-sm font-medium transition ${section === key ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-700 hover:border-black"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {section === "analisis" ? (
        <section className="space-y-4">
          <div>
            <h1 className="text-xl font-semibold text-black sm:text-2xl">Reportes</h1>
            <p className="mt-1 text-sm text-gray-500">Cifras calculadas en la base de datos con fechas de Bolivia. Ventas, traspasos, devoluciones y movimientos se muestran por separado.</p>
          </div>
          <Analisis />
        </section>
      ) : (
        <ReportesBalance />
      )}
    </div>
  );
}

export default Reportes;
