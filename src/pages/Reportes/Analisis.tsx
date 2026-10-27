import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

import { FILTRO_INPUT, FiltroPeriodo } from "../../components/filtros/FiltroPeriodo";
import { useAuth } from "../../context/useAuth";
import { useSucursal } from "../../context/useSucursal";
import { DEPARTMENTS, sortSizeLabels } from "../../lib/catalogo";
import { resolverPeriodo, type PeriodoAnalisis } from "../../lib/periodoFiltro";
import { hoyBolivia, formatFecha, type Rango } from "../../lib/periodos";
import { csvFileName, downloadCsv, toCsv } from "../../lib/csv";
import { money } from "../../lib/receipt";
import {
  getModelReport,
  getShippingReport,
  getSummaryReport,
  type ModelReport,
  type ShippingReport,
  type SummaryReport,
} from "../../services/analytics.service";
import { getColors, getProducts, getSizes, type CatalogItem, type Product } from "../../services/product.service";

type View = "resumen" | "modelos" | "envios";

const VIEWS: { view: View; label: string }[] = [
  { view: "resumen", label: "Resumen general" },
  { view: "modelos", label: "Modelos más vendidos" },
  { view: "envios", label: "Envíos por departamento" },
];

function Card({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <h2 className="text-base font-semibold text-black">{title}</h2>
      {note && <p className="mt-1 text-xs text-gray-500">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-0.5 text-xl font-semibold text-black">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

/** Lista simple con barra proporcional (clave, valor principal, detalle opcional). */
function Bars({ rows, empty = "Sin datos en este periodo." }: { rows: { key: string; value: number; label?: string; detail?: string }[]; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="text-sm text-gray-500">{empty}</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.key} className="text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 break-words text-black">{r.key}</span>
            <span className="shrink-0 font-semibold">{r.label ?? r.value}</span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-gray-100">
            <div className="h-2 rounded-full bg-black" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </div>
          {r.detail && <p className="mt-0.5 text-xs text-gray-500">{r.detail}</p>}
        </li>
      ))}
    </ul>
  );
}

function Analisis() {
  const { user } = useAuth();
  const { branches } = useSucursal();
  const orgName = "Todas las ubicaciones";
  const isAdmin = user?.rol === "admin";

  const [view, setView] = useState<View>("resumen");
  const [preset, setPreset] = useState<PeriodoAnalisis>("mes_actual");
  const [custom, setCustom] = useState<Rango>({ desde: hoyBolivia(), hasta: hoyBolivia() });
  const [sucursal, setSucursal] = useState<number | null>(isAdmin ? null : (user?.sucursal_id ?? null));
  const [producto, setProducto] = useState("");
  const [talla, setTalla] = useState("");
  const [color, setColor] = useState("");
  const [metodo, setMetodo] = useState<"" | "QR" | "efectivo">("");
  const [modalidad, setModalidad] = useState<"" | "entrega_directa" | "envio" | "envio_interprovincial">("");
  const [departamento, setDepartamento] = useState("");
  const [provincia, setProvincia] = useState("");
  const [municipio, setMunicipio] = useState("");

  const [products, setProducts] = useState<Product[]>([]);
  const [sizes, setSizes] = useState<CatalogItem[]>([]);
  const [colors, setColors] = useState<CatalogItem[]>([]);
  const [summary, setSummary] = useState<SummaryReport | null>(null);
  const [models, setModels] = useState<ModelReport | null>(null);
  const [shipping, setShipping] = useState<ShippingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const periodo = useMemo(() => resolverPeriodo(preset, custom, hoyBolivia()), [preset, custom]);
  const branchId = isAdmin ? sucursal : (user?.sucursal_id ?? null);
  const orderedSizes = useMemo(() => {
    const order = new Map(sortSizeLabels(sizes.map((s) => s.nombre)).map((n, i) => [n, i]));
    return [...sizes].sort((a, b) => (order.get(a.nombre) ?? 0) - (order.get(b.nombre) ?? 0));
  }, [sizes]);

  useEffect(() => {
    void Promise.all([getProducts(), getSizes(), getColors()])
      .then(([p, s, c]) => {
        setProducts(p);
        setSizes(s);
        setColors(c);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (periodo.error) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError("");
    const base = { desde: periodo.desde, hasta: periodo.hasta, sucursal_id: branchId };
    // Mismos filtros de venta que el historial de ventas: así los totales cuadran entre pantallas.
    const scope = {
      ...base,
      metodo_pago: metodo || undefined,
      modalidad: modalidad || undefined,
      departamento: departamento || undefined,
      provincia: provincia.trim() || undefined,
      municipio: municipio.trim() || undefined,
      producto_id: producto ? Number(producto) : null,
      talla_id: talla ? Number(talla) : null,
      color_id: color ? Number(color) : null,
    };
    const job =
      view === "resumen"
        ? getSummaryReport(base).then((r) => !cancelled && setSummary(r))
        : view === "modelos"
          ? getModelReport({ ...scope, limite: 20 }).then((r) => !cancelled && setModels(r))
          : getShippingReport(scope).then((r) => !cancelled && setShipping(r));
    job
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "No se pudo generar el análisis.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, periodo, branchId, producto, talla, color, metodo, modalidad, departamento, provincia, municipio]);

  const rangeText = periodo.desde && periodo.hasta ? `${formatFecha(periodo.desde)} al ${formatFecha(periodo.hasta)}` : "Todo el historial";
  const branchText = branchId === null ? `${orgName} (todas las sucursales)` : (branches.find((b) => b.id === branchId)?.nombre ?? "—");

  return (
    <div className="space-y-4 sm:space-y-6">
      <div role="tablist" aria-label="Tipo de análisis" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {VIEWS.map(({ view: v, label }) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={`min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium transition ${view === v ? "border-black bg-black text-white" : "border-gray-200 bg-white text-gray-700 hover:border-black"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4">
        <FiltroPeriodo preset={preset} custom={custom} onPreset={setPreset} onCustom={setCustom} error={periodo.error} />
        {isAdmin && (
          <label className="text-xs font-medium text-gray-600">
            Sucursal
            <select className={`${FILTRO_INPUT} mt-1`} value={sucursal ?? ""} onChange={(e) => setSucursal(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{orgName} (todas las sucursales)</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}
            </select>
          </label>
        )}
        {(view === "modelos" || view === "envios") && (
          <>
            <label className="text-xs font-medium text-gray-600">
              Método de pago
              <select className={`${FILTRO_INPUT} mt-1`} value={metodo} onChange={(e) => setMetodo(e.target.value as typeof metodo)}>
                <option value="">Todos</option>
                <option value="efectivo">Efectivo</option>
                <option value="QR">QR</option>
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600">
              Tipo de entrega
              <select className={`${FILTRO_INPUT} mt-1`} value={modalidad} onChange={(e) => setModalidad(e.target.value as typeof modalidad)}>
                <option value="">Todos</option>
                <option value="entrega_directa">Entrega directa</option>
                <option value="envio">Envío a departamento</option>
                <option value="envio_interprovincial">Envío interprovincial</option>
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600">
              Departamento de destino
              <select className={`${FILTRO_INPUT} mt-1`} value={departamento} onChange={(e) => setDepartamento(e.target.value)}>
                <option value="">Todos</option>
                {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                <option value="SIN_REGISTRAR">Envío sin departamento registrado</option>
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600">
              Provincia
              <input className={`${FILTRO_INPUT} mt-1`} maxLength={100} value={provincia} onChange={(e) => setProvincia(e.target.value)} />
            </label>
            <label className="text-xs font-medium text-gray-600">
              Municipio
              <input className={`${FILTRO_INPUT} mt-1`} maxLength={100} value={municipio} onChange={(e) => setMunicipio(e.target.value)} />
            </label>
            <label className="text-xs font-medium text-gray-600">
              Modelo
              <select className={`${FILTRO_INPUT} mt-1`} value={producto} onChange={(e) => setProducto(e.target.value)}>
                <option value="">Todos</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600">
              Talla
              <select className={`${FILTRO_INPUT} mt-1`} value={talla} onChange={(e) => setTalla(e.target.value)}>
                <option value="">Todas</option>
                {orderedSizes.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium text-gray-600">
              Color
              <select className={`${FILTRO_INPUT} mt-1`} value={color} onChange={(e) => setColor(e.target.value)}>
                <option value="">Todos</option>
                {colors.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </label>
          </>
        )}
      </div>

      <p className="text-sm text-gray-500">
        {branchText} · {rangeText}
      </p>

      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {loading && (
        <div className="flex items-center gap-3 p-6 text-gray-500"><LoaderCircle size={20} className="animate-spin" /> Calculando…</div>
      )}

      {!loading && !error && view === "resumen" && summary && <ResumenView data={summary} />}
      {!loading && !error && view === "modelos" && models && <ModelosView data={models} desde={periodo.desde} hasta={periodo.hasta} />}
      {!loading && !error && view === "envios" && shipping && <EnviosView data={shipping} showHistory={periodo.desde !== undefined} desde={periodo.desde} hasta={periodo.hasta} />}
    </div>
  );
}

// ---------------------------------------------------------------- resumen

function ResumenView({ data }: { data: SummaryReport }) {
  const v = data.ventas;
  const t = data.traspasos;
  const d = data.devoluciones_y_cambios;
  const m = data.movimientos;
  return (
    <div className="space-y-4">
      <Card title="Ventas" note="Solo ventas completadas. Las devoluciones y cambios se muestran aparte y solo restan en el neto.">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Ventas completadas" value={v.completadas} />
          <Stat label="Unidades vendidas" value={v.unidades} />
          <Stat label="Ingresos brutos" value={money(v.ingresos_brutos)} />
          <Stat label="Ticket promedio" value={money(v.ticket_promedio)} />
          <Stat label="Devuelto (devoluciones y cambios)" value={money(v.devoluciones_y_cambios_valor_devuelto)} hint="Se muestra aparte" />
          <Stat label="Entregado en cambios" value={money(v.cambios_valor_entregado)} hint="No es una venta nueva" />
          <Stat label="Ingresos netos" value={money(v.ingresos_netos)} hint="brutos − devuelto + entregado" />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium text-gray-700">Por sucursal</h3>
            <Bars rows={v.por_sucursal.map((s) => ({ key: s.sucursal, value: s.ingresos, label: money(s.ingresos), detail: `${s.ventas} ventas` }))} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-gray-700">Por modelo (unidades)</h3>
            <Bars rows={v.por_modelo.map((p) => ({ key: p.producto, value: p.unidades, detail: `${p.ventas} ventas · ${money(p.ingresos)}` }))} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-gray-700">Por talla</h3>
            <Bars rows={v.por_talla.map((s) => ({ key: s.talla, value: s.unidades }))} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-gray-700">Por color</h3>
            <Bars rows={v.por_color.map((c) => ({ key: c.color, value: c.unidades }))} />
          </div>
        </div>
      </Card>

      <Card title="Traspasos entre sucursales" note={data.definiciones.traspasos}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Traspasos (referencias)" value={t.referencias} />
          <Stat label="Unidades en traspasos" value={t.unidades} />
          <Stat label="Unidades recibidas" value={t.unidades_recibidas} />
          <Stat label="Pendientes / enviados" value={`${t.por_estado.pendiente} / ${t.por_estado.enviado}`} />
          <Stat label="Recibidos" value={t.por_estado.recibido} />
          <Stat label="Cancelados" value={t.por_estado.cancelado} />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium text-gray-700">Por ruta</h3>
            <Bars rows={t.por_ruta.map((r) => ({ key: `${r.origen} → ${r.destino}`, value: r.unidades, detail: `${r.traspasos} traspasos` }))} empty="Sin traspasos." />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-gray-700">Por modelo</h3>
            <Bars rows={t.por_modelo.map((p) => ({ key: p.producto, value: p.unidades }))} empty="Sin traspasos." />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-gray-700">Por talla</h3>
            <Bars rows={t.por_talla.map((s) => ({ key: s.talla, value: s.unidades }))} empty="Sin traspasos." />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-gray-700">Por color</h3>
            <Bars rows={t.por_color.map((c) => ({ key: c.color, value: c.unidades }))} empty="Sin traspasos." />
          </div>
        </div>
      </Card>

      <Card title="Devoluciones y cambios" note="Una devolución no es una anulación de venta. Un cambio registra por separado lo devuelto y el reemplazo.">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Devoluciones" value={d.devoluciones} hint={d.periodo_anterior ? `Periodo anterior: ${d.periodo_anterior.devoluciones}` : undefined} />
          <Stat label="Cambios" value={d.cambios} hint={d.periodo_anterior ? `Periodo anterior: ${d.periodo_anterior.cambios}` : undefined} />
          <Stat label="Anulaciones" value={d.anulaciones} />
          <Stat label="Unidades devueltas" value={d.unidades_devueltas} hint={d.periodo_anterior ? `Anterior: ${d.periodo_anterior.unidades_devueltas}` : undefined} />
          <Stat label="Unidades cambiadas" value={d.unidades_cambiadas} hint={d.periodo_anterior ? `Anterior: ${d.periodo_anterior.unidades_cambiadas}` : undefined} />
          <Stat label="Reemplazos entregados" value={d.unidades_entregadas_por_cambio} />
          <Stat label="Motivos de talla" value={d.motivos_de_talla} hint="Talla incorrecta" />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium text-gray-700">Motivos</h3>
            <Bars rows={d.por_motivo.map((r) => ({ key: r.etiqueta, value: r.devoluciones + r.cambios + r.anulaciones, detail: `${r.devoluciones} devoluciones · ${r.cambios} cambios · ${r.anulaciones} anulaciones` }))} empty="Sin devoluciones ni cambios." />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-gray-700">Modelos más devueltos</h3>
            <Bars rows={d.modelos_mas_devueltos.map((r) => ({ key: r.producto, value: r.unidades, detail: `${r.operaciones} operaciones` }))} empty="Sin devoluciones ni cambios." />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-gray-700">Por sucursal</h3>
            <Bars rows={d.por_sucursal.map((r) => ({ key: r.sucursal ?? "—", value: r.devoluciones + r.cambios + r.anulaciones, detail: `${r.devoluciones} dev. · ${r.cambios} cambios · ${r.anulaciones} anul.` }))} empty="Sin datos." />
          </div>
          {d.por_usuario && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-gray-700">Por responsable</h3>
              <Bars rows={d.por_usuario.map((r) => ({ key: r.usuario, value: r.operaciones }))} empty="Sin datos." />
            </div>
          )}
        </div>
      </Card>

      <Card title="Movimientos de inventario" note={data.definiciones.movimientos}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Unidades ingresadas" value={m.unidades_ingresadas} />
          <Stat label="Unidades vendidas" value={m.unidades_vendidas} />
          <Stat label="Cambios: entran / salen" value={`${m.cambio_unidades_entrantes} / ${m.cambio_unidades_salientes}`} />
          <Stat label="Devueltas al stock" value={m.unidades_devueltas_al_stock} hint={`Dañadas: ${m.unidades_en_cuarentena}`} />
          <Stat label="Salidas autorizadas" value={m.salidas_autorizadas} />
          <Stat label="Traspasos: salen / entran" value={`${m.traspaso_unidades_salidas} / ${m.traspaso_unidades_entradas}`} hint="Solo redistribuye el stock" />
          <Stat label="Ajustes (+ / −)" value={`${m.ajustes_positivos} / ${m.ajustes_negativos}`} />
        </div>
        <div className="mt-4">
          <Bars rows={m.por_categoria.map((c) => ({ key: c.etiqueta, value: c.movimientos, detail: `${c.unidades} unidades` }))} />
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- modelos

const CsvButton = ({ onClick }: { onClick: () => void }) => (
  <button type="button" onClick={onClick} className="mt-3 min-h-11 rounded-lg border border-gray-200 px-4 text-sm font-medium text-gray-700 hover:border-black">
    Descargar CSV
  </button>
);

function ModelosView({ data, desde, hasta }: { data: ModelReport; desde?: string; hasta?: string }) {
  const t = data.totales;
  const exportCsv = () =>
    downloadCsv(
      csvFileName("modelos mas vendidos", desde, hasta),
      toCsv(
        ["Posición", "Modelo", "Unidades vendidas", "Ventas distintas", "Ingresos (Bs)", "Devueltas o cambiadas", "Unidades netas", "Por talla", "Por color", "Por sucursal"],
        data.modelos.map((m, i) => [
          i + 1,
          m.producto,
          m.unidades,
          m.ventas,
          m.ingresos,
          m.devueltas,
          m.netas,
          m.por_talla.map((x) => `${x.talla}: ${x.unidades}`).join("; "),
          m.por_color.map((x) => `${x.color}: ${x.unidades}`).join("; "),
          m.por_sucursal.map((x) => `${x.sucursal}: ${x.unidades}`).join("; "),
        ]),
      ),
    );
  return (
    <div className="space-y-4">
      <Card title="Modelos más vendidos" note={data.definiciones.unidades}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Ventas con estos modelos" value={t.ventas} />
          <Stat label="Unidades vendidas" value={t.unidades} />
          <Stat label="Ingresos de líneas" value={money(t.ingresos)} />
          <Stat label="Unidades devueltas" value={t.unidades_devueltas} hint="Aparte, por fecha de la operación" />
          <Stat label="Unidades netas" value={t.unidades_netas} hint="vendidas − devueltas" />
        </div>
        {data.modelos.length > 0 && <CsvButton onClick={exportCsv} />}
      </Card>

      {data.modelos.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 p-6 text-sm text-gray-500">No hay ventas con estos filtros.</p>
      ) : (
        data.modelos.map((m, i) => (
          <Card key={m.producto_id} title={`${i + 1}. ${m.producto}`}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="Unidades vendidas" value={m.unidades} />
              <Stat label="Ventas distintas" value={m.ventas} />
              <Stat label="Ingresos" value={money(m.ingresos)} />
              <Stat label="Devueltas / cambiadas" value={m.devueltas} hint={m.cambios_entregados ? `${m.cambios_entregados} reemplazos entregados` : undefined} />
              <Stat label="Netas" value={m.netas} />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-medium text-gray-700">Por talla</h3>
                <Bars rows={m.por_talla.map((s) => ({ key: s.talla, value: s.unidades }))} />
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium text-gray-700">Por color</h3>
                <Bars rows={m.por_color.map((c) => ({ key: c.color, value: c.unidades }))} />
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium text-gray-700">Por sucursal</h3>
                <Bars rows={m.por_sucursal.map((s) => ({ key: s.sucursal, value: s.unidades, detail: `${s.ventas} ventas · ${money(s.ingresos)}` }))} />
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium text-gray-700">Tendencia ({data.filtros.granularidad === "dia" ? "por día" : "por mes"})</h3>
                <Bars rows={m.tendencia.map((x) => ({ key: x.clave, value: x.unidades }))} />
              </div>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------- envíos

function EnviosView({ data, showHistory, desde, hasta }: { data: ShippingReport; showHistory: boolean; desde?: string; hasta?: string }) {
  const r = data.respuestas;
  const exportCsv = () =>
    downloadCsv(
      csvFileName("envios por departamento", desde, hasta),
      toCsv(
        ["Posición", "Departamento", "Pedidos", "Unidades enviadas", "Venta bruta (Bs)", "Promedio por pedido (Bs)", "Valor devuelto (Bs)", "Valor entregado en cambios (Bs)", "Venta neta (Bs)", "Por sucursal", "Estado"],
        data.departamentos.map((d) => [
          d.posicion,
          d.departamento,
          d.pedidos,
          d.unidades,
          d.ingresos_brutos,
          d.ticket_promedio,
          d.devuelto,
          d.entregado,
          d.ingresos_netos,
          d.por_sucursal.map((x) => `${x.sucursal}: ${x.pedidos}`).join("; "),
          d.reconocido ? "" : "Por revisar",
        ]),
      ),
    );
  return (
    <div className="space-y-4">
      <Card title="Pedidos con envío por departamento" note={data.definiciones.pedido}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Departamento con más pedidos" value={r.mas_pedidos ? `${r.mas_pedidos.departamento} (${r.mas_pedidos.valor})` : "—"} />
          <Stat label="Más unidades enviadas" value={r.mas_unidades ? `${r.mas_unidades.departamento} (${r.mas_unidades.valor})` : "—"} />
          <Stat label="Mayor venta con envío" value={r.mas_ingresos ? `${r.mas_ingresos.departamento} (${money(r.mas_ingresos.valor)})` : "—"} />
          <Stat label="Pedidos a La Paz" value={r.la_paz} />
          <Stat label="Pedidos a Oruro" value={r.oruro} />
          <Stat label="Total de pedidos" value={data.totales.pedidos} />
          <Stat label="Unidades enviadas" value={data.totales.unidades} />
          <Stat label="Valor promedio por pedido" value={data.totales.ticket_promedio === null ? "—" : money(data.totales.ticket_promedio)} />
          <Stat label="Ventas sin envío (excluidas)" value={data.totales.ventas_sin_envio_excluidas} hint="Entrega directa" />
        </div>
        <CsvButton onClick={exportCsv} />
      </Card>

      <Card title="Ranking de departamentos" note="El departamento es el destino guardado en cada pedido, no la sucursal que vendió.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="py-2 pr-3">#</th>
                <th className="py-2 pr-3">Departamento</th>
                <th className="py-2 pr-3 text-right">Pedidos</th>
                <th className="py-2 pr-3 text-right">Unidades</th>
                <th className="py-2 pr-3 text-right">Venta bruta</th>
                <th className="py-2 pr-3 text-right">Promedio por pedido</th>
                <th className="py-2 pr-3 text-right">Venta neta</th>
                {showHistory && <th className="py-2 text-right">Lugar histórico</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.departamentos.map((d) => (
                <tr key={d.departamento} className={d.pedidos === 0 ? "text-gray-400" : ""}>
                  <td className="py-2 pr-3">{d.posicion}</td>
                  <td className="py-2 pr-3 font-medium">
                    {d.departamento}
                    {!d.reconocido && <span className="ml-2 rounded-full bg-yellow-50 px-2 py-0.5 text-xs text-yellow-800">Por revisar</span>}
                    {d.por_sucursal.length > 0 && (
                      <span className="block text-xs font-normal text-gray-500">{d.por_sucursal.map((s) => `${s.sucursal}: ${s.pedidos}`).join(" · ")}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right font-semibold">{d.pedidos}</td>
                  <td className="py-2 pr-3 text-right">{d.unidades}</td>
                  <td className="py-2 pr-3 text-right">{money(d.ingresos_brutos)}</td>
                  <td className="py-2 pr-3 text-right">{d.ticket_promedio === null ? "—" : money(d.ticket_promedio)}</td>
                  <td className="py-2 pr-3 text-right">{money(d.ingresos_netos)}</td>
                  {showHistory && <td className="py-2 text-right">{d.posicion_historica ?? "—"} ({d.pedidos_historicos})</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.sin_reconocer.length > 0 && (
          <p className="mt-3 text-xs text-yellow-800">
            Destinos que no coinciden con un departamento oficial (se conservan para revisión): {data.sin_reconocer.map((x) => `${x.valor} (${x.pedidos})`).join(", ")}.
          </p>
        )}
      </Card>

      <Card title="Pedidos por departamento">
        <Bars rows={data.departamentos.filter((d) => d.pedidos > 0).map((d) => ({ key: d.departamento, value: d.pedidos, detail: `${d.unidades} unidades` }))} empty="No hay pedidos con envío en este periodo." />
      </Card>
    </div>
  );
}

export default Analisis;
