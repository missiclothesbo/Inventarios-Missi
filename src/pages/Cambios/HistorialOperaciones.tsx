import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";

import { FILTRO_INPUT, FiltroPeriodo } from "../../components/filtros/FiltroPeriodo";
import { useAuth } from "../../context/useAuth";
import { RETURN_REASONS, RETURN_REASON_LABELS, sortSizeLabels } from "../../lib/catalogo";
import { resolverPeriodo, type PeriodoAnalisis } from "../../lib/periodoFiltro";
import { hoyBolivia, type Rango } from "../../lib/periodos";
import { formatBoliviaDateTime, money } from "../../lib/receipt";
import {
  getOperationHistory,
  type OperationHistoryItem,
  type OperationHistoryPage,
  type OperationHistoryRow,
} from "../../services/operations.service";
import type { CatalogItem, Product } from "../../services/product.service";
import { listUsers, type UserRow } from "../../services/users.service";

const TYPE_TEXT = { devolucion: "Devolución", cambio: "Cambio", anulacion: "Anulación" } as const;
const TYPE_STYLE = { devolucion: "bg-orange-50 text-orange-700", cambio: "bg-yellow-50 text-yellow-800", anulacion: "bg-red-50 text-red-700" } as const;
const PAGE_SIZE = 10;

const Lines = ({ title, items }: { title: string; items: OperationHistoryItem[] }) =>
  items.length === 0 ? null : (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{title}</p>
      <ul className="text-sm text-gray-700">
        {items.map((i, k) => (
          <li key={k}>
            {i.producto} · talla {i.talla} · {i.color} · <b>{i.cantidad}</b> × {money(i.precio_unitario)}
            {i.condicion === "danado" ? " · dañado (no vuelve al stock vendible)" : ""}
          </li>
        ))}
      </ul>
    </div>
  );

interface Props {
  products: Product[];
  sizes: CatalogItem[];
  colors: CatalogItem[];
  /** Cambia cuando se registra una operación nueva. */
  refreshToken: number;
}

/** Historial buscable de devoluciones, cambios y anulaciones, con motivo, responsable y detalle de artículos. */
function HistorialOperaciones({ products, sizes, colors, refreshToken }: Props) {
  const { user } = useAuth();
  const isAdmin = user?.rol === "admin";

  const [tipo, setTipo] = useState<"" | "devolucion" | "cambio" | "anulacion">("");
  const [motivo, setMotivo] = useState("");
  const [producto, setProducto] = useState("");
  const [talla, setTalla] = useState("");
  const [color, setColor] = useState("");
  const [usuario, setUsuario] = useState("");
  const [preset, setPreset] = useState<PeriodoAnalisis>("todo");
  const [custom, setCustom] = useState<Rango>({ desde: hoyBolivia(), hasta: hoyBolivia() });
  const [busqueda, setBusqueda] = useState("");
  const [q, setQ] = useState("");
  const [pagina, setPagina] = useState(1);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [data, setData] = useState<OperationHistoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const periodo = useMemo(() => resolverPeriodo(preset, custom, hoyBolivia()), [preset, custom]);
  const orderedSizes = useMemo(() => {
    const order = new Map(sortSizeLabels(sizes.map((s) => s.nombre)).map((n, i) => [n, i]));
    return [...sizes].sort((a, b) => (order.get(a.nombre) ?? 0) - (order.get(b.nombre) ?? 0));
  }, [sizes]);

  useEffect(() => {
    if (!isAdmin) return;
    void listUsers().then(setUsers).catch(() => undefined);
  }, [isAdmin]);

  useEffect(() => {
    if (periodo.error) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError("");
    getOperationHistory({
      tipo,
      motivo_codigo: motivo,
      producto_id: producto ? Number(producto) : null,
      talla_id: talla ? Number(talla) : null,
      color_id: color ? Number(color) : null,
      usuario_id: usuario ? Number(usuario) : null,
      desde: periodo.desde,
      hasta: periodo.hasta,
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
          setError(err instanceof Error ? err.message : "No se pudo cargar el historial.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tipo, motivo, producto, talla, color, usuario, periodo, q, pagina, refreshToken]);

  const back = <T,>(setter: (v: T) => void) => (value: T) => {
    setter(value);
    setPagina(1);
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limite)) : 1;

  const renderRow = (o: OperationHistoryRow) => (
    <li key={o.id} className="space-y-2 p-4 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-black">
          {o.referencia}{" "}
          <span className={`ml-1 rounded-full px-2 py-0.5 text-xs ${TYPE_STYLE[o.tipo]}`}>{TYPE_TEXT[o.tipo]}</span>{" "}
          <span className="text-gray-500">· venta {o.venta_referencia}</span>
        </p>
        <p className="text-xs text-gray-500">{formatBoliviaDateTime(o.fecha)} · {o.sucursal}</p>
      </div>
      <p className="text-sm text-gray-700">
        <span className="text-gray-500">Motivo:</span> <b>{o.motivo_etiqueta}</b>
        {o.motivo && o.motivo !== o.motivo_etiqueta ? ` — ${o.motivo}` : ""}
      </p>
      <p className="text-xs text-gray-500">
        Responsable: {o.operador.nombre}
        {o.cliente_nombre ? ` · Cliente: ${o.cliente_nombre}${o.cliente_telefono ? ` (${o.cliente_telefono})` : ""}` : ""}
        {` · Devuelto ${money(o.valor_devuelto)}`}
        {o.tipo === "cambio" ? ` · Entregado ${money(o.valor_entregado)}` : ""}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Lines title={o.tipo === "cambio" ? "Devuelto" : "Artículos"} items={o.devueltos} />
        <Lines title="Reemplazo entregado" items={o.entregados} />
      </div>
    </li>
  );

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-200 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-black">Historial de devoluciones y cambios</h2>
        <p className="mt-1 text-sm text-gray-500">Cada devolución, cambio o anulación con su motivo, quién la hizo, la venta original y las prendas. Las antiguas sin motivo aparecen como «Sin clasificar».</p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          back(setQ)(busqueda.trim());
        }}
        className="grid gap-3 border-b border-gray-200 p-4 sm:grid-cols-2 sm:p-6 lg:grid-cols-4"
      >
        <label className="text-xs font-medium text-gray-600">
          Tipo
          <select className={`${FILTRO_INPUT} mt-1`} value={tipo} onChange={(e) => back(setTipo)(e.target.value as typeof tipo)}>
            <option value="">Todos</option>
            <option value="devolucion">Devoluciones</option>
            <option value="cambio">Cambios</option>
            <option value="anulacion">Anulaciones</option>
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Motivo
          <select className={`${FILTRO_INPUT} mt-1`} value={motivo} onChange={(e) => back(setMotivo)(e.target.value)}>
            <option value="">Todos</option>
            {RETURN_REASONS.map((r) => <option key={r} value={r}>{RETURN_REASON_LABELS[r]}</option>)}
            <option value="SIN_CLASIFICAR">Sin clasificar (anteriores)</option>
          </select>
        </label>
        <FiltroPeriodo preset={preset} custom={custom} onPreset={back(setPreset)} onCustom={back(setCustom)} error={periodo.error} />
        <label className="text-xs font-medium text-gray-600">
          Modelo
          <select className={`${FILTRO_INPUT} mt-1`} value={producto} onChange={(e) => back(setProducto)(e.target.value)}>
            <option value="">Todos</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Talla
          <select className={`${FILTRO_INPUT} mt-1`} value={talla} onChange={(e) => back(setTalla)(e.target.value)}>
            <option value="">Todas</option>
            {orderedSizes.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Color
          <select className={`${FILTRO_INPUT} mt-1`} value={color} onChange={(e) => back(setColor)(e.target.value)}>
            <option value="">Todos</option>
            {colors.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
        {isAdmin && (
          <label className="text-xs font-medium text-gray-600">
            Responsable
            <select className={`${FILTRO_INPUT} mt-1`} value={usuario} onChange={(e) => back(setUsuario)(e.target.value)}>
              <option value="">Todos</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
            </select>
          </label>
        )}
        <div className="flex gap-2 sm:col-span-2">
          <label className="flex min-h-11 flex-1 items-center gap-2 rounded-lg border border-gray-200 px-3 focus-within:border-black">
            <Search size={16} className="shrink-0 text-gray-400" />
            <input type="search" aria-label="Buscar devolución o cambio" placeholder="CM-000012, V-000123, cliente, modelo…" maxLength={80} value={busqueda} onChange={(e) => setBusqueda(e.target.value)} className="w-full min-w-0 bg-transparent text-sm outline-none" />
          </label>
          <button type="submit" className="min-h-11 rounded-lg bg-black px-4 text-sm font-medium text-white hover:bg-gray-800">Buscar</button>
        </div>
      </form>

      {error && <p role="alert" className="m-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 sm:m-6">{error}</p>}

      {loading && !data ? (
        <div className="flex items-center justify-center gap-3 p-10 text-gray-500"><LoaderCircle size={20} className="animate-spin" /> Cargando…</div>
      ) : data && data.filas.length === 0 ? (
        <p className="p-6 text-sm text-gray-500">No hay devoluciones ni cambios con estos filtros.</p>
      ) : (
        <ul className="divide-y divide-gray-100">{data?.filas.map((o) => renderRow(o))}</ul>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-gray-200 p-4 text-sm">
        <button type="button" disabled={pagina <= 1 || loading} onClick={() => setPagina((p) => p - 1)} className="min-h-11 rounded-lg border border-gray-200 px-4 font-medium hover:border-black disabled:opacity-40">Anterior</button>
        <span className="text-center text-gray-600">Página {pagina} de {pages}{data ? ` · ${data.total} operaciones` : ""}</span>
        <button type="button" disabled={pagina >= pages || loading} onClick={() => setPagina((p) => p + 1)} className="min-h-11 rounded-lg border border-gray-200 px-4 font-medium hover:border-black disabled:opacity-40">Siguiente</button>
      </div>
    </section>
  );
}

export default HistorialOperaciones;
