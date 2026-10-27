/**
 * Catálogos y reglas de negocio compartidos por el frontend (src/) y el Worker (api/src/).
 * Sin imports ni dependencias: se prueba directamente en Node (scripts/catalogo.test.mjs).
 * Los rótulos de talla se conservan EXACTAMENTE (texto, sin normalizar ni traducir).
 */

// ----------------------------------------------------------------- tallas de pantalón

/** Catálogo oficial de tallas de pantalón, en este orden exacto. "3G" y "4G" son rótulos literales (no 3XL/4XL). */
export const PANTS_SIZES = ["P", "M", "G", "GG", "3G", "4G", "36", "38", "40", "42", "44", "46", "48"] as const;

export type PantsSize = (typeof PANTS_SIZES)[number];

export const PANTS_CATEGORY = "Pantalones";

/** true si el rótulo es exactamente una talla oficial (sin recortar espacios ni cambiar mayúsculas). */
export function isPantsSize(label: unknown): label is PantsSize {
  return typeof label === "string" && (PANTS_SIZES as readonly string[]).includes(label);
}

/** Posición oficial de una talla (0 = primera). -1 si no pertenece al catálogo (talla histórica). */
export function pantsSizeIndex(label: string): number {
  return (PANTS_SIZES as readonly string[]).indexOf(label);
}

/** Ordena rótulos según el catálogo oficial; las tallas históricas van al final, en orden alfabético. */
export function sortSizeLabels<T extends string>(labels: readonly T[]): T[] {
  return [...labels].sort((a, b) => {
    const ia = pantsSizeIndex(a);
    const ib = pantsSizeIndex(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b, "es");
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/** Una talla nueva solo es válida si la categoría del producto no es pantalón o si la talla es oficial. */
export function sizeAllowedForNewStock(category: string | null | undefined, label: string): boolean {
  if ((category ?? PANTS_CATEGORY) !== PANTS_CATEGORY) return true;
  return isPantsSize(label);
}

// ----------------------------------------------------------------- movimientos de inventario

export const MOVEMENT_CATEGORIES = ["INGRESO", "VENTA", "CAMBIO", "DEVOLUCION", "SALIDA", "TRASPASO", "AJUSTE"] as const;
export type MovementCategory = (typeof MOVEMENT_CATEGORIES)[number];

export const MOVEMENT_LABELS: Record<MovementCategory, string> = {
  INGRESO: "Ingreso",
  VENTA: "Venta",
  CAMBIO: "Cambio",
  DEVOLUCION: "Devolución",
  SALIDA: "Salida",
  TRASPASO: "Traspaso",
  AJUSTE: "Ajuste",
};

export function isMovementCategory(value: unknown): value is MovementCategory {
  return typeof value === "string" && (MOVEMENT_CATEGORIES as readonly string[]).includes(value);
}

/** Motivos autorizados para una salida de stock que no es venta. */
export const EXIT_REASONS = ["DANADO", "PERDIDA", "MUESTRA", "OBSEQUIO", "OTRO"] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];
export const EXIT_REASON_LABELS: Record<ExitReason, string> = {
  DANADO: "Producto dañado",
  PERDIDA: "Pérdida o faltante",
  MUESTRA: "Muestra o exhibición",
  OBSEQUIO: "Obsequio autorizado",
  OTRO: "Otro",
};

// ----------------------------------------------------------------- devoluciones y cambios

export const RETURN_REASONS = [
  "TALLA_INCORRECTA",
  "COLOR_DIFERENTE",
  "MODELO_DIFERENTE",
  "DEFECTO_FABRICA",
  "PRODUCTO_DANADO",
  "ERROR_PEDIDO",
  "CLIENTE_SOLICITO_CAMBIO",
  "OTRO",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  TALLA_INCORRECTA: "Talla incorrecta",
  COLOR_DIFERENTE: "Color diferente al esperado",
  MODELO_DIFERENTE: "Modelo diferente al esperado",
  DEFECTO_FABRICA: "Defecto de fábrica",
  PRODUCTO_DANADO: "Producto dañado",
  ERROR_PEDIDO: "Error en el pedido",
  CLIENTE_SOLICITO_CAMBIO: "Cliente solicitó cambio",
  OTRO: "Otro",
};

export function isReturnReason(value: unknown): value is ReturnReason {
  return typeof value === "string" && (RETURN_REASONS as readonly string[]).includes(value);
}

/** Motivos que se consideran relacionados con la talla (para el reporte de motivos de talla). */
export const SIZE_RELATED_REASONS: readonly ReturnReason[] = ["TALLA_INCORRECTA"];

// ----------------------------------------------------------------- departamentos de Bolivia

export const DEPARTMENTS = ["Beni", "Chuquisaca", "Cochabamba", "La Paz", "Oruro", "Pando", "Potosí", "Santa Cruz", "Tarija"] as const;
export type Department = (typeof DEPARTMENTS)[number];

/** Minúsculas, sin tildes y con espacios simples: solo para comparar, nunca para reescribir datos guardados. */
export function departmentKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const DEPARTMENT_BY_KEY = new Map<string, Department>(DEPARTMENTS.map((d) => [departmentKey(d), d]));

/** Departamento oficial que corresponde al texto guardado, o null si no se reconoce (se conserva para revisión). */
export function canonicalDepartment(value: string | null | undefined): Department | null {
  if (!value) return null;
  return DEPARTMENT_BY_KEY.get(departmentKey(value)) ?? null;
}

// ----------------------------------------------------------------- referencias legibles

const pad = (n: number) => String(n).padStart(6, "0");

export const saleRef = (id: number) => `V-${pad(id)}`;
export const transferRef = (id: number) => `TR-${pad(id)}`;
export const movementRef = (id: number) => `MOV-${pad(id)}`;
/** Código de lote: el de la raíz, igual en todas las ubicaciones a las que se traspasó. */
export const lotRef = (id: number) => `L-${pad(id)}`;
export const receiptRef = (id: number) => `REC-${pad(id)}`;
export const operationRef = (tipo: string, id: number) =>
  `${tipo === "cambio" ? "CM" : tipo === "anulacion" ? "AN" : "DV"}-${pad(id)}`;

export type RefKind = "MOV" | "TR" | "V" | "DV" | "CM" | "AN" | "L" | "REC";

/** Interpreta "TR-000012", "tr12", "#12" o "V-5". Devuelve el tipo (si lo hay) y el número. */
export function parseRef(text: string): { kind: RefKind | null; id: number } | null {
  const m = /^\s*(?:(MOV|TR|REC|V|DV|CM|AN|L)[-\s]?)?#?(\d{1,9})\s*$/i.exec(text);
  if (!m) return null;
  return { kind: m[1] ? (m[1].toUpperCase() as RefKind) : null, id: Number(m[2]) };
}
