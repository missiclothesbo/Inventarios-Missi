import {
  ArrowLeftRight,
  BarChart3,
  Boxes,
  History,
  Palette,
  LayoutDashboard,
  RotateCcw,
  ShoppingCart,
  Users,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  /** Etiqueta corta para la barra inferior del móvil. */
  short: string;
  path: string;
  icon: LucideIcon;
  /** Solo administrador (el servidor también lo exige). */
  adminOnly?: boolean;
  /** Aparece directamente en la barra inferior del móvil; el resto va en "Más". */
  primary?: boolean;
}

/** Única lista de secciones: la usan la barra lateral (tablet/escritorio) y la navegación móvil. */
export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", short: "Inicio", path: "/", icon: LayoutDashboard, primary: true },
  { label: "Ventas", short: "Ventas", path: "/ventas", icon: ShoppingCart, primary: true },
  { label: "Inventario", short: "Inventario", path: "/inventario", icon: Boxes, primary: true },
  { label: "Cambios y devoluciones", short: "Cambios", path: "/cambios", icon: RotateCcw, primary: true },
  { label: "Traspasos", short: "Traspasos", path: "/traspasos", icon: ArrowLeftRight },
  { label: "Movimientos", short: "Movimientos", path: "/movimientos", icon: History },
  { label: "Reportes", short: "Reportes", path: "/reportes", icon: BarChart3 },
  { label: "Colores", short: "Colores", path: "/colores", icon: Palette, adminOnly: true },
  { label: "Usuarios", short: "Usuarios", path: "/usuarios", icon: Users, adminOnly: true },
];

export function visibleNav(isAdmin: boolean): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);
}

/** ¿La ruta actual pertenece a esta sección? ("/" solo coincide exactamente). */
export function isActivePath(item: NavItem, pathname: string): boolean {
  return item.path === "/" ? pathname === "/" : pathname === item.path || pathname.startsWith(`${item.path}/`);
}
