/**
 * Reglas de validación del formulario de venta. Sin dependencias: se prueban directamente en Node
 * (scripts/frontend-unit.test.mjs). El servidor vuelve a validar todo (api/src/validate.ts, routes/sales.ts).
 */

export const PHONE_DIGITS = 8;

export type DeliveryMode = "entrega_directa" | "envio" | "envio_interprovincial";

/** Deja solo dígitos y corta a 8. Úsalo solo para el texto ya pegado/escrito, nunca para ocultar errores. */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "").slice(0, PHONE_DIGITS);
}

/** true si el texto contiene algo distinto de dígitos (para avisar al usuario, no para borrarlo en silencio). */
export function hasNonDigits(value: string): boolean {
  return /\D/.test(value);
}

/** Vacío = sin teléfono (opcional). Si hay algo, debe ser exactamente 8 dígitos. Devuelve el error o null. */
export function phoneError(value: string): string | null {
  if (value === "") return null;
  if (hasNonDigits(value)) return "El teléfono solo acepta números.";
  if (value.length !== PHONE_DIGITS) return `El teléfono debe tener exactamente ${PHONE_DIGITS} dígitos.`;
  return null;
}

/** Validación de entrega según el método elegido. Devuelve el primer error o null. */
export function deliveryError(
  mode: DeliveryMode,
  fields: { department: string; province: string },
): string | null {
  if (mode === "envio" && fields.department.trim() === "") {
    return "Selecciona el departamento de envío.";
  }
  if (mode === "envio_interprovincial" && fields.province.trim() === "") {
    return "Escribe la provincia para el envío interprovincial.";
  }
  return null;
}

/** Solo los campos del método elegido viajan al servidor; el resto se envía vacío (nunca datos obsoletos). */
export function deliveryPayload(
  mode: DeliveryMode,
  fields: { department: string; province: string },
): { departamento: string; provincia: string } {
  if (mode === "envio") return { departamento: fields.department.trim(), provincia: "" };
  if (mode === "envio_interprovincial") return { departamento: "", provincia: fields.province.trim() };
  return { departamento: "", provincia: "" };
}

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Valida una foto antes de subirla (tipo y tamaño). Devuelve el error o null. */
export function photoFileError(file: File): string | null {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) return "La foto debe ser JPG, PNG o WebP.";
  if (file.size > MAX_PHOTO_BYTES) return "La foto supera el máximo de 2 MB.";
  if (file.size === 0) return "La foto está vacía.";
  return null;
}

