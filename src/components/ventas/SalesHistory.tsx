import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, ChevronDown, ChevronUp, Printer } from "lucide-react";

import {
  MODE_LABELS,
  PAYMENT_LABELS,
  cancelSale,
  formatDestination,
  getSaleDetails,
  getSalesHistory,
  type Sale,
  type SaleHistoryPage,
  type SaleHistoryRow,
} from "../../services/sales.service";
import { listUsers, type UserRow } from "../../services/users.service";
import FiltrosVentas from "./FiltrosVentas";
import { FILTROS_VACIOS, aFiltrosServidor, filtrosActivos, type VentasFiltrosState } from "../../lib/ventasFiltros";
import { hoyBolivia } from "../../lib/periodos";
import type { Branch } from "../../services/branches.service";
import { useAuth } from "../../context/useAuth";
import ComandaPrint, { type ComandaLine } from "./ComandaPrint";
import { formatBoliviaDateTime, saleNumber } from "../../lib/receipt";

interface Names {
  products: { id: number; nombre: string }[];
  sizes: { id: number; nombre: string }[];
  colors: { id: number; nombre: string }[];
}

const PAGE_SIZE = 10;

interface SalesHistoryProps extends Names {
  branches: Branch[];
  sucursalId: number | null;
  /** cambia cuando se registra una venta, para recargar */
  refreshToken: number;
  /** se llama tras cancelar (el stock cambió) */
  onChanged: () => void;
}

function SalesHistory({
  branches,
  sucursalId,
  refreshToken,
  onChanged,
  products,
  sizes,
  colors,
}: SalesHistoryProps) {
  const { user } = useAuth();
  const isAdmin = user?.rol === "admin";
  const [sales, setSales] = useState<SaleHistoryRow[]>([]);
  const [filtros, setFiltros] = useState<VentasFiltrosState>(() => FILTROS_VACIOS(hoyBolivia()));
  const [pagina, setPagina] = useState(1);
  const [total, setTotal] = useState(0);
  const [totales, setTotales] = useState<SaleHistoryPage["totales"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [lines, setLines] = useState<Record<number, ComandaLine[]>>({});
  const [printing, setPrinting] = useState<{
    sale: Sale;
    lines: ComandaLine[];
  } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const converted = useMemo(
    () => aFiltrosServidor(filtros, { hoy: hoyBolivia(), isAdmin, userBranchId: user?.sucursal_id ?? null, menuBranchId: sucursalId }),
    [filtros, isAdmin, user?.sucursal_id, sucursalId],
  );

  // Todos los filtros viajan al servidor: la consulta, la paginación y los totales se calculan allí.
  const load = useCallback(async () => {
    if (converted.error) return;
    try {
      setError("");
      setLoading(true);
      const page = await getSalesHistory({ ...converted.filtros, pagina, limite: PAGE_SIZE });
      setSales(page.filas);
      setTotal(page.total);
      setTotales(page.totales);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las ventas.");
    } finally {
      setLoading(false);
    }
  }, [converted, pagina]);

  useEffect(() => {
    // Recarga al cambiar filtros, página o sucursal, o al registrar una venta.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshToken]);

  useEffect(() => {
    if (!isAdmin) return;
    void listUsers().then(setUsers).catch(() => undefined);
  }, [isAdmin]);

  const changeFilters = (patch: Partial<VentasFiltrosState>) => {
    setFiltros((current) => ({ ...current, ...patch }));
    setPagina(1);
  };
  const resetFilters = () => {
    setFiltros(FILTROS_VACIOS(hoyBolivia()));
    setPagina(1);
  };
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const nameOf = (list: { id: number; nombre: string }[], id: number) =>
    list.find((item) => item.id === id)?.nombre ?? "—";

  async function fetchLines(sale: Sale): Promise<ComandaLine[]> {
    const cached = lines[sale.id];
    if (cached) return cached;

    const details = await getSaleDetails(sale.id);
    const built = details.map((detail) => ({
      ...detail,
      producto_nombre: nameOf(products, detail.producto_id),
      talla_nombre: nameOf(sizes, detail.talla_id),
      color_nombre: nameOf(colors, detail.color_id),
    }));
    setLines((current) => ({ ...current, [sale.id]: built }));
    return built;
  }

  async function toggle(sale: Sale) {
    if (openId === sale.id) {
      setOpenId(null);
      return;
    }

    try {
      await fetchLines(sale);
      setOpenId(sale.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar el detalle.");
    }
  }

  async function handlePrint(sale: Sale) {
    try {
      setPrinting({ sale, lines: await fetchLines(sale) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al preparar la comanda.");
    }
  }

  async function handleCancel(sale: Sale) {
    const reason = window.prompt(
      `Cancelar la venta ${saleNumber(sale.id)} completa (todas sus líneas). Se repondrá el stock. Motivo:`,
    );
    if (reason === null) return;

    try {
      setBusyId(sale.id);
      await cancelSale(sale.id, reason);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cancelar.");
    } finally {
      setBusyId(null);
    }
  }

  const branchName = (id: number) =>
    branches.find((branch) => branch.id === id)?.nombre ?? "";

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-200 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-black">Ventas recientes</h2>
        <p className="mt-1 text-sm text-gray-500">
          Una fila por venta, con todas sus líneas. Detalle, destino, comanda y cancelación.
        </p>
      </div>

      <FiltrosVentas
        value={filtros}
        onChange={changeFilters}
        onReset={resetFilters}
        isAdmin={isAdmin}
        branches={branches}
        products={products}
        sizes={sizes}
        colors={colors}
        users={users}
        periodError={converted.error}
      />

      {totales && !converted.error && (
        <p className="border-b border-gray-100 px-4 py-3 text-xs text-gray-600 sm:px-6" aria-live="polite">
          {total} {total === 1 ? "venta" : "ventas"} encontradas · {totales.ventas} completadas · {totales.unidades} unidades · Bs {totales.ingresos.toFixed(2)}
          {totales.base === "lineas" ? " (solo las líneas que coinciden con el modelo, talla o color elegidos)" : ""}
        </p>
      )}

      {error && (
        <p className="m-4 rounded-lg border sm:m-6 border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="divide-y divide-gray-100">
        {loading && sales.length === 0 && <p className="p-4 text-sm text-gray-500 sm:p-6">Cargando ventas…</p>}
        {!loading && sales.length === 0 && (
          <div className="p-4 text-sm text-gray-500 sm:p-6">
            {filtrosActivos(filtros) > 0 ? (
              <>
                <p>No hay ventas que cumplan todos los filtros elegidos.</p>
                <button type="button" onClick={resetFilters} className="mt-2 min-h-11 rounded-lg border border-gray-200 px-4 font-medium text-gray-700 hover:border-black">
                  Limpiar filtros
                </button>
              </>
            ) : (
              <p>Aún no hay ventas.</p>
            )}
          </div>
        )}

        {sales.map((sale) => (
          <div key={sale.id} className="p-4 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-black">
                  Venta {saleNumber(sale.id)}{sale.cliente_nombre ? ` · ${sale.cliente_nombre}` : ""}{" "}
                  {sale.estado === "cancelada" && (
                    <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">
                      Cancelada
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500">
                  {formatBoliviaDateTime(sale.fecha)} ·{" "}
                  {branchName(sale.sucursal_id)} ·{" "}
                  {sale.metodo_pago ? PAYMENT_LABELS[sale.metodo_pago] : "Pago sin registrar"} ·{" "}
                  {sale.modalidad ? MODE_LABELS[sale.modalidad] : "Sin modalidad"}
                </p>
              </div>

              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
                <span className="mr-auto text-sm font-semibold text-black sm:mr-2">
                  Bs {sale.total.toFixed(2)}
                </span>

                <button
                  type="button"
                  onClick={() => void handlePrint(sale)}
                  className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-black sm:min-h-9"
                >
                  <Printer size={14} /> Comanda
                </button>

                {sale.estado === "completada" && isAdmin && (
                  <button
                    type="button"
                    disabled={busyId === sale.id}
                    onClick={() => void handleCancel(sale)}
                    className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:border-red-600 disabled:opacity-50 sm:min-h-9"
                  >
                    <Ban size={14} /> Cancelar
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void toggle(sale)}
                  aria-label={openId === sale.id ? "Ocultar detalle" : "Ver detalle"}
                  aria-expanded={openId === sale.id}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 sm:h-9 sm:w-9"
                >
                  {openId === sale.id ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </button>
              </div>
            </div>

            {openId === sale.id && (
              <div className="mt-3 space-y-2 rounded-lg bg-gray-50 p-3 text-sm sm:p-4">
                <p>
                  <b>Destino:</b> {formatDestination(sale)}
                </p>
                {(sale.cliente_nombre || sale.cliente_telefono) && (
                  <p>
                    <b>Cliente:</b> {sale.cliente_nombre} {sale.cliente_telefono}
                  </p>
                )}
                {sale.referencias && (
                  <p>
                    <b>Referencias:</b> {sale.referencias}
                  </p>
                )}
                {sale.estado === "cancelada" && (
                  <p className="text-red-700">
                    <b>Motivo de cancelación:</b> {sale.motivo_cancelacion}
                  </p>
                )}
                <ul className="mt-2 divide-y divide-gray-200">
                  {(lines[sale.id] ?? []).map((line) => (
                    <li key={line.id} className="flex justify-between gap-3 py-1.5">
                      <span className="min-w-0">
                        {line.producto_nombre} · {line.talla_nombre} · {line.color_nombre} ·{" "}
                        {line.cantidad} × Bs {line.precio_unitario.toFixed(2)}
                      </span>
                      <span className="shrink-0 font-medium">Bs {line.subtotal.toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-gray-200 p-4 text-sm">
        <button type="button" disabled={pagina <= 1 || loading} onClick={() => setPagina((p) => p - 1)} className="min-h-11 rounded-lg border border-gray-200 px-4 font-medium hover:border-black disabled:opacity-40">
          Anterior
        </button>
        <span className="text-center text-gray-600">Página {pagina} de {pages}</span>
        <button type="button" disabled={pagina >= pages || loading} onClick={() => setPagina((p) => p + 1)} className="min-h-11 rounded-lg border border-gray-200 px-4 font-medium hover:border-black disabled:opacity-40">
          Siguiente
        </button>
      </div>

      {printing && (
        <ComandaPrint
          sale={printing.sale}
          lines={printing.lines}
          branchName={branchName(printing.sale.sucursal_id)}
          onDone={() => setPrinting(null)}
        />
      )}
    </section>
  );
}

export default SalesHistory;
