import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, LoaderCircle, Search } from "lucide-react";

import { FILTRO_INPUT, FiltroPeriodo } from "../../components/filtros/FiltroPeriodo";
import { sortSizeLabels } from "../../lib/catalogo";
import { resolverPeriodo, type PeriodoAnalisis } from "../../lib/periodoFiltro";
import { hoyBolivia, type Rango } from "../../lib/periodos";
import { formatBoliviaDateTime } from "../../lib/receipt";
import type { CatalogItem, Product } from "../../services/product.service";
import {
  getTransferDetail,
  getTransferHistory,
  type TransferDetail,
  type TransferHistoryPage,
  type TransferHistoryRow,
  type TransferStatus,
  type TransferUser,
} from "../../services/transfers.service";

const STATUS_STYLE: Record<TransferStatus, string> = {
  pendiente: "bg-yellow-50 text-yellow-700",
  enviado: "bg-blue-50 text-blue-700",
  recibido: "bg-green-50 text-green-700",
  cancelado: "bg-gray-100 text-gray-600",
};

/** "pendiente" es el borrador del flujo BORRADOR → ENVIADO → RECIBIDO: no ha descontado stock. */
const STATUS_TEXT: Record<TransferStatus, string> = {
  pendiente: "Por enviar",
  enviado: "Enviado",
  recibido: "Recibido",
  cancelado: "Cancelado",
};

const PAGE_SIZE = 10;

const who = (u: TransferUser | null) => u?.nombre ?? "No registrado";

interface Props {
  branches: { id: number; nombre: string }[];
  products: Product[];
  sizes: CatalogItem[];
  colors: CatalogItem[];
  /** Cambia cuando una acción (despachar, recibir, cancelar, crear) modifica los traspasos. */
  refreshToken: number;
  busy: boolean;
  /** Ejecuta una acción del traspaso y avisa el resultado (lo maneja la página). */
  onAction: (action: () => Promise<unknown>, okMessage: string) => Promise<void>;
  actions: {
    dispatch: (id: number) => Promise<unknown>;
    receive: (id: number) => Promise<unknown>;
    cancel: (id: number) => Promise<unknown>;
  };
}

function TraspasosHistorial({ branches, products, sizes, colors, refreshToken, busy, onAction, actions }: Props) {
  const [estado, setEstado] = useState<TransferStatus | "">("");
  const [origen, setOrigen] = useState("");
  const [destino, setDestino] = useState("");
  const [producto, setProducto] = useState("");
  const [talla, setTalla] = useState("");
  const [color, setColor] = useState("");
  const [preset, setPreset] = useState<PeriodoAnalisis>("todo");
  const [custom, setCustom] = useState<Rango>({ desde: hoyBolivia(), hasta: hoyBolivia() });
  const [busqueda, setBusqueda] = useState("");
  const [q, setQ] = useState("");
  const [pagina, setPagina] = useState(1);

  const [data, setData] = useState<TransferHistoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TransferDetail | null>(null);

  const periodo = useMemo(() => resolverPeriodo(preset, custom, hoyBolivia()), [preset, custom]);
  const orderedSizes = useMemo(() => {
    const order = new Map(sortSizeLabels(sizes.map((s) => s.nombre)).map((n, i) => [n, i]));
    return [...sizes].sort((a, b) => (order.get(a.nombre) ?? 0) - (order.get(b.nombre) ?? 0));
  }, [sizes]);

  useEffect(() => {
    if (periodo.error) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError("");
    getTransferHistory({
      estado,
      origen_id: origen ? Number(origen) : null,
      destino_id: destino ? Number(destino) : null,
      producto_id: producto ? Number(producto) : null,
      talla_id: talla ? Number(talla) : null,
      color_id: color ? Number(color) : null,
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
          setError(err instanceof Error ? err.message : "No se pudo cargar el historial de traspasos.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [estado, origen, destino, producto, talla, color, periodo, q, pagina, refreshToken]);

  // El detalle abierto se recarga cuando cambia algo (así muestra el nuevo estado y los usuarios).
  useEffect(() => {
    if (openId === null) return;
    let cancelled = false;
    getTransferDetail(openId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [openId, refreshToken]);

  const back = <T,>(setter: (v: T) => void) => (value: T) => {
    setter(value);
    setPagina(1);
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limite)) : 1;

  const renderRow = (t: TransferHistoryRow) => {
    const open = openId === t.id;
    return (
      <li key={t.id} className="p-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-black">
              {t.referencia} · {t.origen.nombre} → {t.destino.nombre}{" "}
              <span className={`ml-1 rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[t.estado]}`}>{STATUS_TEXT[t.estado]}</span>
            </p>
            <p className="text-xs text-gray-500">
              Creado {formatBoliviaDateTime(t.fecha)} por {who(t.creado_por)} · {t.unidades} {t.unidades === 1 ? "unidad" : "unidades"} · {t.items.length}{" "}
              {t.items.length === 1 ? "línea" : "líneas"}
              {t.notas ? ` · ${t.notas}` : ""}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {t.estado === "pendiente" && (
              <button type="button" disabled={busy} onClick={() => void onAction(() => actions.dispatch(t.id), `Traspaso ${t.referencia} despachado: stock descontado del origen.`)} className="min-h-11 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium hover:border-black disabled:opacity-50 sm:min-h-9">
                Despachar
              </button>
            )}
            {t.estado === "enviado" && (
              <button type="button" disabled={busy} onClick={() => void onAction(() => actions.receive(t.id), `Traspaso ${t.referencia} recibido: stock sumado al destino.`)} className="min-h-11 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium hover:border-black disabled:opacity-50 sm:min-h-9">
                Confirmar recepción
              </button>
            )}
            {(t.estado === "pendiente" || t.estado === "enviado") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`¿Cancelar el traspaso ${t.referencia}? ${t.estado === "enviado" ? "El stock despachado vuelve al origen." : ""}`)) {
                    void onAction(() => actions.cancel(t.id), `Traspaso ${t.referencia} cancelado.`);
                  }
                }}
                className="min-h-11 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:border-red-600 disabled:opacity-50 sm:min-h-9"
              >
                Cancelar
              </button>
            )}
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? `Ocultar detalle de ${t.referencia}` : `Ver detalle de ${t.referencia}`}
              onClick={() => {
                setDetail(null);
                setOpenId(open ? null : t.id);
              }}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 sm:h-9 sm:w-9"
            >
              {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>
          </div>
        </div>

        <ul className="mt-2 text-sm text-gray-600">
          {t.items.map((i) => (
            <li key={`${i.producto_id}-${i.talla_id}-${i.color_id}`}>
              {i.producto} · talla {i.talla} · {i.color} · <b>{i.cantidad}</b> u.
            </li>
          ))}
        </ul>

        {open && (
          <div className="mt-3 space-y-2 rounded-lg bg-gray-50 p-3 text-sm sm:p-4">
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              <div><dt className="inline text-gray-500">Creado por: </dt><dd className="inline">{who(detail?.creado_por ?? t.creado_por)}</dd></div>
              <div><dt className="inline text-gray-500">Entrega: </dt><dd className="inline">{t.responsable || "No registrado"}</dd></div>
              <div><dt className="inline text-gray-500">Despachado por: </dt><dd className="inline">{who(detail?.despachado_por ?? t.despachado_por)}{t.enviado_at ? ` · ${formatBoliviaDateTime(t.enviado_at)}` : ""}</dd></div>
              <div><dt className="inline text-gray-500">Recibido por: </dt><dd className="inline">{who(detail?.recibido_por ?? t.recibido_por)}{t.recibido_at ? ` · ${formatBoliviaDateTime(t.recibido_at)}` : ""}</dd></div>
              {t.estado === "cancelado" && (
                <div><dt className="inline text-gray-500">Cancelado por: </dt><dd className="inline">{who(detail?.cancelado_por ?? t.cancelado_por)}{t.cancelado_at ? ` · ${formatBoliviaDateTime(t.cancelado_at)}` : ""}</dd></div>
              )}
            </dl>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Movimientos de inventario generados</p>
            {!detail ? (
              <p className="text-gray-500">Cargando…</p>
            ) : detail.movimientos.length === 0 ? (
              <p className="text-gray-500">Todavía no se envió: aún no descuenta stock.</p>
            ) : (
              <ul className="divide-y divide-gray-200">
                {detail.movimientos.map((m) => (
                  <li key={m.id} className="flex flex-wrap justify-between gap-2 py-1">
                    <span>
                      {m.sucursal}: {m.producto} · {m.talla} · {m.color} · <b>{m.signo === 1 ? "+" : "−"}{m.cantidad}</b>
                      {m.cantidad_anterior !== null ? ` (${m.cantidad_anterior} → ${m.cantidad_resultante})` : ""}
                    </span>
                    <span className="text-xs text-gray-500">{formatBoliviaDateTime(m.fecha)} · {m.usuario ?? "No registrado"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-200 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-black">Historial de traspasos</h2>
        <p className="mt-1 text-sm text-gray-500">Quién creó, despachó y recibió cada traspaso, cuándo, y cada línea con su modelo, talla, color y cantidad.</p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          back(setQ)(busqueda.trim());
        }}
        className="grid gap-3 border-b border-gray-200 p-4 sm:grid-cols-2 sm:p-6 lg:grid-cols-4"
      >
        <label className="text-xs font-medium text-gray-600">
          Estado
          <select className={`${FILTRO_INPUT} mt-1`} value={estado} onChange={(e) => back(setEstado)(e.target.value as TransferStatus | "")}>
            <option value="">Todos</option>
            {(Object.keys(STATUS_TEXT) as TransferStatus[]).map((s) => (
              <option key={s} value={s}>{STATUS_TEXT[s]}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Origen
          <select className={`${FILTRO_INPUT} mt-1`} value={origen} onChange={(e) => back(setOrigen)(e.target.value)}>
            <option value="">Cualquiera</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Destino
          <select className={`${FILTRO_INPUT} mt-1`} value={destino} onChange={(e) => back(setDestino)(e.target.value)}>
            <option value="">Cualquiera</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}
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
        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <label className="flex min-h-11 flex-1 items-center gap-2 rounded-lg border border-gray-200 px-3 focus-within:border-black">
            <Search size={16} className="shrink-0 text-gray-400" />
            <input type="search" aria-label="Buscar traspaso" placeholder="TR-000012, modelo, nota…" maxLength={80} value={busqueda} onChange={(e) => setBusqueda(e.target.value)} className="w-full min-w-0 bg-transparent text-sm outline-none" />
          </label>
          <button type="submit" className="min-h-11 rounded-lg bg-black px-4 text-sm font-medium text-white hover:bg-gray-800">Buscar</button>
        </div>
      </form>

      {error && <p role="alert" className="m-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 sm:m-6">{error}</p>}

      {loading && !data ? (
        <div className="flex items-center justify-center gap-3 p-10 text-gray-500"><LoaderCircle size={20} className="animate-spin" /> Cargando…</div>
      ) : data && data.filas.length === 0 ? (
        <p className="p-6 text-sm text-gray-500">No hay traspasos con estos filtros.</p>
      ) : (
        <ul className="divide-y divide-gray-100">{data?.filas.map((t) => renderRow(t))}</ul>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-gray-200 p-4 text-sm">
        <button type="button" disabled={pagina <= 1 || loading} onClick={() => setPagina((p) => p - 1)} className="min-h-11 rounded-lg border border-gray-200 px-4 font-medium hover:border-black disabled:opacity-40">Anterior</button>
        <span className="text-center text-gray-600">Página {pagina} de {pages}{data ? ` · ${data.total} traspasos · ${data.unidades} unidades` : ""}</span>
        <button type="button" disabled={pagina >= pages || loading} onClick={() => setPagina((p) => p + 1)} className="min-h-11 rounded-lg border border-gray-200 px-4 font-medium hover:border-black disabled:opacity-40">Siguiente</button>
      </div>
    </section>
  );
}

export default TraspasosHistorial;
