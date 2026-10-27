import { useEffect, useRef, useState } from "react";
import { LogOut, Menu, X } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";

import { useAuth } from "../../context/useAuth";
import { useSucursal } from "../../context/useSucursal";
import { isActivePath, visibleNav } from "./navigation";
import { branchLabel } from "../../lib/ubicaciones";

const TAB =
  "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium leading-tight transition-colors";

/**
 * Navegación del teléfono (<768 px): barra inferior fija con las secciones principales y un panel
 * "Más" con el resto, el usuario y Cerrar sesión. Respeta el área segura inferior del dispositivo.
 * El contenido reserva su espacio (padding inferior en <main>), así que nunca queda tapado.
 */
function MobileNav() {
  const { user, logout } = useAuth();
  const { selected } = useSucursal();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(pathname);
  const sheetRef = useRef<HTMLDivElement>(null);
  const isAdmin = user?.rol === "admin";

  const items = visibleNav(isAdmin);
  const primary = items.filter((i) => i.primary);
  const secondary = items.filter((i) => !i.primary);
  const moreActive = secondary.some((i) => isActivePath(i, pathname));

  // Al navegar a otra ruta, el panel se cierra (se ajusta durante el render, sin efecto).
  if (open && pathname !== openedAt) setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    // Bloquea el desplazamiento del fondo mientras el panel está abierto.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheetRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      <nav
        aria-label="Menú principal"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden print:hidden"
      >
        <div className="mx-auto flex max-w-xl items-stretch">
          {primary.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === "/"}
                className={({ isActive }) => `${TAB} ${isActive ? "text-black" : "text-gray-500"}`}
              >
                {({ isActive }) => (
                  <>
                    <span className={`flex h-7 w-12 items-center justify-center rounded-full ${isActive ? "bg-black text-white" : ""}`}>
                      <Icon size={19} strokeWidth={isActive ? 2.2 : 1.8} />
                    </span>
                    <span className={isActive ? "font-semibold" : ""}>{item.short}</span>
                  </>
                )}
              </NavLink>
            );
          })}
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => {
              setOpenedAt(pathname);
              setOpen(true);
            }}
            className={`${TAB} ${moreActive ? "text-black" : "text-gray-500"}`}
          >
            <span className={`flex h-7 w-12 items-center justify-center rounded-full ${moreActive ? "bg-black text-white" : ""}`}>
              <Menu size={19} strokeWidth={moreActive ? 2.2 : 1.8} />
            </span>
            <span className={moreActive ? "font-semibold" : ""}>Más</span>
          </button>
        </div>
      </nav>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden print:hidden" role="dialog" aria-modal="true" aria-label="Más opciones">
          <button type="button" aria-label="Cerrar menú" className="absolute inset-0 h-full w-full bg-black/40" onClick={() => setOpen(false)} />
          <div
            ref={sheetRef}
            className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-white px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-black">{user?.nombre}</p>
                <p className="truncate text-xs text-gray-500">
                  {isAdmin ? "Administrador" : "Vendedor"}
                  {selected ? ` · ${branchLabel(selected)}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Cerrar"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100"
              >
                <X size={20} />
              </button>
            </div>

            <ul className="space-y-1">
              {secondary.map((item) => {
                const Icon = item.icon;
                const active = isActivePath(item, pathname);
                return (
                  <li key={item.path}>
                    <NavLink
                      to={item.path}
                      onClick={() => setOpen(false)}
                      className={`flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium ${
                        active ? "bg-black text-white" : "text-gray-800 hover:bg-gray-100"
                      }`}
                    >
                      <Icon size={20} strokeWidth={1.8} />
                      {item.label}
                    </NavLink>
                  </li>
                );
              })}
            </ul>

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void logout();
              }}
              className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-gray-300 text-sm font-medium text-gray-800 hover:border-black"
            >
              <LogOut size={18} /> Cerrar sesión
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default MobileNav;
