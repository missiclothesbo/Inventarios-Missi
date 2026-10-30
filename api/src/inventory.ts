/**
 * Servicio central de inventario. ÚNICA puerta para cambiar stock: cada cambio produce SIEMPRE su asiento en el libro
 * (`movimientos_inventario`) dentro del mismo lote de D1, así que stock y libro se guardan o se revierten juntos.
 *
 * - signo +1: suma al stock vendible (INSERT ... ON CONFLICT).
 * - signo -1: resta; el CHECK (cantidad >= 0) de la tabla revierte todo el lote si no alcanza (nunca queda negativo).
 * - signo  0: no cambia el stock vendible (p. ej. cuarentena de mercadería dañada); solo deja el asiento.
 *
 * La categoría de negocio (INGRESO, VENTA, CAMBIO, DEVOLUCION, SALIDA, TRASPASO, AJUSTE) es la autoridad;
 * `tipo` es el valor técnico heredado que exige el CHECK original de la tabla.
 */
import { sizeAllowedForNewStock, PANTS_SIZES, type MovementCategory } from "../../shared/catalogo";
import { addStockStatement, subtractStockStatement } from "./db";
import { badRequest, type Env } from "./http";

export interface VariantQty {
  sucursal: number;
  producto: number;
  talla: number;
  color: number;
  qty: number;
}

export type LegacyTipo = "entrada" | "venta" | "ajuste" | "traspaso_entrada" | "traspaso_salida";

export type LotOrigin = "recepcion" | "ingreso" | "ajuste" | "devolucion" | "traspaso";

/**
 * Cómo afecta un cambio de stock a los lotes (ver migración 0012). Sin indicar nada:
 *  - signo -1 consume lotes del más antiguo al más nuevo (los de fecha desconocida primero);
 *  - signo +1 crea un lote nuevo con fecha de recepción desconocida (salvo que se indique `nuevo`).
 */
export interface LotSpec {
  /** +1: lote nuevo. Fechas como expresión SQL (UTC); por defecto llegada = ahora y recepción = NULL (desconocida). */
  nuevo?: {
    origen: LotOrigin;
    fechaRecepcionSql?: string;
    fechaRecepcionBinds?: unknown[];
    fechaLlegadaSql?: string;
    fechaLlegadaBinds?: unknown[];
    proveedor?: string | null;
    referencia?: string | null;
    notas?: string | null;
    recepcionIdSql?: string;
    recepcionIdBinds?: unknown[];
  };
  /** +1: vuelve primero a los lotes de los que salió esta línea de venta o este traspaso; lo que no se pueda, lote nuevo. */
  restaurar?: { detalleVentaId?: number; traspasoId?: number; origenResto: LotOrigin };
  /** +1 en el destino de un traspaso: un lote hijo por cada lote del que salió la mercadería (misma fecha de recepción). */
  desdeTraspaso?: { traspasoId: number; origenSucursal: number };
  /** -1: enlaces del consumo (línea de venta como expresión SQL, traspaso). */
  detalleVentaSql?: string;
  detalleVentaBinds?: unknown[];
  traspasoId?: number;
}

export interface LedgerEntry extends VariantQty {
  categoria: MovementCategory;
  signo: 1 | -1 | 0;
  tipo: LegacyTipo;
  /** Usuario autenticado responsable (nunca viene del cuerpo de la petición). */
  usuarioId: number | null;
  refTipo: string | null;
  /** Expresión SQL que resuelve el id de referencia (p. ej. "?" o "(SELECT id FROM ...)") y sus binds. */
  refIdSql: string;
  refIdBinds: unknown[];
  observaciones: string | null;
  motivoCodigo?: string | null;
  origenId?: number | null;
  destinoId?: number | null;
  lote?: LotSpec;
}

/** Orden de consumo: fecha desconocida primero, luego la recepción más antigua (FIFO), luego el lote más antiguo. */
const FIFO = "l.fecha_recepcion IS NOT NULL, l.fecha_recepcion, l.id";
const VARIANT_L = "l.sucursal_id = ? AND l.producto_id = ? AND l.talla_id = ? AND l.color_id = ?";

/** Error de aserción del lote (lotes insuficientes o fila de stock inexistente): el lote de D1 entero se revirtió. */
export const isAssertionFailure = (err: unknown) => /operacion_validacion|CHECK constraint failed: ok/i.test(String((err as Error)?.message ?? err));

/** Sentencias de lotes que van ANTES de cambiar `inventario` (así la regla "lotes = stock" se cumple al cambiarlo). */
function lotStatements(env: Env, e: LedgerEntry, grupo: string, guardSql: string, guardBinds: unknown[]): D1PreparedStatement[] {
  const vb = [e.sucursal, e.producto, e.talla, e.color];
  const refTipo = e.refTipo ?? "ajuste_manual";
  const spec = e.lote ?? {};
  const out: D1PreparedStatement[] = [];

  /** Lote nuevo + su entrada (solo si el INSERT del lote ocurrió). */
  const newLot = (origen: LotOrigin, qtySql: string, qtyBinds: unknown[], extra: LotSpec["nuevo"] & { traspasoId?: number | null } = { origen }) => {
    const fechaRec = extra.fechaRecepcionSql ?? "NULL";
    const fechaLleg = extra.fechaLlegadaSql ?? (origen === "ajuste" ? "NULL" : "CURRENT_TIMESTAMP");
    const recId = extra.recepcionIdSql ?? "NULL";
    out.push(
      env.DB
        .prepare(
          `INSERT INTO lotes (sucursal_id, producto_id, talla_id, color_id, origen, cantidad_inicial, cantidad_restante,
                              fecha_recepcion, fecha_llegada, recepcion_id, traspaso_id, proveedor, referencia, notas, creado_por)
           SELECT ?, ?, ?, ?, ?, q.d, q.d, ${fechaRec}, ${fechaLleg}, ${recId}, ?, ?, ?, ?, ?
             FROM (SELECT ${qtySql} AS d) q
            WHERE q.d > 0 AND ${guardSql}`,
        )
        .bind(
          ...vb, origen, ...(extra.fechaRecepcionBinds ?? []), ...(extra.fechaLlegadaBinds ?? []), ...(extra.recepcionIdBinds ?? []),
          extra.traspasoId ?? null, extra.proveedor ?? null, extra.referencia ?? null, extra.notas ?? null, e.usuarioId,
          ...qtyBinds, ...guardBinds,
        ),
      env.DB
        .prepare(
          `INSERT INTO lote_movimientos (lote_id, tipo, cantidad, referencia_tipo, referencia_id, traspaso_id, usuario_id, grupo)
           SELECT l.id, 'entrada', l.cantidad_inicial, ?, ${e.refIdSql}, ?, ?, ? FROM lotes l
            WHERE changes() = 1 AND l.id = last_insert_rowid()`,
        )
        .bind(refTipo, ...e.refIdBinds, extra.traspasoId ?? null, e.usuarioId, grupo),
    );
  };
  const appliedSum = "(SELECT COALESCE(SUM(cantidad), 0) FROM lote_movimientos WHERE grupo = ?)";

  if (e.signo === -1) {
    // 1) Reparto FIFO calculado y guardado en la misma transacción (sin leer antes: no hay carreras).
    const detSql = spec.detalleVentaSql ?? "NULL";
    out.push(
      env.DB
        .prepare(
          `INSERT INTO lote_movimientos (lote_id, tipo, cantidad, referencia_tipo, referencia_id, detalle_venta_id, traspaso_id, usuario_id, grupo)
           SELECT f.id, 'salida', MIN(f.cantidad_restante, ? - f.previo), ?, ${e.refIdSql}, ${detSql}, ?, ?, ?
             FROM (SELECT l.id, l.cantidad_restante,
                          COALESCE(SUM(l.cantidad_restante) OVER (ORDER BY ${FIFO} ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS previo
                     FROM lotes l
                    WHERE ${VARIANT_L} AND l.cantidad_restante > 0) f
            WHERE f.previo < ? AND ${guardSql}`,
        )
        .bind(e.qty, refTipo, ...e.refIdBinds, ...(spec.detalleVentaBinds ?? []), spec.traspasoId ?? null, e.usuarioId, grupo, ...vb, e.qty, ...guardBinds),
      // 2) Los lotes deben cubrir toda la cantidad; si no, se revierte el lote completo.
      env.DB
        .prepare(`INSERT INTO operacion_validacion (ok) SELECT CASE WHEN ${appliedSum} = ? THEN 1 ELSE 0 END WHERE ${guardSql}`)
        .bind(grupo, e.qty, ...guardBinds),
      // 3) Se descuenta de cada lote lo repartido.
      env.DB
        .prepare(
          `UPDATE lotes SET cantidad_restante = cantidad_restante - (SELECT SUM(lm.cantidad) FROM lote_movimientos lm WHERE lm.grupo = ? AND lm.lote_id = lotes.id)
            WHERE id IN (SELECT lote_id FROM lote_movimientos WHERE grupo = ?)`,
        )
        .bind(grupo, grupo),
    );
  } else if (e.signo === 1 && spec.restaurar) {
    const r = spec.restaurar;
    const byDetail = r.detalleVentaId !== undefined;
    const keyCol = byDetail ? "lm.detalle_venta_id" : "lm.traspaso_id";
    const outRefs = byDetail ? "('venta')" : "('traspaso')";
    const backRefs = byDetail ? "('devolucion', 'anulacion')" : "('traspaso_cancelado')";
    const keyVal = byDetail ? r.detalleVentaId : r.traspasoId;
    out.push(
      // Vuelve a los lotes de los que salió (primero al último que se consumió), sin pasar de lo que salió de cada uno.
      env.DB
        .prepare(
          `INSERT INTO lote_movimientos (lote_id, tipo, cantidad, referencia_tipo, referencia_id, detalle_venta_id, traspaso_id, usuario_id, grupo)
           SELECT x.lote_id, 'entrada', MIN(x.disp, ? - x.previo), ?, ${e.refIdSql}, ?, ?, ?, ?
             FROM (SELECT d.lote_id, d.disp,
                          COALESCE(SUM(d.disp) OVER (ORDER BY d.orden DESC, d.lote_id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS previo
                     FROM (SELECT lm.lote_id,
                                  SUM(CASE WHEN lm.tipo = 'salida' AND lm.referencia_tipo IN ${outRefs} THEN lm.cantidad ELSE 0 END)
                                - SUM(CASE WHEN lm.tipo = 'entrada' AND lm.referencia_tipo IN ${backRefs} THEN lm.cantidad ELSE 0 END) AS disp,
                                  MAX(lm.id) AS orden
                             FROM lote_movimientos lm JOIN lotes l ON l.id = lm.lote_id
                            WHERE ${keyCol} = ? AND ${VARIANT_L}
                            GROUP BY lm.lote_id) d
                    WHERE d.disp > 0) x
            WHERE x.previo < ? AND ${guardSql}`,
        )
        .bind(
          e.qty, refTipo, ...e.refIdBinds, byDetail ? r.detalleVentaId : null, byDetail ? null : r.traspasoId, e.usuarioId, grupo,
          keyVal, ...vb, e.qty, ...guardBinds,
        ),
      env.DB
        .prepare(
          `UPDATE lotes SET cantidad_restante = cantidad_restante + (SELECT SUM(lm.cantidad) FROM lote_movimientos lm WHERE lm.grupo = ? AND lm.lote_id = lotes.id)
            WHERE id IN (SELECT lote_id FROM lote_movimientos WHERE grupo = ?)`,
        )
        .bind(grupo, grupo),
    );
    // Lo que no tiene lote de origen conocido (p. ej. vendido antes de activar los lotes): lote nuevo, fecha desconocida.
    newLot(r.origenResto, `? - ${appliedSum}`, [e.qty, grupo], {
      origen: r.origenResto,
      traspasoId: byDetail ? null : r.traspasoId,
      notas: "Volvió al stock sin lote de origen conocido: fecha de ingreso desconocida.",
    });
  } else if (e.signo === 1 && spec.desdeTraspaso) {
    const t = spec.desdeTraspaso;
    out.push(
      // Un lote hijo por cada lote del que salió (neto de lo que ya volvió): misma fecha de recepción y mismo código de lote.
      env.DB
        .prepare(
          `INSERT INTO lotes (sucursal_id, producto_id, talla_id, color_id, lote_raiz_id, lote_origen_id, origen, cantidad_inicial, cantidad_restante,
                              fecha_recepcion, fecha_llegada, traspaso_id, proveedor, referencia, notas, creado_por)
           SELECT ?, src.producto_id, src.talla_id, src.color_id, COALESCE(src.lote_raiz_id, src.id), src.id, 'traspaso', a.cant, a.cant,
                  src.fecha_recepcion, CURRENT_TIMESTAMP, ?, src.proveedor, src.referencia, NULL, ?
             FROM (SELECT lm.lote_id, SUM(CASE WHEN lm.tipo = 'salida' THEN lm.cantidad ELSE -lm.cantidad END) AS cant
                     FROM lote_movimientos lm JOIN lotes l ON l.id = lm.lote_id
                    WHERE lm.traspaso_id = ? AND lm.referencia_tipo IN ('traspaso', 'traspaso_cancelado') AND ${VARIANT_L}
                    GROUP BY lm.lote_id) a
             JOIN lotes src ON src.id = a.lote_id
            WHERE a.cant > 0 AND ${guardSql}
            ORDER BY src.id`,
        )
        .bind(e.sucursal, t.traspasoId, e.usuarioId, t.traspasoId, t.origenSucursal, e.producto, e.talla, e.color, ...guardBinds),
      env.DB
        .prepare(
          `INSERT INTO lote_movimientos (lote_id, tipo, cantidad, referencia_tipo, referencia_id, traspaso_id, usuario_id, grupo)
           SELECT l.id, 'entrada', l.cantidad_inicial, ?, ${e.refIdSql}, ?, ?, ? FROM lotes l
            WHERE l.traspaso_id = ? AND l.origen = 'traspaso' AND ${VARIANT_L}
              AND NOT EXISTS (SELECT 1 FROM lote_movimientos x WHERE x.lote_id = l.id)`,
        )
        .bind(refTipo, ...e.refIdBinds, t.traspasoId, e.usuarioId, grupo, t.traspasoId, ...vb),
    );
    // Mercadería despachada antes de activar los lotes: llega como lote de fecha desconocida.
    newLot("traspaso", `? - ${appliedSum}`, [e.qty, grupo], {
      origen: "traspaso",
      traspasoId: t.traspasoId,
      notas: "Despachado antes de activar los lotes: fecha de ingreso desconocida.",
    });
  } else if (e.signo === 1) {
    const n = spec.nuevo ?? { origen: (e.categoria === "INGRESO" ? "ingreso" : "ajuste") as LotOrigin };
    newLot(n.origen, "?", [e.qty], n);
  }
  return out;
}

/**
 * Sentencias de un cambio de stock + sus lotes + su asiento. Solo se aplican si `guardSql` se cumple
 * (se usa para atar el movimiento al cambio de estado ganado de un traspaso, una devolución, etc.).
 * Orden: lotes → inventario (con aserción de fila) → libro → enlace lote↔libro. Todo en el mismo lote de D1.
 */
export function stockChange(env: Env, e: LedgerEntry, guardSql = "1 = 1", guardBinds: unknown[] = []): D1PreparedStatement[] {
  const v = { sucursal: e.sucursal, producto: e.producto, talla: e.talla, color: e.color, qty: e.qty };
  const grupo = crypto.randomUUID();
  const statements: D1PreparedStatement[] = lotStatements(env, e, grupo, guardSql, guardBinds);

  if (e.signo === 1) statements.push(addStockStatement(env, v, guardSql, guardBinds));
  else if (e.signo === -1) {
    statements.push(
      subtractStockStatement(env, v, guardSql, guardBinds),
      // Un UPDATE sin filas (la variante no existe en esa ubicación) nunca pasa en silencio: revierte todo.
      env.DB.prepare(`INSERT INTO operacion_validacion (ok) SELECT CASE WHEN changes() = 1 THEN 1 ELSE 0 END WHERE ${guardSql}`).bind(...guardBinds),
    );
  }

  const current = "(SELECT cantidad FROM inventario WHERE sucursal_id = ? AND producto_id = ? AND talla_id = ? AND color_id = ?)";
  const variantBinds = [e.sucursal, e.producto, e.talla, e.color];
  // Cantidad resultante = la del inventario justo después del cambio (mismo lote); la anterior se deduce de ella.
  const previousSql = e.signo === 0 ? "NULL" : `${current} - ?`;
  const resultSql = e.signo === 0 ? "NULL" : current;
  const previousBinds = e.signo === 0 ? [] : [...variantBinds, e.signo * e.qty];
  const resultBinds = e.signo === 0 ? [] : variantBinds;

  statements.push(
    env.DB
      .prepare(
        `INSERT INTO movimientos_inventario
           (sucursal_id, producto_id, talla_id, color_id, tipo, cantidad, referencia_tipo, referencia_id, observaciones,
            categoria, signo, usuario_id, sucursal_origen_id, sucursal_destino_id, motivo_codigo,
            cantidad_anterior, cantidad_resultante)
         SELECT ?, ?, ?, ?, ?, ?, ?, ${e.refIdSql}, ?, ?, ?, ?, ?, ?, ?, ${previousSql}, ${resultSql}
          WHERE ${guardSql}`,
      )
      .bind(
        e.sucursal, e.producto, e.talla, e.color, e.tipo, e.qty, e.refTipo,
        ...e.refIdBinds,
        e.observaciones, e.categoria, e.signo, e.usuarioId, e.origenId ?? null, e.destinoId ?? null, e.motivoCodigo ?? null,
        ...previousBinds, ...resultBinds,
        ...guardBinds,
      ),
  );

  // Enlace lote ↔ asiento del libro: el asiento recién insertado es el último del libro dentro de esta transacción.
  if (e.signo !== 0) {
    statements.push(
      env.DB
        .prepare("UPDATE lote_movimientos SET movimiento_id = (SELECT MAX(id) FROM movimientos_inventario) WHERE grupo = ? AND movimiento_id IS NULL")
        .bind(grupo),
    );
  }

  return statements;
}

export interface VariantRef {
  producto: number;
  talla: number;
  color: number;
}

export interface VariantInfo {
  producto: string;
  categoria: string;
  talla: string;
  color: string;
  precio_venta: number;
}

/**
 * Verifica que cada variante exista y esté activa y que, para pantalones, la talla sea una de las oficiales.
 * Se usa en TODA operación que crea o mueve inventario nuevo (ingresos, ventas, traspasos, reemplazos de cambio).
 */
export async function validateVariants(env: Env, variants: VariantRef[], label: string | ((i: number) => string), allowInactiveColors = false): Promise<VariantInfo[]> {
  if (variants.length === 0) return [];
  const rows = await env.DB.batch(
    variants.map((v) =>
      env.DB
        .prepare(
          `SELECT p.nombre AS producto, p.categoria, t.nombre AS talla, c.nombre AS color, p.precio_venta
             FROM productos p, tallas t, colores c
            WHERE p.id = ? AND p.activo = 1 AND t.id = ? AND c.id = ? AND (c.estado = 1 OR ?)`,
        )
        .bind(v.producto, v.talla, v.color, allowInactiveColors ? 1 : 0),
    ),
  );

  const nameOf = (i: number) => (typeof label === "function" ? label(i) : `${label}[${i}]`);
  return rows.map((r, i) => {
    const row = r.results[0] as VariantInfo | undefined;
    if (!row) throw badRequest(`${nameOf(i)}: producto, talla o color inexistente o inactivo.`);
    if (!sizeAllowedForNewStock(row.categoria, row.talla)) {
      throw badRequest(
        `${nameOf(i)}: la talla «${row.talla}» no pertenece al catálogo oficial de pantalones (${PANTS_SIZES.join(", ")}).`,
      );
    }
    return row;
  });
}
