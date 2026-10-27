import { badRequest } from "./http";

export function int(value: unknown, field: string, min = 1, max = 1_000_000): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${field} debe ser un entero entre ${min} y ${max}.`);
  }
  return value;
}

export function optionalInt(value: unknown, field: string): number | null {
  return value === undefined || value === null ? null : int(value, field);
}

export function str(value: unknown, field: string, maxLen = 200): string {
  if (typeof value !== "string") throw badRequest(`${field} es obligatorio.`);
  const v = value.trim();
  if (!v) throw badRequest(`${field} es obligatorio.`);
  if (v.length > maxLen) throw badRequest(`${field} es demasiado largo (máx. ${maxLen}).`);
  return v;
}

export function optionalStr(value: unknown, field: string, maxLen = 200): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest(`${field} debe ser texto.`);
  const v = value.trim();
  if (!v) return null;
  if (v.length > maxLen) throw badRequest(`${field} es demasiado largo (máx. ${maxLen}).`);
  return v;
}

export function oneOf<T extends string>(value: unknown, field: string, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw badRequest(`${field} debe ser uno de: ${options.join(", ")}.`);
  }
  return value as T;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw badRequest(`${field} debe ser un UUID.`);
  }
  return value.toLowerCase();
}

/** Teléfono boliviano de 8 dígitos (texto; conserva el cero inicial). Vacío = sin teléfono. */
export function optionalPhone(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw badRequest("El teléfono debe ser texto de 8 dígitos.");
  if (!/^\d{8}$/.test(value)) throw badRequest("El teléfono debe tener exactamente 8 dígitos numéricos.");
  return value;
}

export function money(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10_000_000) {
    throw badRequest(`${field} debe ser un número entre 0 y 10 000 000.`);
  }
  return Math.round(value * 100) / 100;
}

export function queryInt(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  if (!/^\d{1,9}$/.test(raw)) throw badRequest(`${name} inválido.`);
  return Number(raw);
}

export function queryDate(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw badRequest(`${name} debe tener formato AAAA-MM-DD.`);
  }
  return raw;
}
