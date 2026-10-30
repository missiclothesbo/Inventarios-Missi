/** Lógica pura de colores por modelo (sin React ni API), para poder probarla en Node. */
export interface ColorItem {
  id: number;
  nombre: string;
  estado: boolean;
  /** Modelos a los que está asignado el color. */
  producto_ids?: number[];
  /** true si ya aparece en stock, ventas o lotes (no se borra nunca; solo se renombra, asigna o desactiva). */
  en_uso?: boolean;
}

/** Nombre para mostrar: espacios recortados y colapsados, conservando las mayúsculas elegidas. */
export const cleanColorName = (v: string) => v.normalize("NFC").replace(/\s+/g, " ").trim();
/** Clave de comparación: sin importar mayúsculas ni espacios de más. */
export const colorKey = (v: string) => cleanColorName(v).toLocaleLowerCase("es");

const VALID = /^[\p{L}\p{N}][\p{L}\p{N} .'\-/]*$/u;

/** Mensaje de error del nombre (o null). `existing` = colores ya guardados; `exceptId` = el que se está editando. */
export function colorNameError(raw: string, existing: ColorItem[], exceptId?: number): string | null {
  const name = cleanColorName(raw);
  if (!name) return "Escribe el nombre del color.";
  if (name.length > 40) return "El nombre es demasiado largo (máximo 40 caracteres).";
  if (!VALID.test(name)) return "Usa solo letras, números, espacios, punto, guion, apóstrofo o barra.";
  const dup = existing.find((c) => c.id !== exceptId && colorKey(c.nombre) === colorKey(name));
  if (dup) return `Ya existe el color «${dup.nombre}». Úsalo y asígnalo al modelo que necesites.`;
  return null;
}

/**
 * Colores que se ofrecen para registrar mercadería NUEVA de un modelo: activos y asignados a él.
 * Sin modelo elegido no se ofrece ninguno (primero se elige el modelo).
 */
export function colorsForProduct<T extends ColorItem>(colors: T[], productId: number | string | null | undefined): T[] {
  const id = Number(productId);
  if (!productId || !Number.isInteger(id)) return [];
  return colors.filter((c) => c.estado && (c.producto_ids ?? []).includes(id));
}

/** Modelos sin asignar a un color (para ofrecer «asignar a otro modelo»). */
export const unassignedProducts = <P extends { id: number }>(color: ColorItem, products: P[]): P[] =>
  products.filter((p) => !(color.producto_ids ?? []).includes(p.id));
