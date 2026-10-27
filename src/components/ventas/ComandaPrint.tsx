import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import {
  MODE_LABELS,
  PAYMENT_LABELS,
  formatDestination,
  type Sale,
  type SaleDetail,
} from "../../services/sales.service";
import { formatBoliviaDateTime, saleNumber } from "../../lib/receipt";

export interface ComandaLine extends SaleDetail {
  producto_nombre: string;
  talla_nombre: string;
  color_nombre: string;
}

interface ComandaPrintProps {
  sale: Sale;
  lines: ComandaLine[];
  branchName: string;
  onDone: () => void;
}

function money(value: number) {
  return `Bs ${value.toFixed(2)}`;
}

/**
 * Comanda de UNA venta. Se renderiza en un portal bajo <body> y, al imprimir,
 * las reglas @media print de index.css ocultan el resto de la aplicación.
 */
function ComandaPrint({ sale, lines, branchName, onDone }: ComandaPrintProps) {
  const doneRef = useRef(onDone);

  useEffect(() => {
    doneRef.current = onDone;
  });

  useEffect(() => {
    document.body.classList.add("printing-comanda");

    const finish = () => {
      document.body.classList.remove("printing-comanda");
      window.removeEventListener("afterprint", finish);
      doneRef.current();
    };

    window.addEventListener("afterprint", finish);

    const timer = window.setTimeout(() => window.print(), 100);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", finish);
      document.body.classList.remove("printing-comanda");
    };
  }, []);

  return createPortal(
    <div className="comanda-print" style={{ fontFamily: "Arial, sans-serif", color: "#000", fontSize: "12px" }}>
      <h1 style={{ margin: 0, fontSize: "18px" }}>MISSI — COMANDA DE VENTA</h1>
      <p style={{ margin: "2px 0 0" }}><b>Venta: {saleNumber(sale.id)}</b></p>
      <p style={{ margin: "2px 0 10px" }}>{branchName}</p>

      <table style={{ width: "100%", marginBottom: "8px" }}>
        <tbody>
          <tr><td><b>Fecha:</b></td><td>{formatBoliviaDateTime(sale.fecha)}</td></tr>
          {sale.vendedor && <tr><td><b>Vendedor:</b></td><td>{sale.vendedor}</td></tr>}
          <tr><td><b>Cliente:</b></td><td>{sale.cliente_nombre ?? "—"}{sale.cliente_telefono ? ` · ${sale.cliente_telefono}` : ""}</td></tr>
          <tr><td><b>Pago:</b></td><td>{sale.metodo_pago ? PAYMENT_LABELS[sale.metodo_pago] : "Sin registrar"}</td></tr>
          <tr><td><b>Modalidad:</b></td><td>{sale.modalidad ? MODE_LABELS[sale.modalidad] : "Sin registrar"}</td></tr>
          <tr><td style={{ verticalAlign: "top" }}><b>Destino:</b></td><td>{formatDestination(sale)}</td></tr>
          {sale.observaciones && (
            <tr><td style={{ verticalAlign: "top" }}><b>Notas:</b></td><td>{sale.observaciones}</td></tr>
          )}
          {sale.referencias && (
            <tr><td style={{ verticalAlign: "top" }}><b>Referencias:</b></td><td>{sale.referencias}</td></tr>
          )}
          {sale.estado === "cancelada" && (
            <tr><td><b>ESTADO:</b></td><td><b>CANCELADA</b> — {sale.motivo_cancelacion}</td></tr>
          )}
        </tbody>
      </table>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #000", textAlign: "left" }}>
            <th>Producto</th>
            <th>Talla</th>
            <th>Color</th>
            <th style={{ textAlign: "right" }}>Cant.</th>
            <th style={{ textAlign: "right" }}>P. unit.</th>
            <th style={{ textAlign: "right" }}>Subtotal</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} style={{ borderBottom: "1px dotted #999" }}>
              <td>{line.producto_nombre}</td>
              <td>{line.talla_nombre}</td>
              <td>{line.color_nombre}</td>
              <td style={{ textAlign: "right" }}>{line.cantidad}</td>
              <td style={{ textAlign: "right" }}>{money(line.precio_unitario)}</td>
              <td style={{ textAlign: "right" }}>{money(line.subtotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ textAlign: "right", marginTop: "10px", marginBottom: 0 }}>
        TOTAL DE UNIDADES: <b>{lines.reduce((sum, line) => sum + line.cantidad, 0)}</b>
      </p>
      <p style={{ textAlign: "right", fontSize: "16px", marginTop: "4px" }}>
        <b>TOTAL A PAGAR: {money(sale.total)}</b>
      </p>
    </div>,
    document.body,
  );
}

export default ComandaPrint;
