import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { RETURN_REASONS, RETURN_REASON_LABELS, type ReturnReason } from "../../lib/catalogo";
import HistorialOperaciones from "./HistorialOperaciones";
import { createPortal } from "react-dom";
import { CheckCircle2, LoaderCircle, Printer, RotateCcw, Search } from "lucide-react";

import { useAuth } from "../../context/useAuth";
import { useSucursal } from "../../context/useSucursal";
import { getColors, getProducts, getSizes, selectableSizes, type CatalogItem, type Product } from "../../services/product.service";
import { getInventory } from "../../services/inventory.service";
import {
  buildOperationPayload,
  getSaleDetail,
  listOperations,
  postAnulacion,
  postCambio,
  postDevolucion,
  searchSales,
  type FoundSale,
  type OperationResult,
  type SaleDetailResponse,
} from "../../services/operations.service";
import {
  LIQUIDACION_TEXT,
  opReducer,
  initialOp,
  revisionOf,
  validateOp,
  type FieldErrors,
  type Liquidacion,
  type OpForm,
  type OpMode,
  type SaleLine,
} from "../../lib/operacionesFlow";
import { PAYMENT_TEXT, MODE_TEXT, formatBoliviaDateTime, money } from "../../lib/receipt";
import { MQ, useMediaQuery } from "../../lib/useMediaQuery";

const INPUT =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-black disabled:bg-gray-100";

const MODE_LABEL: Record<OpMode, string> = {
  devolucion: "Devolución",
  cambio: "Cambio",
  anulacion: "Anular venta",
};

function FieldError({ text }: { text?: string }) {
  return text ? <p className="mt-1 text-xs text-red-600">{text}</p> : null;
}

/** Comprobante de la operación confirmada (impresión 80 mm, sin interfaz). */
function ComprobanteImpresion({ op, onDone }: { op: OperationResult; onDone: () => void }) {
  useEffect(() => {
    document.body.classList.add("printing-recibo");
    const finish = () => {
      document.body.classList.remove("printing-recibo");
      window.removeEventListener("afterprint", finish);
      onDone();
    };
    window.addEventListener("afterprint", finish);
    const timer = window.setTimeout(() => window.print(), 100);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", finish);
      document.body.classList.remove("printing-recibo");
    };
  }, [onDone]);

  return createPortal(
    <div className="recibo-print">
      <p className="recibo-centro recibo-grande">MISSI</p>
      <p className="recibo-centro">{MODE_LABEL[op.tipo]}</p>
      <p className="recibo-linea" />
      <p>
        <b>Operación N.º {op.id}</b> · Venta N.º {op.venta_id}
      </p>
      <p>Fecha: {formatBoliviaDateTime(op.fecha)}</p>
      <p>Operador: {op.operador}</p>
      <p>Motivo: {op.motivo_etiqueta ? `${op.motivo_etiqueta} — ` : ""}{op.motivo}</p>
      <p className="recibo-linea" />
      {op.items.map((it, i) => (
        <p key={i}>
          {it.rol === "devuelto" ? "Devuelto" : "Entregado"}: {it.producto} · {it.talla} · {it.color} · {it.cantidad} × {money(it.precio_unitario)}
          {it.condicion === "danado" ? " (dañado)" : ""}
        </p>
      ))}
      <p className="recibo-linea" />
      {op.tipo !== "anulacion" && <p>Valor devuelto: {money(op.valor_devuelto)}</p>}
      {op.tipo === "cambio" && <p>Valor entregado: {money(op.valor_entregado)}</p>}
      <p className="recibo-total">
        {op.diferencia > 0 ? "Cliente paga" : op.diferencia < 0 ? "Se debe al cliente" : "Sin pago"}{" "}
        <span className="recibo-der">{money(Math.abs(op.diferencia))}</span>
      </p>
      <p>
        Pago: {op.pago.tipo === "ninguno" ? "No aplica" : `${op.pago.tipo} (${op.pago.estado})`}
        {op.pago.metodo ? ` · ${op.pago.metodo === "qr" ? "QR" : "Efectivo"}` : ""}
      </p>
      <p className="recibo-linea" />
      <p className="recibo-centro">Venta original conservada</p>
    </div>,
    document.body,
  );
}

function Cambios() {
  const { user } = useAuth();
  const { selectedId } = useSucursal();
  const isAdmin = user?.rol === "admin";

  const [flow, dispatch] = useReducer(opReducer, initialOp);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchSeq = useRef(0);
  const [results, setResults] = useState<FoundSale[]>([]);
  const [searching, setSearching] = useState(false);
  const [detail, setDetail] = useState<SaleDetailResponse | null>(null);
  const [historial, setHistorial] = useState<OperationResult[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sizes, setSizes] = useState<CatalogItem[]>([]);
  const [colors, setColors] = useState<CatalogItem[]>([]);
  const [stock, setStock] = useState<{ producto_id: number; talla_id: number; color_id: number; cantidad: number }[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyToken, setHistoryToken] = useState(0);
  const [result, setResult] = useState<OperationResult | null>(null);
  const [printing, setPrinting] = useState(false);
  const submitting = useRef(false);

  // Catálogos (una vez) y stock de la sucursal de la venta (para validar reemplazos).
  useEffect(() => {
    void Promise.all([getProducts(), getSizes(), getColors()]).then(([p, s, c]) => {
      setProducts(p);
      setSizes(s);
      setColors(c);
    });
  }, []);

  const lines: SaleLine[] = detail?.lineas ?? [];
  const form: OpForm | null = flow.form;

  // Sin columna lateral (<1280 px) la revisión y el comprobante quedan debajo: se llevan a la vista.
  const wide = useMediaQuery(MQ.xl);
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (wide) return;
    if (flow.step === "revisar" || flow.step === "confirmada") {
      asideRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [flow.step, wide]);

  /** Búsqueda universal en el servidor. Las respuestas viejas se descartan si el usuario siguió escribiendo. */
  async function runSearch(text: string) {
    const q = text.trim();
    const seq = ++searchSeq.current;
    setSearchError("");
    if (q === "") {
      setResults([]);
      setSearched(false);
      return;
    }
    setSearching(true);
    try {
      // Administrador: todas las sucursales. Vendedor: el servidor lo limita a su sucursal igualmente.
      const found = await searchSales({ q, sucursal_id: isAdmin ? null : selectedId });
      if (seq !== searchSeq.current) return;
      setResults(found);
      setSearched(true);
    } catch (err) {
      if (seq !== searchSeq.current) return;
      setResults([]);
      setSearchError(err instanceof Error ? err.message : "No se pudo buscar.");
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }

  // Búsqueda en vivo con espera breve (no consulta en cada tecla).
  useEffect(() => {
    if (flow.step !== "buscar") return;
    const timer = window.setTimeout(() => void runSearch(query), query.trim().length >= 2 ? 350 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, flow.step]);

  async function openSale(ventaId: number) {
    setMessage("");
    try {
      const [d, ops] = await Promise.all([getSaleDetail(ventaId), listOperations(ventaId)]);
      setDetail(d);
      setHistorial(ops);
      const sucursalId = d.venta.sucursal_id;
      setStock(
        (await getInventory(sucursalId)).map((i) => ({
          producto_id: i.producto.id,
          talla_id: i.talla.id,
          color_id: i.color.id,
          cantidad: i.cantidad,
        })),
      );
      dispatch({ type: "elegirVenta", ventaId });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo abrir la venta.");
    }
  }

  const precioModelo = (productoId: number) => products.find((p) => p.id === productoId)?.precio_venta ?? 0;
  const stockDisponible = (p: number, t: number, c: number) =>
    stock.find((s) => s.producto_id === p && s.talla_id === t && s.color_id === c)?.cantidad ?? 0;

  function startMode(mode: OpMode) {
    setErrors({});
    setMessage("");
    dispatch({ type: "elegirModo", mode });
  }

  function patchForm(p: Partial<OpForm>) {
    setMessage("");
    dispatch({ type: "editar", patch: p });
  }

  function onReview() {
    if (!form || !detail) return;
    const found = validateOp(lines, form, precioModelo, stockDisponible);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    dispatch({ type: "revisar", newKey: crypto.randomUUID() });
  }

  async function onConfirm() {
    if (!form || !detail || flow.step !== "revisar" || submitting.current) return;
    submitting.current = true;
    dispatch({ type: "confirmar" });
    setBusy(true);
    try {
      let op: OperationResult;
      if (form.mode === "anulacion") {
        const r = await postAnulacion(detail.venta.id, form.motivo.trim(), form.motivoCodigo, form.liquidacion, form.metodo);
        if (!r.operacion) throw new Error("La anulación no devolvió el comprobante.");
        op = r.operacion;
      } else {
        const payload = buildOperationPayload(detail.venta.id, lines, form, flow.key!);
        op = form.mode === "cambio" ? await postCambio(payload) : await postDevolucion(payload);
      }
      setResult(op);
      setHistoryToken((n) => n + 1);
      dispatch({ type: "exito" });
    } catch (err) {
      dispatch({ type: "fallo", message: err instanceof Error ? err.message : "No se pudo registrar la operación." });
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  }

  function resetAll() {
    setDetail(null);
    setHistorial([]);
    setResult(null);
    setErrors({});
    setMessage("");
    dispatch({ type: "nueva" });
  }

  const revision = useMemo(
    () => (form && detail ? revisionOf(lines, form, precioModelo) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form, detail, products],
  );

  const editing = flow.step === "editar";
  const reviewing = flow.step === "revisar" || flow.step === "enviar";
  const showDevolver = editing && !!form && form.mode !== "cambio" && form.mode !== "anulacion";

  function devolverInputs(l: SaleLine, f: OpForm) {
    return (
      <>
        <div className="grid grid-cols-2 gap-2 md:flex md:items-center">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={l.pendiente}
            value={f.devolver[l.detalle_id]?.cantidad ?? ""}
            onChange={(e) => patchForm({ devolver: { ...f.devolver, [l.detalle_id]: { cantidad: e.target.value, condicion: f.devolver[l.detalle_id]?.condicion ?? "vendible" } } })}
            className={`${INPUT} min-h-11 md:w-20`}
            disabled={l.pendiente <= 0}
            placeholder="Cant."
            aria-label={`Cantidad a devolver de ${l.producto}`}
          />
          <select
            value={f.devolver[l.detalle_id]?.condicion ?? "vendible"}
            onChange={(e) => patchForm({ devolver: { ...f.devolver, [l.detalle_id]: { cantidad: f.devolver[l.detalle_id]?.cantidad ?? "", condicion: e.target.value as "vendible" | "danado" } } })}
            className={`${INPUT} min-h-11 md:w-32`}
            aria-label="Condición"
          >
            <option value="vendible">Vendible</option>
            <option value="danado">Dañado</option>
          </select>
        </div>
        <FieldError text={errors[`cantidad_${l.detalle_id}`]} />
      </>
    );
  }
  const replacementReady = form?.mode === "cambio";
  const diffNeedsLiquidacion = revision && revision.diferencia !== 0;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-black sm:text-2xl">
          <RotateCcw size={22} /> Cambios y devoluciones
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Busca la venta original, elige qué devolver o cambiar y revisa los efectos antes de confirmar. La venta original no se modifica.
        </p>
      </div>

      {message && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</p>}

      {flow.step === "buscar" && (
        <div className="space-y-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(query);
            }}
            className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:flex-row"
          >
            <label htmlFor="busqueda-venta" className="sr-only">
              Buscar venta
            </label>
            <input
              id="busqueda-venta"
              type="search"
              autoFocus
              autoComplete="off"
              maxLength={120}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              enterKeyHint="search"
              placeholder="N.º de venta, cliente, teléfono, producto..."
              className={`${INPUT} flex-1`}
            />
            <button
              type="submit"
              disabled={searching}
              className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
            >
              {searching ? <LoaderCircle size={16} className="animate-spin" /> : <Search size={16} />} BUSCAR
            </button>
          </form>

          {searchError && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {searchError}
            </p>
          )}

          {!searchError && searching && results.length === 0 && (
            <p className="flex items-center gap-2 text-sm text-gray-500">
              <LoaderCircle size={16} className="animate-spin" /> Buscando...
            </p>
          )}

          {!searchError && !searching && searched && results.length === 0 && (
            <p className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
              No se encontró ninguna venta con «{query.trim()}». Prueba con otro dato: número, nombre, teléfono, modelo, color o fecha (DD/MM/AAAA).
            </p>
          )}

          {!searched && !searching && !searchError && (
            <p className="text-sm text-gray-500">Escribe cualquier dato que recuerdes de la venta. Puedes combinar palabras, por ejemplo: «ana palazzo».</p>
          )}

          {results.length > 0 && (
            <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
              {results.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => void openSale(v.id)}
                    className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-gray-50 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-black">
                        N.º {v.id} · {formatBoliviaDateTime(v.fecha)} · {v.sucursal}
                        {v.estado === "cancelada" && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">Anulada</span>}
                      </span>
                      <span className="block truncate text-xs text-gray-500">
                        {v.cliente_nombre ?? "Sin nombre"}
                        {v.cliente_telefono ? ` · ${v.cliente_telefono}` : ""} ·{" "}
                        {v.items.map((it) => `${it.producto} ${it.talla}/${it.color} ×${it.cantidad}`).join(", ")}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-black">{money(v.total)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {detail && (flow.step === "detalle" || editing || reviewing) && (
        <div className="grid gap-4 sm:gap-6 xl:grid-cols-[1fr_420px]">
          <section className="min-w-0 space-y-6 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-black">
                  Venta N.º {detail.venta.id} · {formatBoliviaDateTime(detail.venta.fecha)}
                </p>
                <p className="text-sm text-gray-500">
                  {detail.venta.sucursal} · {detail.venta.cliente_nombre ?? "Sin nombre"} {detail.venta.cliente_telefono ?? ""} · Total {money(detail.venta.total)} ·{" "}
                  {detail.venta.metodo_pago ? PAYMENT_TEXT[detail.venta.metodo_pago] : "Pago sin registrar"} ·{" "}
                  {detail.venta.modalidad ? MODE_TEXT[detail.venta.modalidad] : "Entrega sin registrar"} · Estado{" "}
                  {detail.venta.estado === "completada" ? "completada" : "anulada"}
                </p>
                <p className="text-xs text-gray-500">
                  Pendiente de devolver: {detail.unidades_pendientes} u. {detail.venta.observaciones ? `· Notas: ${detail.venta.observaciones}` : ""}
                </p>
              </div>
              <button type="button" onClick={resetAll} className="min-h-11 text-sm text-gray-500 hover:text-black">← Buscar otra venta</button>
            </div>

            {/* Móvil: una tarjeta por línea vendida */}
            <ul className="space-y-2 md:hidden">
              {lines.map((l) => (
                <li key={l.detalle_id} className="rounded-lg border border-gray-200 p-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 font-medium text-black">
                      {l.producto} <span className="font-normal text-gray-500">· {l.talla} · {l.color}</span>
                    </p>
                    <p className="shrink-0 font-semibold">{money(l.precio_unitario)}</p>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    Vendido {l.cantidad} · Devuelto {l.devuelta} · <b className="text-black">Pendiente {l.pendiente}</b>
                  </p>
                  {showDevolver && form && <div className="mt-3">{devolverInputs(l, form)}</div>}
                </li>
              ))}
            </ul>
            <div className="md:hidden">
              <FieldError text={errors.items} />
            </div>

            <div className="hidden overflow-x-auto rounded-lg border border-gray-200 md:block">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-3 py-2">Modelo</th>
                    <th className="px-3 py-2">Talla / color</th>
                    <th className="px-3 py-2 text-right">Vendido</th>
                    <th className="px-3 py-2 text-right">Devuelto</th>
                    <th className="px-3 py-2 text-right">Pendiente</th>
                    <th className="px-3 py-2 text-right">Precio</th>
                    {showDevolver && <th className="px-3 py-2">Devolver</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {lines.map((l) => (
                    <tr key={l.detalle_id}>
                      <td className="px-3 py-2">{l.producto}</td>
                      <td className="px-3 py-2">{l.talla} · {l.color}</td>
                      <td className="px-3 py-2 text-right">{l.cantidad}</td>
                      <td className="px-3 py-2 text-right">{l.devuelta}</td>
                      <td className="px-3 py-2 text-right font-medium">{l.pendiente}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{money(l.precio_unitario)}</td>
                      {showDevolver && form && <td className="px-3 py-2">{devolverInputs(l, form)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              <FieldError text={errors.items} />
            </div>

            {!editing && !reviewing && (
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-3">
                <button type="button" disabled={detail.unidades_pendientes <= 0} onClick={() => startMode("devolucion")} className="min-h-11 rounded-lg border border-black px-4 py-2.5 text-sm font-medium hover:bg-black hover:text-white disabled:opacity-40">
                  DEVOLUCIÓN
                </button>
                <button type="button" disabled={detail.unidades_pendientes <= 0} onClick={() => startMode("cambio")} className="min-h-11 rounded-lg border border-black px-4 py-2.5 text-sm font-medium hover:bg-black hover:text-white disabled:opacity-40">
                  CAMBIO
                </button>
                {isAdmin && (
                  <button type="button" disabled={!detail.puede_anular} onClick={() => startMode("anulacion")} className="col-span-2 min-h-11 rounded-lg border border-red-600 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-600 hover:text-white disabled:opacity-40">
                    ANULAR VENTA
                  </button>
                )}
                {!detail.puede_anular && detail.venta.estado === "cancelada" && <p className="col-span-2 self-center text-sm text-gray-500">La venta ya está anulada.</p>}
              </div>
            )}

            {editing && form && (
              <div className="space-y-5 border-t border-gray-200 pt-5">
                <h2 className="text-base font-semibold text-black">{MODE_LABEL[form.mode]}</h2>

                {form.mode === "anulacion" && (
                  <p className="rounded-lg bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
                    Se anulan las {detail.unidades_pendientes} unidades que aún no se han devuelto. Las devueltas antes no se reponen de nuevo.
                  </p>
                )}

                {form.mode === "cambio" && (
                  <div className="space-y-3">
                    <p className="text-sm font-medium text-gray-700">Artículo de reemplazo (sale de la sucursal de la venta)</p>
                    {form.reemplazos.map((r, i) => {
                      const disponible = r.producto_id && r.talla_id && r.color_id ? stockDisponible(Number(r.producto_id), Number(r.talla_id), Number(r.color_id)) : null;
                      return (
                        <div key={i} className="grid grid-cols-2 gap-2 md:grid-cols-5">
                          <select aria-label="Modelo de reemplazo" className={`${INPUT} col-span-2 md:col-span-1`} value={r.producto_id} onChange={(e) => patchForm({ reemplazos: form.reemplazos.map((x, j) => (j === i ? { ...x, producto_id: e.target.value, precio: "" } : x)) })}>
                            <option value="">Modelo</option>
                            {products.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                          </select>
                          <select aria-label="Talla de reemplazo" className={INPUT} value={r.talla_id} onChange={(e) => patchForm({ reemplazos: form.reemplazos.map((x, j) => (j === i ? { ...x, talla_id: e.target.value } : x)) })}>
                            <option value="">Talla</option>
                            {selectableSizes(sizes).map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                          </select>
                          <select aria-label="Color de reemplazo" className={INPUT} value={r.color_id} onChange={(e) => patchForm({ reemplazos: form.reemplazos.map((x, j) => (j === i ? { ...x, color_id: e.target.value } : x)) })}>
                            <option value="">Color</option>
                            {colors.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                          </select>
                          <input type="number" inputMode="numeric" aria-label="Cantidad de reemplazo" min={1} className={INPUT} value={r.cantidad} placeholder="Cant." onChange={(e) => patchForm({ reemplazos: form.reemplazos.map((x, j) => (j === i ? { ...x, cantidad: e.target.value } : x)) })} />
                          <input type="number" inputMode="decimal" aria-label="Precio de reemplazo" min={0} step="0.01" className={INPUT} value={r.precio} placeholder={`Precio (${money(precioModelo(Number(r.producto_id)))})`} onChange={(e) => patchForm({ reemplazos: form.reemplazos.map((x, j) => (j === i ? { ...x, precio: e.target.value } : x)) })} />
                          <div className="col-span-2 text-xs text-gray-500 md:col-span-5">
                            {disponible !== null && <>Disponible en la sucursal: {disponible} · </>}
                            <FieldError text={errors[`reemplazo_${i}`] ?? errors[`reemplazo_cantidad_${i}`] ?? errors[`reemplazo_precio_${i}`]} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-gray-700">Motivo (obligatorio)</span>
                  <select value={form.motivoCodigo} onChange={(e) => patchForm({ motivoCodigo: e.target.value as ReturnReason | "" })} className={INPUT}>
                    <option value="">Selecciona el motivo</option>
                    {RETURN_REASONS.map((code) => (
                      <option key={code} value={code}>{RETURN_REASON_LABELS[code]}</option>
                    ))}
                  </select>
                  <FieldError text={errors.motivoCodigo} />
                </label>

                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-gray-700">
                    Explicación {form.motivoCodigo === "OTRO" ? "(obligatoria con «Otro»)" : "(opcional)"}
                  </span>
                  <textarea rows={2} maxLength={300} value={form.motivo} onChange={(e) => patchForm({ motivo: e.target.value })} className={INPUT} />
                  <FieldError text={errors.motivo} />
                </label>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium text-gray-700">¿Qué pasa con el dinero?</span>
                    <select className={INPUT} value={form.liquidacion} onChange={(e) => patchForm({ liquidacion: e.target.value as Liquidacion | "" })}>
                      <option value="">{diffNeedsLiquidacion && revision && revision.diferencia > 0 ? "No aplica (el cliente paga)" : "Devolver el dinero después"}</option>
                      {(Object.keys(LIQUIDACION_TEXT) as Liquidacion[]).map((k) => (
                        <option key={k} value={k}>{LIQUIDACION_TEXT[k]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium text-gray-700">Método de pago</span>
                    <select className={INPUT} value={form.metodo} onChange={(e) => patchForm({ metodo: e.target.value as "qr" | "efectivo" | "" })}>
                      <option value="">Elige el método…</option>
                      <option value="efectivo">Efectivo</option>
                      <option value="qr">QR</option>
                    </select>
                    <FieldError text={errors.metodo} />
                  </label>
                </div>

                <button type="button" onClick={onReview} className="min-h-12 w-full rounded-lg bg-black px-4 py-3 text-sm font-semibold tracking-wide text-white hover:bg-gray-800">
                  REVISAR OPERACIÓN
                </button>
                {replacementReady && <p className="text-xs text-gray-500">Ningún dato se guarda hasta confirmar en el paso siguiente.</p>}
              </div>
            )}

            {historial.length > 0 && (
              <div className="border-t border-gray-200 pt-5">
                <h2 className="mb-2 text-base font-semibold text-black">Historial de esta venta</h2>
                <ul className="space-y-2 text-sm">
                  {historial.map((h) => (
                    <li key={h.id} className="rounded-lg border border-gray-200 p-3">
                      <p className="font-medium">{MODE_LABEL[h.tipo]} · {formatBoliviaDateTime(h.fecha)} · {h.operador}</p>
                      <p className="text-xs text-gray-500">{h.motivo_etiqueta ? `${h.motivo_etiqueta} — ` : ""}{h.motivo}</p>
                      <p className="text-xs text-gray-500">
                        Pago: {h.pago.tipo === "ninguno" ? "no aplica" : `${h.pago.tipo} ${h.pago.estado} ${h.pago.monto ? money(h.pago.monto) : ""}`}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <aside ref={asideRef} className="min-w-0 scroll-mt-20 flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm">
            {(flow.step === "detalle" || editing) && (
              <div className="p-4 text-sm text-gray-600 sm:p-6">
                {editing ? "Completa la operación y pulsa REVISAR. Aquí verás todos sus efectos antes de confirmar." : "Elige DEVOLUCIÓN, CAMBIO o ANULAR VENTA para empezar."}
              </div>
            )}

            {reviewing && form && revision && (
              <>
                <div className="border-b border-gray-200 p-4 sm:p-6">
                  <h2 className="text-lg font-semibold text-black">Revisa antes de confirmar</h2>
                  <p className="mt-1 text-sm text-gray-500">Todavía no se ha guardado nada.</p>
                </div>
                <div className="flex-1 space-y-3 p-4 text-sm sm:p-6">
                  <p><span className="text-gray-500">Operación:</span> {MODE_LABEL[form.mode]} · Venta N.º {detail?.venta.id}</p>
                  <p><span className="text-gray-500">Motivo:</span> {form.motivoCodigo ? RETURN_REASON_LABELS[form.motivoCodigo] : "—"}{form.motivo ? ` — ${form.motivo}` : ""}</p>
                  <p className="font-medium text-black">Stock</p>
                  <ul className="list-disc pl-5">
                    {revision.devueltos.map((d) => (
                      <li key={d.detalle_id}>
                        {d.cantidad} × {d.producto} ({d.talla}, {d.color}): {d.condicion === "vendible" ? "vuelve al stock para vender" : "queda aparte como dañada (no se vuelve a vender)"}
                      </li>
                    ))}
                    {revision.reemplazos.map((r, i) => (
                      <li key={i}>{r.cantidad} × reemplazo: sale del stock de la sucursal</li>
                    ))}
                  </ul>
                  <p className="font-medium text-black">Dinero</p>
                  <p>Valor devuelto: {money(revision.valorDevuelto)}</p>
                  {form.mode === "cambio" && <p>Valor entregado: {money(revision.valorEntregado)}</p>}
                  <p className="text-base font-semibold">
                    {revision.accion}: {money(Math.abs(revision.diferencia))}
                  </p>
                  {revision.diferencia > 0 && <p>Cobro: {form.metodo ? (form.metodo === "qr" ? "QR" : "Efectivo") : "—"} (completado)</p>}
                  {revision.diferencia < 0 && (
                    <p>
                      {LIQUIDACION_TEXT[(form.liquidacion || "reembolso_pendiente") as Liquidacion]}
                      {form.liquidacion === "reembolso_inmediato" && form.metodo ? ` · ${form.metodo === "qr" ? "QR" : "Efectivo"}` : ""}
                    </p>
                  )}
                  {form.mode !== "cambio" && revision.diferencia === 0 && <p>Sin pago.</p>}
                  {flow.serverError && (
                    <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">{flow.serverError} Los datos siguen en el formulario.</p>
                  )}
                </div>
                <div className="flex flex-col-reverse gap-3 border-t border-gray-200 p-4 sm:grid sm:grid-cols-2 sm:p-6">
                  <button type="button" disabled={busy} onClick={() => dispatch({ type: "volver" })} className="min-h-12 rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium hover:border-black disabled:opacity-50">
                    VOLVER A EDITAR
                  </button>
                  <button type="button" disabled={busy || flow.step !== "revisar"} onClick={() => void onConfirm()} className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-black px-4 py-3 text-sm font-medium text-white hover:bg-gray-800 disabled:bg-gray-300">
                    <CheckCircle2 size={15} /> {busy ? "GUARDANDO..." : "CONFIRMAR"}
                  </button>
                </div>
              </>
            )}

            {flow.step === "confirmada" && result && (
              <>
                <div className="border-b border-gray-200 p-4 sm:p-6">
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-black"><CheckCircle2 size={20} className="text-green-600" /> {MODE_LABEL[result.tipo]} registrada</h2>
                  <p className="mt-1 text-sm text-gray-500">Operación N.º {result.id}{result.repetida ? " (ya estaba registrada; no se duplicó)" : ""} · Venta N.º {result.venta_id}</p>
                </div>
                <div className="flex-1 space-y-2 p-4 text-sm sm:p-6">
                  <p>Operador: {result.operador}</p>
                  <p>Fecha: {formatBoliviaDateTime(result.fecha)}</p>
                  <p>Valor devuelto: {money(result.valor_devuelto)}</p>
                  {result.tipo === "cambio" && <p>Valor entregado: {money(result.valor_entregado)}</p>}
                  <p>Diferencia: {money(Math.abs(result.diferencia))} {result.diferencia > 0 ? "(cobrado al cliente)" : result.diferencia < 0 ? "(se debe al cliente)" : ""}</p>
                  <p>Pago: {result.pago.tipo === "ninguno" ? "no aplica" : `${result.pago.tipo} · ${result.pago.estado}`}{result.pago.metodo ? ` · ${result.pago.metodo === "qr" ? "QR" : "Efectivo"}` : ""}</p>
                </div>
                <div className="grid grid-cols-1 gap-3 border-t border-gray-200 p-4 min-[400px]:grid-cols-2 sm:p-6">
                  <button type="button" onClick={() => setPrinting(true)} className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-black px-4 py-3 text-sm font-medium hover:bg-black hover:text-white"><Printer size={15} /> IMPRIMIR</button>
                  <button type="button" onClick={resetAll} className="min-h-12 rounded-lg bg-black px-4 py-3 text-sm font-medium text-white hover:bg-gray-800">NUEVA OPERACIÓN</button>
                </div>
                {printing && <ComprobanteImpresion op={result} onDone={() => setPrinting(false)} />}
              </>
            )}
          </aside>
        </div>
      )}

      <HistorialOperaciones products={products} sizes={sizes} colors={colors} refreshToken={historyToken} />
    </div>
  );
}

export default Cambios;
