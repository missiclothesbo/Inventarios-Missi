import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Printer } from "lucide-react";

import {
  MODE_TEXT,
  PAYMENT_TEXT,
  deliveryText,
  formatBoliviaDateTime,
  money,
  saleNumber,
  totalUnits,
  type SaleReceipt,
} from "../../lib/receipt";

/** Vista de impresión (80 mm). Solo es visible al imprimir: ver `.recibo-print` en index.css. */
function ReciboImpresion({ receipt, onDone }: { receipt: SaleReceipt; onDone: () => void }) {
  const doneRef = useRef(onDone);

  useEffect(() => {
    doneRef.current = onDone;
  });

  useEffect(() => {
    document.body.classList.add("printing-recibo");

    const finish = () => {
      document.body.classList.remove("printing-recibo");
      window.removeEventListener("afterprint", finish);
      doneRef.current();
    };

    window.addEventListener("afterprint", finish);
    const timer = window.setTimeout(() => window.print(), 100);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", finish);
      document.body.classList.remove("printing-recibo");
    };
  }, []);

  const delivery = deliveryText(receipt);

  return createPortal(
    <div className="recibo-print">
      <p className="recibo-centro recibo-grande">MISSI</p>
      {receipt.sucursal && <p className="recibo-centro">{receipt.sucursal}</p>}
      <p className="recibo-linea" />
      <p>
        <b>COMANDA DE VENTA</b>
      </p>
      <p>
        <b>Venta: {saleNumber(receipt.id)}</b>
      </p>
      <p>Fecha: {formatBoliviaDateTime(receipt.fecha)}</p>
      {receipt.vendedor && <p>Vendedor: {receipt.vendedor}</p>}
      {receipt.cliente_nombre && <p>Cliente: {receipt.cliente_nombre}</p>}
      {receipt.cliente_telefono && <p>Teléfono: {receipt.cliente_telefono}</p>}
      <p className="recibo-linea" />

      {receipt.items.map((item, i) => (
        <div key={i} className="recibo-item">
          <p>
            {item.producto} · {item.talla} · {item.color}
          </p>
          <p>
            {item.cantidad} × {money(item.precio_unitario)} <span className="recibo-der">{money(item.subtotal)}</span>
          </p>
        </div>
      ))}

      <p className="recibo-linea" />
      <p>
        TOTAL DE UNIDADES: <b>{totalUnits(receipt.items)}</b>
      </p>
      <p className="recibo-total">
        TOTAL <span className="recibo-der">{money(receipt.total)}</span>
      </p>
      <p>Pago: {receipt.metodo_pago ? PAYMENT_TEXT[receipt.metodo_pago] : "Sin registrar"}</p>
      {receipt.observaciones && <p>Notas: {receipt.observaciones}</p>}
      <p>Entrega: {receipt.modalidad ? MODE_TEXT[receipt.modalidad] : "Sin registrar"}</p>
      {delivery && <p>{delivery}</p>}
      {receipt.referencias && <p>Referencias: {receipt.referencias}</p>}
      <p className="recibo-linea" />
      <p className="recibo-centro">Gracias por su compra</p>
    </div>,
    document.body,
  );
}

interface ReciboPanelProps {
  receipt: SaleReceipt;
  printing: boolean;
  onPrint: () => void;
  onPrinted: () => void;
  onNewSale: () => void;
}

/** Panel de la columna derecha tras una venta confirmada. No llama a la API: solo muestra y reimprime. */
export function ReciboPanel({ receipt, printing, onPrint, onPrinted, onNewSale }: ReciboPanelProps) {
  const delivery = deliveryText(receipt);

  return (
    <>
      <div className="border-b border-gray-200 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-black">
              <CheckCircle2 size={20} className="text-green-600" /> Venta confirmada
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {saleNumber(receipt.id)} · {formatBoliviaDateTime(receipt.fecha)}
            </p>
          </div>
          <button
            type="button"
            onClick={onPrint}
            disabled={printing}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-black px-3 py-2 text-xs font-medium text-black hover:bg-black hover:text-white disabled:opacity-50"
          >
            <Printer size={15} /> IMPRIMIR COMANDA
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-3 p-4 text-sm sm:p-6">
        <p>
          <span className="text-gray-500">Sucursal:</span> {receipt.sucursal ?? "—"}
        </p>
        <p>
          <span className="text-gray-500">Pago:</span> {receipt.metodo_pago ? PAYMENT_TEXT[receipt.metodo_pago] : "Sin registrar"}
        </p>
        <p>
          <span className="text-gray-500">Entrega:</span> {receipt.modalidad ? MODE_TEXT[receipt.modalidad] : "Sin registrar"}
          {delivery && <span className="block text-gray-600">{delivery}</span>}
        </p>
        {receipt.observaciones && (
          <p>
            <span className="text-gray-500">Notas:</span> {receipt.observaciones}
          </p>
        )}
        {receipt.cliente_nombre && (
          <p>
            <span className="text-gray-500">Cliente:</span> {receipt.cliente_nombre}
            {receipt.cliente_telefono ? ` · ${receipt.cliente_telefono}` : ""}
          </p>
        )}

        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {receipt.items.map((item, i) => (
            <li key={i} className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="font-medium text-black">{item.producto}</p>
                <p className="text-xs text-gray-500">
                  {item.talla} · {item.color} · {item.cantidad} × {money(item.precio_unitario)}
                </p>
              </div>
              <p className="font-semibold">{money(item.subtotal)}</p>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3 border-t border-gray-200 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-600">Total · {totalUnits(receipt.items)} u.</span>
          <span className="text-2xl font-semibold text-black">{money(receipt.total)}</span>
        </div>
        <button
          type="button"
          onClick={onNewSale}
          className="min-h-12 w-full rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:border-black"
        >
          NUEVA VENTA
        </button>
      </div>

      {printing && <ReciboImpresion receipt={receipt} onDone={onPrinted} />}
    </>
  );
}
