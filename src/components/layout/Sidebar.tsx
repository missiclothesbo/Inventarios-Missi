import { NavLink } from "react-router-dom";

import { useAuth } from "../../context/useAuth";
import { useSucursal } from "../../context/useSucursal";
import BranchSelect from "./BranchSelect";
import { visibleNav } from "./navigation";

/** Barra lateral para tablet y escritorio (≥768 px). En el móvil se usa MobileNav. */
function Sidebar() {
  const { error } = useSucursal();
  const { user, logout } = useAuth();
  const isAdmin = user?.rol === "admin";

  return (
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-gray-200 bg-white md:flex lg:w-64 print:hidden">
      <div className="flex h-20 items-center border-b border-gray-200 px-5 lg:px-6">
        <div>
          <p className="text-lg font-bold tracking-tight text-black">INVENTARIO MISSI</p>
          <p className="text-xs text-gray-500">Gestión de ventas</p>
        </div>
      </div>

      <div className="border-b border-gray-200 px-5 py-4 lg:px-6">
        <label htmlFor="branch-select" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">
          Sucursal
        </label>
        <BranchSelect id="branch-select" />
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </div>

      <nav aria-label="Menú principal" className="flex-1 overflow-y-auto px-3 py-6">
        <p className="mb-3 px-3 text-xs font-semibold uppercase tracking-wider text-gray-400">Menú</p>

        <div className="space-y-1">
          {visibleNav(isAdmin).map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === "/"}
                className={({ isActive }) =>
                  `flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition-colors ${
                    isActive ? "bg-black text-white" : "text-gray-600 hover:bg-gray-100 hover:text-black"
                  }`
                }
              >
                <Icon size={19} strokeWidth={1.8} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </div>
      </nav>

      <div className="border-t border-gray-200 p-4">
        <p className="text-xs text-gray-400">Inventario Missi</p>
        <p className="mt-1 break-words text-xs text-gray-500">{user ? `${user.nombre} · ${user.rol}` : "Sistema de gestión"}</p>
        {user && (
          <button
            type="button"
            onClick={() => void logout()}
            className="mt-3 min-h-10 w-full rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:border-black"
          >
            Cerrar sesión
          </button>
        )}
      </div>
    </aside>
  );
}

export default Sidebar;
