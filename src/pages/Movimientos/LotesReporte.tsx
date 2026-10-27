import { useEffect, useMemo, useState } from "react";
import { Layers, LoaderCircle, Search } from "lucide-react";

import { FILTRO_INPUT } from "../../components/filtros/FiltroPeriodo";
import { useAuth } from "../../context/useAuth";
import { useSucursal } from "../../context/useSucursal";
import { sortSizeLabels } from "../../lib/catalogo";
import { LOT_STATE_CLASS, LOT_STATE_TEXT, daysText, type LotState } from "../../lib/recepcion";
import { formatBoliviaDateTime } from "../../lib/receipt";
import { TODAS_LAS_UBICACIONES, branchLabel } from "../../lib/ubicaciones";
import { listLots, type LotRow } from "../../services/lots.service";
import { getColors, getProducts, getSizes, type CatalogItem, type Product } from "../../services/product.service";

const AVG = (n: number | null) => (n === null ? "—" : `${String(n).replace(".", ",")} / día`);

/** Edad y velocidad de venta de cada lote: todo sale de fechas y movimientos reales, nada estimado. */
function LotesReporte() {
  const { user } = useAuth();
  const { branches } = useSucursal();
  const isAdmin = user?.rol === "admin";

  const [sucursal, setSucursal] = useState<number | null>(isAdmin ? null : (user?.sucursal_id ?? null));
  const [producto, setProducto] = useState("");
  const [talla, setTalla] = useState("");
  const [color, setColor] = useState("");
  const [estado, setEstado] = useState<LotState | "">("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [q, setQ] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [sizes, setSizes] = useState<CatalogItem[]>([]);
  const [colors, setColors] = useState<CatalogItem[]>([]);
  const [rows, setRows] = useState<LotRow[]>([]);
  const [total, setTotal] = useState({ unidades: 0, truncado: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([getProducts(), getSizes(), getColors()]).then(([p, s, c]) => {
      setProducts(p);
      setSizes(s);
      setColors(c);
    });
  }, []);

  const periodoInvalido = desde !== "" && hasta !== "" && desde > hasta ? "La fecha inicial no puede ser posterior a la final." : "";

  useEffect(() => {
    if (periodoInvalido) return;
    let cancelled = false;
    listLots({
      sucursal_id: sucursal, producto_id: producto ? Number(producto) : undefined, talla_id: talla ? Number(talla) : undefined,
      color_id: color ? Number(color) : undefined, estado, desde: desde || undefined, hasta: hasta || undefined, q,
    })
      .then((r) => {
        if (cancelled) return;
        setRows(r.filas);
        setTotal({ unidades: r.unidades_restantes, truncado: r.truncado });
        setError("");
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : "No se pudieron cargar los lotes."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sucursal, producto, talla, color, estado, desde, hasta, q, periodoInvalido]);

  const orderedSizes = useMemo(() => {
    const names = sortSizeLabels(sizes.map((s) => s.nombre));
    return names.map((n) => sizes.find((s) => s.nombre === n)!).filter(Boolean);
  }, [sizes]);

  /** Cambiar un filtro vuelve a mostrar «Cargando» (se hace en el evento, no en el efecto). */
  const change = <T,>(set: (v: T) => void) => (v: T) => {
    setLoading(true);
    set(v);
  };

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          change(setQ)(busqueda.trim());
        }}
        className="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4"
      >
        {isAdmin && (
          <label className="text-xs font-medium text-gray-600">
            Ubicación
            <select className={`${FILTRO_INPUT} mt-1`} value={sucursal ?? ""} onChange={(e) => change(setSucursal)(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{TODAS_LAS_UBICACIONES}</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{branchLabel(b)}</option>
              ))}
            </select>
          </label>
        )}
        <label className="text-xs font-medium text-gray-600">
          Modelo
          <select className={`${FILTRO_INPUT} mt-1`} value={producto} onChange={(e) => change(setProducto)(e.target.value)}>
            <option value="">Todos los modelos</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Talla
          <select className={`${FILTRO_INPUT} mt-1`} value={talla} onChange={(e) => change(setTalla)(e.target.value)}>
            <option value="">Todas las tallas</option>
            {orderedSizes.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Color
          <select className={`${FILTRO_INPUT} mt-1`} value={color} onChange={(e) => change(setColor)(e.target.value)}>
            <option value="">Todos los colores</option>
            {colors.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Estado
          <select className={`${FILTRO_INPUT} mt-1`} value={estado} onChange={(e) => change(setEstado)(e.target.value as LotState | "")}>
            <option value="">Todos</option>
            {(Object.keys(LOT_STATE_TEXT) as LotState[]).map((k) => <option key={k} value={k}>{LOT_STATE_TEXT[k]}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Llegó desde
          <input type="date" className={`${FILTRO_INPUT} mt-1`} value={desde} max={hasta || undefined} onChange={(e) => change(setDesde)(e.target.value)} />
        </label>
        <label className="text-xs font-medium text-gray-600">
          Llegó hasta
          <input type="date" className={`${FILTRO_INPUT} mt-1`} value={hasta} min={desde || undefined} onChange={(e) => change(setHasta)(e.target.value)} />
        </label>
        <div className="flex items-end gap-2">
          <label className="flex min-h-11 flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 focus-within:border-black">
            <Search size={16} className="shrink-0 text-gray-400" />
            <input
              type="search"
              aria-label="Buscar lote"
              placeholder="L-000012, REC-000003, modelo..."
              maxLength={80}
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              className="w-full min-w-0 bg-transparent text-sm outline-none"
            />
          </label>
          <button type="submit" className="min-h-11 rounded-lg bg-black px-4 text-sm font-medium text-white hover:bg-gray-800">Buscar</button>
        </div>
        {periodoInvalido && <p className="text-sm text-red-600 sm:col-span-2 lg:col-span-4">{periodoInvalido}</p>}
      </form>

      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <p className="text-sm text-gray-600">
        {loading ? "Cargando lotes…" : <><b className="text-black">{rows.length}</b> lotes · <b className="text-black">{total.unidades}</b> unidades todavía en stock{total.truncado ? " (lista limitada: acota los filtros)" : ""}</>}
      </p>

      {loading && rows.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-gray-500"><LoaderCircle size={16} className="animate-spin" /> Cargando…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">No hay lotes con estos filtros.</p>
      ) : (
        <>
          <ul className="space-y-3 md:hidden">
            {rows.map((l) => (
              <li key={l.id} className="rounded-xl border border-gray-200 bg-white p-4 text-sm shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-black">{l.codigo} · {l.producto.nombre}</p>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${LOT_STATE_CLASS[l.estado]}`}>{LOT_STATE_TEXT[l.estado]}</span>
                </div>
                <p className="text-gray-600">Talla {l.talla.nombre} · {l.color.nombre} · {branchLabel(l.sucursal)}</p>
                <p className="mt-1 text-gray-600">
                  {l.fecha_recepcion ? `Llegó ${formatBoliviaDateTime(l.fecha_recepcion)} · hace ${daysText(l.dias_en_inventario)}` : "Fecha de llegada desconocida"}
                </p>
                <p className="mt-1 text-gray-800">Llegaron {l.cantidad_inicial} · Vendidas {l.vendidas} · Quedan <b>{l.cantidad_restante}</b></p>
                {(l.traspasadas > 0 || l.devueltas > 0 || l.otras_salidas > 0) && (
                  <p className="text-xs text-gray-500">{[l.traspasadas > 0 && `Enviadas a otra sucursal: ${l.traspasadas}`, l.devueltas > 0 && `Devueltas: ${l.devueltas}`, l.otras_salidas > 0 && `Sacadas/ajustadas: ${l.otras_salidas}`].filter(Boolean).join(" · ")}</p>
                )}
                <p className="text-xs text-gray-500">
                  {l.primera_venta
                    ? `Primera venta ${l.dias_hasta_primera_venta === null ? formatBoliviaDateTime(l.primera_venta) : `${daysText(l.dias_hasta_primera_venta)} después de llegar`} · ${AVG(l.promedio_diario)}`
                    : "Aún sin ventas"}
                </p>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm md:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-3">Lote</th>
                  <th className="px-3 py-3">Producto</th>
                  <th className="px-3 py-3">Ubicación</th>
                  <th className="px-3 py-3">Llegó</th>
                  <th className="px-3 py-3 text-right">Días</th>
                  <th className="px-3 py-3 text-right">Llegaron</th>
                  <th className="px-3 py-3 text-right">Vendidas</th>
                  <th className="px-3 py-3 text-right">Quedan</th>
                  <th className="px-3 py-3 text-right">Otros</th>
                  <th className="px-3 py-3">Primera venta</th>
                  <th className="px-3 py-3 text-right">Ritmo</th>
                  <th className="px-3 py-3">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-3 font-medium text-black">{l.codigo}</td>
                    <td className="px-3 py-3">{l.producto.nombre}<span className="block text-xs text-gray-500">Talla {l.talla.nombre} · {l.color.nombre}</span></td>
                    <td className="px-3 py-3">{branchLabel(l.sucursal)}</td>
                    <td className="whitespace-nowrap px-3 py-3">{l.fecha_recepcion ? formatBoliviaDateTime(l.fecha_recepcion) : <span className="text-gray-500">Desconocida</span>}</td>
                    <td className="px-3 py-3 text-right">{l.dias_en_inventario ?? "—"}</td>
                    <td className="px-3 py-3 text-right">{l.cantidad_inicial}</td>
                    <td className="px-3 py-3 text-right">{l.vendidas}</td>
                    <td className="px-3 py-3 text-right font-semibold">{l.cantidad_restante}</td>
                    <td className="px-3 py-3 text-right text-xs text-gray-600" title="Enviadas a otra sucursal / devueltas / sacadas o ajustadas">{l.traspasadas} / {l.devueltas} / {l.otras_salidas}</td>
                    <td className="px-3 py-3">{l.primera_venta ? (l.dias_hasta_primera_venta === null ? formatBoliviaDateTime(l.primera_venta) : `a los ${daysText(l.dias_hasta_primera_venta)}`) : <span className="text-gray-500">Sin ventas</span>}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right">{AVG(l.promedio_diario)}</td>
                    <td className="px-3 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${LOT_STATE_CLASS[l.estado]}`}>{LOT_STATE_TEXT[l.estado]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="flex items-start gap-2 text-xs text-gray-500">
            <Layers size={14} className="mt-0.5 shrink-0" />
            «Días» cuenta desde que llegó a la empresa (no hasta que se agote). El ritmo solo aparece cuando hay fecha de llegada, al menos un día transcurrido y alguna venta.
          </p>
        </>
      )}
    </div>
  );
}

export default LotesReporte;
