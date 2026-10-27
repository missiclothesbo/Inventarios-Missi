import {
  BarChart3,
  Boxes,
  CircleDollarSign,
  LoaderCircle,
  PackagePlus,
  RefreshCw,
  ShoppingCart,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useSucursal } from "../../context/useSucursal";
import { Link } from "react-router-dom";

import {
  getDashboardData,
  type DashboardData,
} from "../../services/dashboard.service";
import { formatBoliviaDateTime } from "../../lib/receipt";

function formatCurrency(value: number) {
  return `Bs ${value.toLocaleString("es-BO", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function Dashboard() {
  const { selectedId } = useSucursal();
  const organizacion = "todas las ubicaciones";
  const [data, setData] = useState<DashboardData | null>(
    null,
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadDashboard = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const result = await getDashboardData(selectedId);

      setData(result);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "No se pudo cargar el dashboard.";

      setError(message);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    // La carga inicial consulta los datos actuales de la API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDashboard();
  }, [loadDashboard]);

  function handleReload() {
    void loadDashboard();
  }

  return (
    <section className="space-y-5 sm:space-y-8">
      {/* ENCABEZADO */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">
            Panel principal
          </p>

          <h1 className="mt-1 text-xl font-semibold text-black sm:text-2xl">
            Dashboard
          </h1>

          <p className="mt-1 text-sm text-gray-500">
            Resumen general del inventario y las ventas.
          </p>
        </div>

        <button
          type="button"
          onClick={handleReload}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-black px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800"
        >
          <RefreshCw size={17} />
          Actualizar
        </button>
      </div>

      {/* ERROR */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-semibold text-red-800">
            No se pudo cargar el Dashboard
          </p>

          <p className="mt-1 text-sm text-red-700">
            {error}
          </p>

          <button
            type="button"
            onClick={handleReload}
            className="mt-3 rounded-lg bg-red-700 px-3 py-2 text-sm font-medium text-white hover:bg-red-800"
          >
            Recargar página
          </button>
        </div>
      )}

      {/* LOADING */}
      {loading && !data ? (
        <div className="flex min-h-80 items-center justify-center rounded-xl border border-gray-200 bg-white">
          <div className="flex flex-col items-center gap-3 text-gray-500">
            <LoaderCircle
              size={28}
              className="animate-spin"
            />

            <p className="text-sm">
              Cargando información...
            </p>
          </div>
        </div>
      ) : data ? (
        <>
          {/* ESTADÍSTICAS */}
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            {/* STOCK */}
            <Link
              to="/inventario"
              className="min-w-0 rounded-xl border border-gray-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-sm sm:p-5"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">
                    {selectedId === null ? `Stock de ${organizacion}` : "Stock de la sucursal"}
                  </p>

                  <p className="mt-1 text-xl font-semibold text-black sm:mt-2 sm:text-2xl">
                    {data.stats.totalStock}
                  </p>

                  <p className="mt-1 text-xs text-gray-400">
                    Unidades disponibles
                  </p>
                </div>

                <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gray-100 sm:flex">
                  <Boxes
                    size={20}
                    className="text-gray-700"
                  />
                </div>
              </div>
            </Link>

            {/* PRODUCTOS */}
            <Link
              to="/inventario"
              className="min-w-0 rounded-xl border border-gray-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-sm sm:p-5"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">
                    Productos
                  </p>

                  <p className="mt-1 text-xl font-semibold text-black sm:mt-2 sm:text-2xl">
                    {data.stats.totalProducts}
                  </p>

                  <p className="mt-1 text-xs text-gray-400">
                    Productos activos
                  </p>
                </div>

                <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gray-100 sm:flex">
                  <PackagePlus
                    size={20}
                    className="text-gray-700"
                  />
                </div>
              </div>
            </Link>

            {/* VENTAS */}
            <Link
              to="/ventas"
              className="min-w-0 rounded-xl border border-gray-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-sm sm:p-5"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">
                    Ventas de hoy
                  </p>

                  <p className="mt-1 text-xl font-semibold text-black sm:mt-2 sm:text-2xl">
                    {data.stats.salesToday}
                  </p>

                  <p className="mt-1 text-xs text-gray-400">
                    Ventas registradas hoy
                  </p>
                </div>

                <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gray-100 sm:flex">
                  <ShoppingCart
                    size={20}
                    className="text-gray-700"
                  />
                </div>
              </div>
            </Link>

            {/* INGRESOS */}
            <Link
              to="/reportes"
              className="min-w-0 rounded-xl border border-gray-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-sm sm:p-5"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">
                    Ingresos de hoy
                  </p>

                  <p className="mt-1 text-xl font-semibold text-black sm:mt-2 sm:text-2xl">
                    {formatCurrency(
                      data.stats.incomeToday,
                    )}
                  </p>

                  <p className="mt-1 text-xs text-gray-400">
                    Total vendido hoy
                  </p>
                </div>

                <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gray-100 sm:flex">
                  <CircleDollarSign
                    size={20}
                    className="text-gray-700"
                  />
                </div>
              </div>
            </Link>
          </div>

          {/* ACCIONES RÁPIDAS */}
          <div>
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-gray-900">
                Acciones rápidas
              </h2>

              <p className="mt-1 text-sm text-gray-500">
                Accede rápidamente a las funciones principales
                del sistema.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
              {/* REGISTRAR VENTA */}
              <Link
                to="/ventas"
                className="group min-w-0 rounded-xl border border-gray-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md sm:p-5"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-gray-100 transition group-hover:bg-gray-200">
                  <ShoppingCart
                    size={21}
                    className="text-gray-700"
                  />
                </div>

                <h3 className="mt-3 text-sm font-semibold text-gray-900 sm:mt-4">
                  Registrar venta
                </h3>

                <p className="mt-1 text-sm text-gray-500">
                  Registrar una nueva venta y actualizar el
                  stock.
                </p>
              </Link>

              {/* CONSULTAR INVENTARIO */}
              <Link
                to="/inventario"
                className="group min-w-0 rounded-xl border border-gray-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md sm:p-5"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-gray-100 transition group-hover:bg-gray-200">
                  <Boxes
                    size={21}
                    className="text-gray-700"
                  />
                </div>

                <h3 className="mt-3 text-sm font-semibold text-gray-900 sm:mt-4">
                  Consultar inventario
                </h3>

                <p className="mt-1 text-sm text-gray-500">
                  Revisar productos, tallas, colores y stock
                  disponible.
                </p>
              </Link>

              {/* AGREGAR PRODUCTO */}
              <Link
                to="/inventario?accion=agregar"
                className="group min-w-0 rounded-xl border border-gray-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md sm:p-5"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-gray-100 transition group-hover:bg-gray-200">
                  <PackagePlus
                    size={21}
                    className="text-gray-700"
                  />
                </div>

                <h3 className="mt-3 text-sm font-semibold text-gray-900 sm:mt-4">
                  Agregar producto
                </h3>

                <p className="mt-1 text-sm text-gray-500">
                  Registra un producto nuevo con sus tallas,
                  colores y cantidades.
                </p>
              </Link>

              {/* REPORTES */}
              <Link
                to="/reportes"
                className="group min-w-0 rounded-xl border border-gray-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md sm:p-5"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-gray-100 transition group-hover:bg-gray-200">
                  <BarChart3
                    size={21}
                    className="text-gray-700"
                  />
                </div>

                <h3 className="mt-3 text-sm font-semibold text-gray-900 sm:mt-4">
                  Ver reportes
                </h3>

                <p className="mt-1 text-sm text-gray-500">
                  Consultar ventas, ingresos y productos más
                  vendidos.
                </p>
              </Link>
            </div>
          </div>

          {/* CONTENIDO INFERIOR */}
          <div className="grid grid-cols-1 gap-4 sm:gap-6 xl:grid-cols-2">
            {/* VENTAS RECIENTES */}
            <div className="rounded-xl border border-gray-200 bg-white">
              <div className="border-b border-gray-200 px-4 py-3 sm:px-5 sm:py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold text-gray-900">
                      Ventas recientes
                    </h2>

                    <p className="mt-1 text-xs text-gray-500">
                      Últimas ventas registradas.
                    </p>
                  </div>

                  <Link
                    to="/ventas"
                    className="-my-2 inline-flex min-h-11 shrink-0 items-center text-xs font-medium text-gray-600 hover:text-black"
                  >
                    Ver todas
                  </Link>
                </div>
              </div>

              {data.recentSales.length === 0 ? (
                <div className="px-5 py-10 text-center">
                  <ShoppingCart
                    size={28}
                    className="mx-auto mb-3 text-gray-300"
                  />

                  <p className="text-sm text-gray-500">
                    Todavía no hay ventas registradas.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {data.recentSales.map((sale) => (
                    <div
                      key={sale.id}
                      className="flex items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-5 sm:py-4"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          Venta #{sale.id}
                        </p>

                        <p className="mt-1 text-xs text-gray-500">
                          {formatBoliviaDateTime(sale.fecha)}
                        </p>
                      </div>

                      <p className="text-sm font-semibold text-gray-900">
                        {formatCurrency(sale.total)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* STOCK BAJO */}
            <div className="rounded-xl border border-gray-200 bg-white">
              <div className="border-b border-gray-200 px-4 py-3 sm:px-5 sm:py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold text-gray-900">
                      Stock bajo
                    </h2>

                    <p className="mt-1 text-xs text-gray-500">
                      Productos con 3 unidades o menos.
                    </p>
                  </div>

                  <Link
                    to="/inventario"
                    className="-my-2 inline-flex min-h-11 shrink-0 items-center text-xs font-medium text-gray-600 hover:text-black"
                  >
                    Ver inventario
                  </Link>
                </div>
              </div>

              {data.lowStockItems.length === 0 ? (
                <div className="px-5 py-10 text-center">
                  <Boxes
                    size={28}
                    className="mx-auto mb-3 text-gray-300"
                  />

                  <p className="text-sm text-gray-500">
                    No hay productos con stock bajo.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {data.lowStockItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-5 sm:py-4"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900">
                          {item.producto}
                        </p>

                        <p className="mt-1 text-xs text-gray-500">
                          Talla {item.talla} · {item.color}
                        </p>
                      </div>

                      <span className="shrink-0 rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">
                        {item.cantidad}{" "}
                        {item.cantidad === 1
                          ? "unidad"
                          : "unidades"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

export default Dashboard;