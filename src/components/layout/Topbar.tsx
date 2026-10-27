import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  Boxes,
  LayoutDashboard,
  RotateCcw,
  Search,
  ShoppingCart,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../context/useAuth";
import { useSucursal } from "../../context/useSucursal";
import { MQ, useMediaQuery } from "../../lib/useMediaQuery";
import {
  getProducts,
  type Product,
} from "../../services/product.service";
import BranchSelect from "./BranchSelect";

const SECTIONS = [
  { label: "Dashboard", keywords: ["dashboard", "inicio", "principal"], path: "/", icon: LayoutDashboard },
  { label: "Inventario", keywords: ["inventario", "stock", "productos"], path: "/inventario", icon: Boxes },
  { label: "Ventas", keywords: ["ventas", "venta", "vender"], path: "/ventas", icon: ShoppingCart },
  { label: "Traspasos", keywords: ["traspasos", "traspaso", "envios"], path: "/traspasos", icon: ArrowLeftRight },
  { label: "Cambios y devoluciones", keywords: ["cambios", "devoluciones", "anular"], path: "/cambios", icon: RotateCcw },
  { label: "Reportes", keywords: ["reportes", "reporte", "informes"], path: "/reportes", icon: BarChart3 },
  { label: "Usuarios", keywords: ["usuarios", "cuentas", "vendedores"], path: "/usuarios", icon: Users, adminOnly: true },
];

/** Buscador de productos y secciones (en el móvil se monta solo al abrirlo). */
function GlobalSearch({ autoFocus = false, onDone }: { autoFocus?: boolean; onDone?: () => void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const searchRef = useRef<HTMLDivElement>(null);

  const [search, setSearch] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadProducts() {
      try {
        setLoading(true);
        const data = await getProducts();
        if (!cancelled) setProducts(data);
      } catch (error) {
        console.error("Error al cargar productos para el buscador:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadProducts();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const normalizedSearch = search.trim().toLowerCase();

  const filteredProducts =
    normalizedSearch.length > 0
      ? products.filter((product) => product.nombre.toLowerCase().includes(normalizedSearch)).slice(0, 6)
      : [];

  const filteredSections =
    normalizedSearch.length > 0
      ? SECTIONS.filter(
          (section) =>
            (!section.adminOnly || user?.rol === "admin") &&
            section.keywords.some((keyword) => keyword.includes(normalizedSearch)),
        )
      : [];

  const hasResults = filteredProducts.length > 0 || filteredSections.length > 0;

  function clearSearch() {
    setSearch("");
    setShowResults(false);
  }

  function goToProduct(product: Product) {
    navigate(`/inventario?buscar=${encodeURIComponent(product.nombre)}`);
    clearSearch();
    onDone?.();
  }

  function goToSection(path: string) {
    navigate(path);
    clearSearch();
    onDone?.();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (filteredProducts.length > 0) {
      goToProduct(filteredProducts[0]);
      return;
    }
    if (filteredSections.length > 0) goToSection(filteredSections[0].path);
  }

  return (
    <div ref={searchRef} className="relative w-full md:max-w-md">
      <form onSubmit={handleSubmit} role="search">
        <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 transition focus-within:border-gray-400 focus-within:bg-white">
          <Search size={18} className="shrink-0 text-gray-400" />

          <input
            type="search"
            enterKeyHint="search"
            autoFocus={autoFocus}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setShowResults(true);
            }}
            onFocus={() => {
              if (search.trim()) setShowResults(true);
            }}
            placeholder="Buscar productos, secciones..."
            className="w-full min-w-0 bg-transparent py-2.5 text-sm text-black outline-none placeholder:text-gray-400"
            aria-label="Buscar en el sistema"
          />

          {search && (
            <button
              type="button"
              onClick={clearSearch}
              className="-m-2 flex h-9 w-9 shrink-0 items-center justify-center rounded text-gray-400 transition hover:bg-gray-200 hover:text-gray-700"
              aria-label="Limpiar búsqueda"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </form>

      {showResults && normalizedSearch && (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[70dvh] overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-xl">
          {loading ? (
            <div className="px-4 py-5 text-sm text-gray-500">Buscando...</div>
          ) : hasResults ? (
            <div className="py-2">
              {filteredSections.length > 0 && (
                <>
                  <p className="px-4 pb-2 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Secciones</p>
                  {filteredSections.map((section) => {
                    const Icon = section.icon;
                    return (
                      <button
                        key={section.path}
                        type="button"
                        onClick={() => goToSection(section.path)}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-gray-50"
                      >
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-100">
                          <Icon size={17} className="text-gray-600" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{section.label}</p>
                          <p className="text-xs text-gray-400">Abrir sección</p>
                        </div>
                      </button>
                    );
                  })}
                </>
              )}

              {filteredProducts.length > 0 && (
                <>
                  <p className="px-4 pb-2 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-400">Productos</p>
                  {filteredProducts.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => goToProduct(product)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-gray-50"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100">
                        <Boxes size={17} className="text-gray-600" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900">{product.nombre}</p>
                        <p className="text-xs text-gray-400">Ver producto en inventario</p>
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>
          ) : (
            <div className="px-4 py-6 text-center">
              <Search size={24} className="mx-auto mb-2 text-gray-300" />
              <p className="text-sm font-medium text-gray-700">No encontramos resultados</p>
              <p className="mt-1 text-xs text-gray-400">Prueba con otro nombre o sección.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Cabecera compacta del teléfono: marca, sucursal y buscador desplegable. */
function MobileHeader() {
  const [searching, setSearching] = useState(false);

  return (
    <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/95 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="flex h-14 items-center gap-2 px-4">
        <p className="shrink-0 text-base font-bold tracking-tight text-black">MISSI</p>
        <div className="min-w-0 flex-1">
          <BranchSelect id="branch-select-mobile" compact />
        </div>
        <button
          type="button"
          onClick={() => setSearching((v) => !v)}
          aria-expanded={searching}
          aria-label={searching ? "Cerrar buscador" : "Buscar"}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
        >
          {searching ? <X size={20} /> : <Search size={20} />}
        </button>
      </div>
      {searching && (
        <div className="px-4 pb-3">
          <GlobalSearch autoFocus onDone={() => setSearching(false)} />
        </div>
      )}
    </header>
  );
}

function Topbar() {
  const { user } = useAuth();
  const { selected } = useSucursal();
  const desktop = useMediaQuery(MQ.md);

  if (!desktop) return <MobileHeader />;

  return (
    <header className="relative flex h-20 items-center justify-between border-b border-gray-200 bg-white px-6">
      <GlobalSearch />

      <div className="ml-6 flex shrink-0 items-center gap-4">
        <button
          type="button"
          className="rounded-lg p-2.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-black"
          aria-label="Notificaciones"
        >
          <Bell size={20} strokeWidth={1.8} />
        </button>

        <div className="flex items-center gap-3 border-l border-gray-200 pl-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black text-sm font-semibold text-white">
            {(user?.nombre.trim()[0] ?? "M").toUpperCase()}
          </div>

          {/* Usuario y alcance reales de la sesión. */}
          <div className="hidden lg:block">
            <p className="max-w-48 truncate text-sm font-medium text-black">{user?.nombre ?? "Missi"}</p>
            <p className="max-w-48 truncate text-xs text-gray-500">
              {user?.rol === "admin" ? "Administrador" : `Vendedor${selected ? ` · ${selected.nombre}` : ""}`}
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}

export default Topbar;
