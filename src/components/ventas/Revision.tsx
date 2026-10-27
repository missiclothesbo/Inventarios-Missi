import { CheckCircle2, Pencil } from "lucide-react";

import { MODE_TEXT, PAYMENT_TEXT, deliveryText, money } from "../../lib/receipt";
import { cartUnits, fromCents, lineCents, lineKey, totalOf, type CartLine, type VentaForm } from "../../lib/ventaFlow";

export interface RevisionLine {
  line: CartLine;
  product: string;
  size: string;
  color: string;
  photoSrc: string | null;
}

export interface RevisionInfo {
  branch: string;
  lines: RevisionLine[];
}

interface RevisionPanelProps {
  form: VentaForm;
  info: RevisionInfo;
  sending: boolean;
  serverError: string;
  onBack: () => void;
  onConfirm: () => void;
}

/** Revisión antes de guardar. Solo muestra datos; no escribe nada hasta CONFIRMAR VENTA. */
export function RevisionPanel({ form, info, sending, serverError, onBack, onConfirm }: RevisionPanelProps) {
  const total = totalOf(form);
  const units = cartUnits(form.cart);
  const mode = form.mode;
  const destination = deliveryText({
    modalidad: mode,
    departamento: form.department || null,
    provincia: form.province || null,
  });

  return (
    <>
      <div className="border-b border-gray-200 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-black">Revisa la venta antes de guardarla</h2>
        <p className="mt-1 text-sm text-gray-500">Todavía no se ha registrado nada. Sucursal: {info.branch}</p>
      </div>

      <div className="flex-1 space-y-3 p-4 text-sm sm:p-6">
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {info.lines.map(({ line, product, size, color, photoSrc }) => (
            <li key={lineKey(line)} className="flex items-start gap-3 p-3">
              {photoSrc ? <img src={photoSrc} alt={product} className="h-12 w-12 shrink-0 rounded-lg border object-cover" /> : null}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-black">{product}</p>
                <p className="text-xs text-gray-500">
                  Talla {size} · {color} · {line.quantity} × {money(fromCents(line.unitCents))}
                </p>
              </div>
              <p className="shrink-0 font-semibold">{money(fromCents(lineCents(line)))}</p>
            </li>
          ))}
        </ul>

        <p className="flex justify-between">
          <span className="text-gray-500">Total de unidades</span> <b>{units}</b>
        </p>
        <p className="flex justify-between text-base">
          <span className="text-gray-500">Total a pagar</span> <b>{money(total)}</b>
        </p>
        <p>
          <span className="text-gray-500">Pago:</span> {PAYMENT_TEXT[form.payment]}
        </p>
        <p>
          <span className="text-gray-500">Entrega:</span> {MODE_TEXT[mode]}
          {destination && <span className="block text-gray-600">{destination}</span>}
        </p>
        {form.customerName && (
          <p>
            <span className="text-gray-500">Cliente:</span> {form.customerName}
          </p>
        )}
        {form.customerPhone && (
          <p>
            <span className="text-gray-500">Teléfono:</span> {form.customerPhone}
          </p>
        )}
        {form.notes && (
          <p>
            <span className="text-gray-500">Notas:</span> {form.notes}
          </p>
        )}
        <p className="text-xs text-gray-500">Costo de envío: no aplica en este sistema.</p>

        {serverError && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {serverError}
          </p>
        )}
      </div>

      <div className="flex flex-col-reverse gap-3 border-t border-gray-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:grid sm:grid-cols-2 sm:p-6">
        <button
          type="button"
          onClick={onBack}
          disabled={sending}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:border-black disabled:opacity-50"
        >
          <Pencil size={15} /> VOLVER A EDITAR
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={sending}
          aria-busy={sending}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-black px-4 py-3 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          <CheckCircle2 size={15} /> {sending ? "GUARDANDO..." : "CONFIRMAR VENTA"}
        </button>
      </div>
    </>
  );
}
