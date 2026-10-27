import { useMemo, useRef, useState } from "react";
import { MinusCircle } from "lucide-react";

import { FILTRO_INPUT } from "../../components/filtros/FiltroPeriodo";
import { EXIT_REASONS, EXIT_REASON_LABELS, sortSizeLabels, type ExitReason } from "../../lib/catalogo";
import { registerStockAdjustment, registerStockExit } from "../../services/movements.service";
import type { CatalogItem, Product } from "../../services/product.service";

interface Props {
  branchId: number;
  branchName: string;
  products: Product[];
  sizes: CatalogItem[];
  colors: CatalogItem[];
  /** Se llama tras guardar para refrescar el inventario en pantalla. */
  onDone: () => void;
}

type Kind = "salida" | "ajuste_mas" | "ajuste_menos";

/**
 * Salidas autorizadas (daño, pérdida, muestra, obsequio) y ajustes de inventario. Solo administrador.
 * Cada operación crea un movimiento nuevo en el libro; nunca se edita el historial.
 */
function AjustesInventario({ branchId, branchName, products, sizes, colors, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("salida");
  const [producto, setProducto] = useState("");
  const [talla, setTalla] = useState("");
  const [color, setColor] = useState("");
  const [cantidad, setCantidad] = useState("1");
  const [motivo, setMotivo] = useState<ExitReason | "">("");
  const [detalle, setDetalle] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Una clave por intento: reintentar tras un corte de red nunca aplica la operación dos veces.
  const key = useRef(crypto.randomUUID());

  const orderedSizes = useMemo(() => {
    const order = new Map(sortSizeLabels(sizes.map((s) => s.nombre)).map((n, i) => [n, i]));
    return [...sizes].sort((a, b) => (order.get(a.nombre) ?? 0) - (order.get(b.nombre) ?? 0));
  }, [sizes]);

  async function submit() {
    setMessage(null);
    const qty = Number(cantidad);
    if (!producto || !talla || !color) return setMessage({ ok: false, text: "Elige modelo, talla y color." });
    if (!Number.isInteger(qty) || qty <= 0) return setMessage({ ok: false, text: "Escribe cuántas unidades (un número mayor a 0)." });
    if (kind === "salida" && !motivo) return setMessage({ ok: false, text: "Elige por qué salen las prendas." });
    if ((kind === "salida" ? motivo === "OTRO" : true) && detalle.trim().length < 3) {
      return setMessage({ ok: false, text: kind === "salida" ? "Explica por qué salen las prendas." : "Explica por qué corriges el stock." });
    }
    if (busy) return;
    setBusy(true);
    try {
      const base = { sucursal_id: branchId, producto_id: Number(producto), talla_id: Number(talla), color_id: Number(color), idempotency_key: key.current };
      if (kind === "salida") {
        await registerStockExit({ ...base, cantidad: qty, motivo_codigo: motivo, detalle: detalle.trim() });
      } else {
        await registerStockAdjustment({ ...base, delta: kind === "ajuste_mas" ? qty : -qty, motivo: detalle.trim() });
      }
      key.current = crypto.randomUUID();
      setMessage({ ok: true, text: kind === "salida" ? "Listo: salida guardada." : "Listo: stock corregido." });
      setCantidad("1");
      setDetalle("");
      onDone();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "No se pudo guardar." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left sm:px-6">
        <span className="flex items-center gap-2 text-sm font-semibold text-black">
          <MinusCircle size={18} /> Sacar prendas o corregir el stock · {branchName}
        </span>
        <span className="text-xs text-gray-500">{open ? "Ocultar" : "Mostrar"}</span>
      </button>

      {open && (
        <div className="grid gap-3 border-t border-gray-200 p-4 sm:grid-cols-2 sm:p-6 lg:grid-cols-4">
          <label className="text-xs font-medium text-gray-600">
            ¿Qué quieres hacer?
            <select className={`${FILTRO_INPUT} mt-1`} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="salida">Sacar prendas (no es una venta)</option>
              <option value="ajuste_mas">Corregir el stock: sumar unidades</option>
              <option value="ajuste_menos">Corregir el stock: restar unidades</option>
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600">
            Modelo
            <select className={`${FILTRO_INPUT} mt-1`} value={producto} onChange={(e) => setProducto(e.target.value)}>
              <option value="">Selecciona</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600">
            Talla
            <select className={`${FILTRO_INPUT} mt-1`} value={talla} onChange={(e) => setTalla(e.target.value)}>
              <option value="">Selecciona</option>
              {orderedSizes.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600">
            Color
            <select className={`${FILTRO_INPUT} mt-1`} value={color} onChange={(e) => setColor(e.target.value)}>
              <option value="">Selecciona</option>
              {colors.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600">
            Cantidad
            <input type="number" inputMode="numeric" min={1} step={1} className={`${FILTRO_INPUT} mt-1`} value={cantidad} onChange={(e) => setCantidad(e.target.value)} />
          </label>
          {kind === "salida" && (
            <label className="text-xs font-medium text-gray-600">
              Motivo
              <select className={`${FILTRO_INPUT} mt-1`} value={motivo} onChange={(e) => setMotivo(e.target.value as ExitReason | "")}>
                <option value="">Selecciona el motivo</option>
                {EXIT_REASONS.map((r) => <option key={r} value={r}>{EXIT_REASON_LABELS[r]}</option>)}
              </select>
            </label>
          )}
          <label className="text-xs font-medium text-gray-600 sm:col-span-2">
            {kind === "salida" ? (motivo === "OTRO" ? "Explicación (obligatoria)" : "Explicación (opcional)") : "¿Por qué lo corriges? (obligatorio)"}
            <input type="text" maxLength={300} className={`${FILTRO_INPUT} mt-1`} value={detalle} onChange={(e) => setDetalle(e.target.value)} />
          </label>
          <div className="flex items-end sm:col-span-2 lg:col-span-4">
            <button type="button" disabled={busy} onClick={() => void submit()} className="min-h-12 w-full rounded-lg bg-black px-5 text-sm font-medium text-white hover:bg-gray-800 disabled:bg-gray-300 sm:w-auto">
              {busy ? "Guardando…" : kind === "salida" ? "Guardar salida" : "Guardar corrección"}
            </button>
          </div>
          {message && (
            <p role={message.ok ? "status" : "alert"} className={`rounded-lg border px-4 py-3 text-sm sm:col-span-2 lg:col-span-4 ${message.ok ? "border-green-200 bg-green-50 text-green-700" : "border-red-200 bg-red-50 text-red-700"}`}>
              {message.text}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default AjustesInventario;
