import { useEffect } from "react";
import { createPortal } from "react-dom";

import { formatFecha, type Rango } from "../../lib/periodos";
import type { ReportModel } from "../../lib/reportes";

interface ReporteImpresionProps {
  model: ReportModel;
  rango: Rango;
  sucursalTexto: string;
  generado: string;
  onDone: () => void;
}

/**
 * Vista de impresión del reporte. Vive fuera de #root (portal en body) y solo se muestra al imprimir:
 * ver `body.printing-reporte` en index.css. Se abre el diálogo nativo de impresión del navegador;
 * no genera ningún archivo PDF.
 */
export function ReporteImpresion({ model, rango, sucursalTexto, generado, onDone }: ReporteImpresionProps) {
  useEffect(() => {
    document.body.classList.add("printing-reporte");
    const finish = () => {
      document.body.classList.remove("printing-reporte");
      window.removeEventListener("afterprint", finish);
      onDone();
    };
    window.addEventListener("afterprint", finish);
    const timer = window.setTimeout(() => window.print(), 150);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", finish);
      document.body.classList.remove("printing-reporte");
    };
  }, [onDone]);

  return createPortal(
    <div className="reporte-print">
      <header className="reporte-cabecera">
        <div>
          <p className="reporte-marca">MISSI</p>
          <p className="reporte-titulo">{model.titulo}</p>
        </div>
        <div className="reporte-meta">
          <p>
            <b>Periodo:</b> {rango.desde ? `${formatFecha(rango.desde)} al ${formatFecha(rango.hasta)}` : "Stock a la fecha de generación"}
          </p>
          <p>
            <b>Sucursal(es):</b> {sucursalTexto}
          </p>
          <p>
            <b>Generado:</b> {new Date(generado).toLocaleString("es-BO", { timeZone: "America/La_Paz", hourCycle: "h23" })}
          </p>
        </div>
      </header>

      <section className="reporte-resumen">
        {model.resumen.map((r) => (
          <p key={r.label}>
            <span>{r.label}:</span> <b>{r.value}</b>
          </p>
        ))}
      </section>

      <table className="reporte-tabla">
        <thead>
          <tr>
            {model.columnas.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.filas.map((fila, i) => (
            <tr key={i}>
              {fila.map((celda, j) => (
                <td key={j} className={model.numericas.includes(j) ? "reporte-num" : undefined}>
                  {celda}
                </td>
              ))}
            </tr>
          ))}
          {model.filas.length === 0 && (
            <tr>
              <td colSpan={model.columnas.length} className="reporte-vacio">
                No hay datos en este periodo.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {model.nota && <p className="reporte-nota">{model.nota}</p>}
      <footer className="reporte-pie">MISSI · Documento generado desde el sistema de inventario y ventas</footer>
    </div>,
    document.body,
  );
}
