import { useEffect, useMemo, useState } from "react";
import { History, LoaderCircle, Search } from "lucide-react";

import { FILTRO_INPUT, FiltroPeriodo } from "../../components/filtros/FiltroPeriodo";
import { useAuth } from "../../context/useAuth";
import { useSucursal } from "../../context/useSucursal";
import { MOVEMENT_CATEGORIES, MOVEMENT_LABELS, sortSizeLabels, type MovementCategory } from "../../lib/catalogo";
import { resolverPeriodo, type PeriodoAnalisis } from "../../lib/periodoFiltro";
import { hoyBolivia, type Rango } from "../../lib/periodos";
import { formatBoliviaDateTime } from "../../lib/receipt";
import { getMovements, type MovementPage, type MovementRow } from "../../services/movements.service";
import { getColors, getProducts, getSizes, type CatalogItem, type Product } from "../../services/product.service";
import { listUsers, type UserRow } from "../../services/users.service";
import { TODAS_LAS_UBICACIONES } from "../../lib/ubicaciones";
import LotesReporte from "./LotesReporte";

type Tab = "TODOS" | MovementCategory;

/** Pestañas principales pedidas por el negocio; el resto de categorías va en «Más». */
const MAIN_TABS: { tab: Tab; label: string }[] = [
  { tab: "TODOS", label: "Todos" },
  { tab: "INGRESO", label: "Ingresos" },
  { tab: "CAMBIO", label: "Cambios" },
  { tab: "SALIDA", label: "Salidas" },
  { tab: "TRASPASO", label: "Traspasos" },
  { tab: "VENTA", label: "Ventas" },
  { tab: "DEVOLUCION", label: "Devoluciones" },
  { tab: "AJUSTE", label: "Ajustes" },
];

const BADGE: Record<MovementCategory, string> = {
  INGRESO: "bg-green-50 text-green-700",
  VENTA: "bg-gray-100 text-gray-800",
  CAMBIO: "bg-yellow-50 text-yellow-800",
  DEVOLUCION: "bg-orange-50 text-orange-700",
  SALIDA: "bg-red-50 text-red-700",
  TRASPASO: "bg-blue-50 text-blue-700",
  AJUSTE: "bg-purple-50 text-purple-700",
};

const TRANSFER_STATES = [
  { value: "", label: "Cualquier estado" },
  { value: "pendiente", label: "Por enviar" },
  { value: "enviado", label: "Enviado" },
  { value: "recibido", label: "Recibido" },
  { value: "cancelado", label: "Cancelado" },
];

const PAGE_SIZE = 25;

const signed = (m: MovementRow) => (m.signo === null ? `${m.cantidad}` : m.signo === 0 ? `${m.cantidad} (dañada)` : `${m.signo > 0 ? "+" : "−"}${m.cantidad}`);

function detail(m: MovementRow): string {
  if (m.categoria === "TRASPASO" && (m.origen || m.destino)) return `${m.origen ?? "—"} → ${m.destino ?? "—"}`;
  const reason = [m.motivo_etiqueta, m.motivo && m.motivo !== m.motivo_etiqueta ? m.motivo : null].filter(Boolean).join(" — ");
  return reason || m.observaciones || "";
}

function MovimientosLibro() {
  const { user } = useAuth();
  const { branches } = useSucursal();
  const orgName = TODAS_LAS_UBICACIONES;
  const isAdmin = user?.rol === "admin";

  const [tab, setTab] = useState<Tab>("TODOS");
  const [preset, setPreset] = useState<PeriodoAnalisis>("mes_actual");
  const [custom, setCustom] = useState<Rango>({ desde: hoyBolivia(), hasta: hoyBolivia() });
  const [sucursal, setSucursal] = useState<number | null>(isAdmin ? null : (user?.sucursal_id ?? null));
  const [producto, setProducto] = useState("");
  const [talla, setTalla] = useState("");
  const [color, setColor] = useState("");
  const [usuario, setUsuario] = useState("");
  const [estado, setEstado] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [q, setQ] = useState("");
  const [pagina, setPagina] = useState(1);

  const [products, setProducts] = useState<Product[]>([]);
  const [sizes, setSizes] = useState<CatalogItem[]>([]);
  const [colors, setColors] = useState<CatalogItem[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [data, setData] = useState<MovementPage | null>(null);
  // Resumen de HOY (hora de Bolivia) de la ubicación elegida: unidades que entraron y salieron.
  const [hoy, setHoy] = useState<{ entradas: number; salidas: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const periodo = useMemo(() => resolverPeriodo(preset, custom, hoyBolivia()), [preset, custom]);
  const branchId = isAdmin ? sucursal : (user?.sucursal_id ?? null);

  useEffect(() => {
    void Promise.all([getProducts(), getSizes(), getColors(), isAdmin ? listUsers() : Promise.resolve([] as UserRow[])])
      .then(([p, s, c, u]) => {
        setProducts(p);
        setSizes(s);
        setColors(c);
        setUsers(u);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudieron cargar los filtros."));
  }, [isAdmin]);

  // Consulta al servidor cada vez que cambia un filtro (los filtros se aplican en el backend, no en el navegador).
  useEffect(() => {
    if (periodo.error) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError("");
    getMovements({
      categoria: tab === "TODOS" ? [] : [tab],
      desde: periodo.desde,
      hasta: periodo.hasta,
      sucursal_id: branchId,
      producto_id: producto ? Number(producto) : null,
      talla_id: talla ? Number(talla) : null,
      color_id: color ? Number(color) : null,
      usuario_id: usuario ? Number(usuario) : null,
      estado: tab === "TRASPASO" ? estado : "",
      q,
      pagina,
      limite: PAGE_SIZE,
    })
      .then((page) => {
        if (!cancelled) setData(page);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setData(null);
          setError(err instanceof Error ? err.message : "No se pudo cargar el historial de movimientos.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, periodo, branchId, producto, talla, color, usuario, estado, q, pagina]);

  const counts = useMemo(() => new Map((data?.por_categoria ?? []).map((c) => [c.categoria, c.movimientos])), [data]);
  const totalAll = (data?.por_categoria ?? []).reduce((a, c) => a + c.movimientos, 0);
  useEffect(() => {
    let cancelled = false;
    const dia = hoyBolivia();
    getMovements({ desde: dia, hasta: dia, sucursal_id: sucursal, limite: 1 })
      .then((p) => !cancelled && setHoy({ entradas: p.entradas, salidas: p.salidas }))
      .catch(() => !cancelled && setHoy(null));
    return () => {
      cancelled = true;
    };
  }, [sucursal]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limite)) : 1;
  const sortedSizes = useMemo(() => {
    const order = new Map(sortSizeLabels(sizes.map((s) => s.nombre)).map((n, i) => [n, i]));
    return [...sizes].sort((a, b) => (order.get(a.nombre) ?? 0) - (order.get(b.nombre) ?? 0));
  }, [sizes]);

  const reset = <T,>(setter: (v: T) => void) => (value: T) => {
    setter(value);
    setPagina(1);
  };

  return (
    <section className="space-y-4 sm:space-y-6">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <History size={20} className="text-gray-700" />
          <span className="text-sm font-medium text-gray-500">Historial del stock</span>
        </div>
        <h1 className="text-xl font-semibold text-black sm:text-2xl">Movimientos</h1>
        <p className="mt-1 text-sm text-gray-500">
          Cada entrada y salida de prendas: qué fue, quién lo hizo y cuándo. Un traspaso entre sucursales no cuenta como ingreso.
        </p>
      </div>

      {hoy && (
        <div className="grid grid-cols-2 gap-3" aria-label="Resumen de hoy">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500">Entraron hoy</p>
            <p className="mt-1 text-2xl font-semibold text-green-700">{hoy.entradas}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500">Salieron hoy</p>
            <p className="mt-1 text-2xl font-semibold text-red-700">{hoy.salidas}</p>
          </div>
        </div>
      )}

      <div role="tablist" aria-label="Tipo de movimiento" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {MAIN_TABS.map(({ tab: t, label }) => {
          const n = t === "TODOS" ? totalAll : (counts.get(t) ?? 0);
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => reset(setTab)(t)}
              className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition ${
                tab === t ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-700 hover:border-black"
              }`}
            >
              {label}
              <span className={`rounded-full px-2 py-0.5 text-xs ${tab === t ? "bg-white/20" : "bg-gray-100 text-gray-600"}`}>{n}</span>
            </button>
          );
        })}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          reset(setQ)(busqueda.trim());
        }}
        className="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4"
      >
        <FiltroPeriodo preset={preset} custom={custom} onPreset={reset(setPreset)} onCustom={reset(setCustom)} error={periodo.error} />

        {isAdmin && (
          <label className="text-xs font-medium text-gray-600">
            Sucursal
            <select className={`${FILTRO_INPUT} mt-1`} value={sucursal ?? ""} onChange={(e) => reset(setSucursal)(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{orgName}</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.nombre}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="text-xs font-medium text-gray-600">
          Modelo
          <select className={`${FILTRO_INPUT} mt-1`} value={producto} onChange={(e) => reset(setProducto)(e.target.value)}>
            <option value="">Todos los modelos</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-medium text-gray-600">
          Talla
          <select className={`${FILTRO_INPUT} mt-1`} value={talla} onChange={(e) => reset(setTalla)(e.target.value)}>
            <option value="">Todas las tallas</option>
            {sortedSizes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nombre}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-medium text-gray-600">
          Color
          <select className={`${FILTRO_INPUT} mt-1`} value={color} onChange={(e) => reset(setColor)(e.target.value)}>
            <option value="">Todos los colores</option>
            {colors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
        </label>

        {isAdmin && (
          <label className="text-xs font-medium text-gray-600">
            Responsable
            <select className={`${FILTRO_INPUT} mt-1`} value={usuario} onChange={(e) => reset(setUsuario)(e.target.value)}>
              <option value="">Todos los usuarios</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nombre}
                </option>
              ))}
            </select>
          </label>
        )}

        {tab === "TRASPASO" && (
          <label className="text-xs font-medium text-gray-600">
            Estado del traspaso
            <select className={`${FILTRO_INPUT} mt-1`} value={estado} onChange={(e) => reset(setEstado)(e.target.value)}>
              {TRANSFER_STATES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex gap-2 sm:col-span-2 lg:col-span-2">
          <label className="flex min-h-11 flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 focus-within:border-black">
            <Search size={16} className="shrink-0 text-gray-400" />
            <input
              type="search"
              aria-label="Buscar por número o producto"
              placeholder="N.º de venta, traspaso o lote (V-000123, TR-000012, L-000012) o producto"
              maxLength={80}
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              className="w-full min-w-0 bg-transparent text-sm outline-none"
            />
          </label>
          <button type="submit" className="min-h-11 rounded-lg bg-black px-4 text-sm font-medium text-white hover:bg-gray-800">
            Buscar
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3 text-sm sm:px-6">
          <span className="font-medium text-black">{loading ? "Cargando…" : `${data?.total ?? 0} movimientos`}</span>
          {data && !loading && <span className="text-gray-500">{data.unidades} unidades en total</span>}
        </div>

        {loading && !data ? (
          <div className="flex items-center justify-center gap-3 p-10 text-gray-500">
            <LoaderCircle size={20} className="animate-spin" /> Cargando…
          </div>
        ) : data && data.filas.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No hay movimientos con estos filtros.</p>
        ) : (
          <>
            {/* Móvil: tarjetas */}
            <ul className="divide-y divide-gray-100 md:hidden">
              {data?.filas.map((m) => (
                <li key={m.id} className="space-y-1 p-4 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[m.categoria]}`}>{MOVEMENT_LABELS[m.categoria]}</span>
                    <span className="text-lg font-semibold text-black">{signed(m)}</span>
                  </div>
                  <p className="break-words font-medium text-black">{m.producto.nombre}</p>
                  <p className="text-gray-600">Talla {m.talla.nombre} · {m.color.nombre} · {m.sucursal.nombre}</p>
                  {detail(m) && <p className="text-gray-600">{detail(m)}</p>}
                  <p className="text-xs text-gray-500">
                    {formatBoliviaDateTime(m.fecha)} · {m.usuario?.nombre ?? "No registrado"}
                    {m.documento ? ` · ${m.documento.codigo}` : ""} · {m.referencia}
                  </p>
                </li>
              ))}
            </ul>

            {/* Escritorio: tabla */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Fecha</th>
                    <th className="px-4 py-3">Tipo</th>
                    <th className="px-4 py-3">Producto</th>
                    <th className="px-4 py-3">Talla</th>
                    <th className="px-4 py-3">Color</th>
                    <th className="px-4 py-3 text-right">Cantidad</th>
                    <th className="px-4 py-3">Sucursal</th>
                    <th className="px-4 py-3">Responsable</th>
                    <th className="px-4 py-3">Documento</th>
                    <th className="px-4 py-3">Detalle</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data?.filas.map((m) => (
                    <tr key={m.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-3 text-gray-600">{formatBoliviaDateTime(m.fecha)}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[m.categoria]}`}>{MOVEMENT_LABELS[m.categoria]}</span>
                      </td>
                      <td className="px-4 py-3 font-medium text-black">{m.producto.nombre}</td>
                      <td className="px-4 py-3">{m.talla.nombre}</td>
                      <td className="px-4 py-3">{m.color.nombre}</td>
                      <td className="px-4 py-3 text-right font-semibold">{signed(m)}</td>
                      <td className="px-4 py-3">{m.sucursal.nombre}</td>
                      <td className="px-4 py-3">{m.usuario?.nombre ?? <span className="text-gray-400">No registrado</span>}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                        {m.documento?.codigo ?? "—"}
                        <span className="block text-xs text-gray-400">{m.referencia}</span>
                      </td>
                      <td className="max-w-xs px-4 py-3 text-gray-600">{detail(m) || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 p-4 text-sm">
          <button type="button" disabled={pagina <= 1 || loading} onClick={() => setPagina((p) => p - 1)} className="min-h-11 rounded-lg border border-gray-200 px-4 font-medium hover:border-black disabled:opacity-40">
            Anterior
          </button>
          <span className="text-gray-600">
            Página {pagina} de {pages}
          </span>
          <button type="button" disabled={pagina >= pages || loading} onClick={() => setPagina((p) => p + 1)} className="min-h-11 rounded-lg border border-gray-200 px-4 font-medium hover:border-black disabled:opacity-40">
            Siguiente
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-400">Categorías registradas: {MOVEMENT_CATEGORIES.map((c) => MOVEMENT_LABELS[c]).join(", ")}.</p>
    </section>
  );
}

/** Historial del stock: movimientos (libro) y lotes (edad y ritmo de venta). */
function Movimientos() {
  const [vista, setVista] = useState<"movimientos" | "lotes">("movimientos");
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Vista" className="flex gap-2">
        {([["movimientos", "Movimientos"], ["lotes", "Lotes"]] as const).map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={vista === v}
            onClick={() => setVista(v)}
            className={`min-h-11 rounded-full border px-5 text-sm font-medium transition ${vista === v ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-700 hover:border-black"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {vista === "movimientos" ? <MovimientosLibro /> : <LotesReporte />}
    </div>
  );
}

export default Movimientos;
