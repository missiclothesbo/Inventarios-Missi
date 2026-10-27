import type { Env } from "./http";

/** D1 guarda CURRENT_TIMESTAMP como 'AAAA-MM-DD HH:MM:SS' en UTC; el frontend espera ISO 8601. */
export function iso(ts: string | null | undefined): string | null {
  return ts ? ts.replace(" ", "T") + "Z" : null;
}

export const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const isStockViolation = (err: unknown) =>
  /CHECK constraint failed/i.test(errorText(err)) && /cantidad/i.test(errorText(err));

export const isUniqueViolation = (err: unknown, column?: string) =>
  /UNIQUE constraint failed/i.test(errorText(err)) && (!column || errorText(err).includes(column));

/** Valores de la API (amigables) ↔ valores almacenados en D1. */
export const MODALIDAD_TO_DB = {
  entrega_directa: "directa",
  envio: "interdepartamental",
  envio_interprovincial: "interprovincial",
} as const;

export const MODALIDAD_FROM_DB: Record<string, string> = {
  directa: "entrega_directa",
  interdepartamental: "envio",
  interprovincial: "envio_interprovincial",
};

export const PAGO_TO_DB = { QR: "qr", efectivo: "efectivo" } as const;
export const PAGO_FROM_DB: Record<string, string> = { qr: "QR", efectivo: "efectivo" };

/**
 * Suma `qty` al stock de una variante (la crea si no existe) SOLO si `guardSql` se cumple.
 * Todo movimiento de stock pasa por estos helpers dentro de env.DB.batch (una transacción).
 */
export function addStockStatement(
  env: Env,
  v: { sucursal: number; producto: number; talla: number; color: number; qty: number },
  guardSql: string,
  guardBinds: unknown[],
): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO inventario (producto_id, talla_id, color_id, sucursal_id, cantidad)
       SELECT ?, ?, ?, ?, ? WHERE ${guardSql}
       ON CONFLICT (producto_id, talla_id, color_id, sucursal_id)
       DO UPDATE SET cantidad = inventario.cantidad + excluded.cantidad, updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(v.producto, v.talla, v.color, v.sucursal, v.qty, ...guardBinds);
}

/**
 * Resta `qty` al stock SOLO si `guardSql` se cumple. Si no alcanza, el CHECK (cantidad >= 0) de la tabla
 * hace fallar la transacción completa: el stock nunca queda negativo ni siquiera con peticiones simultáneas.
 */
export function subtractStockStatement(
  env: Env,
  v: { sucursal: number; producto: number; talla: number; color: number; qty: number },
  guardSql: string,
  guardBinds: unknown[],
): D1PreparedStatement {
  return env.DB
    .prepare(
      `UPDATE inventario SET cantidad = cantidad - ?, updated_at = CURRENT_TIMESTAMP
        WHERE sucursal_id = ? AND producto_id = ? AND talla_id = ? AND color_id = ? AND ${guardSql}`,
    )
    .bind(v.qty, v.sucursal, v.producto, v.talla, v.color, ...guardBinds);
}
