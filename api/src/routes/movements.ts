import { orgBranchesSql, scopedBranch, type AuthUser } from "../auth";
import { iso } from "../db";
import { badRequest, ok, type Env } from "../http";
import { queryDate, queryInt } from "../validate";
import {
  EXIT_REASONS,
  EXIT_REASON_LABELS,
  RETURN_REASONS,
  MOVEMENT_CATEGORIES,
  MOVEMENT_LABELS,
  RETURN_REASON_LABELS,
  isMovementCategory,
  lotRef,
  movementRef,
  operationRef,
  receiptRef,
  parseRef,
  saleRef,
  transferRef,
  type ExitReason,
  type MovementCategory,
  type ReturnReason,
} from "../../../shared/catalogo";

const OPERATION_REFS = "('devolucion', 'anulacion', 'devolucion_danada', 'cambio')";
const TRANSFER_REFS = "('traspaso', 'traspaso_cancelado')";

const FROM = `
  FROM movimientos_inventario m
  JOIN sucursales s ON s.id = m.sucursal_id
  JOIN productos p ON p.id = m.producto_id
  JOIN tallas t ON t.id = m.talla_id
  JOIN colores c ON c.id = m.color_id
  LEFT JOIN usuarios u ON u.id = m.usuario_id
  LEFT JOIN sucursales so ON so.id = m.sucursal_origen_id
  LEFT JOIN sucursales sd ON sd.id = m.sucursal_destino_id
  LEFT JOIN traspasos tr ON tr.id = m.referencia_id AND m.referencia_tipo IN ${TRANSFER_REFS}
  LEFT JOIN operaciones o ON o.id = m.referencia_id AND m.referencia_tipo IN ${OPERATION_REFS}`;

const like = (s: string) => `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** Filtros comunes del libro. `withCategory = false` sirve para contar cuántos movimientos hay en cada categoría. */
function buildFilters(url: URL, me: AuthUser, withCategory: boolean) {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (withCategory) {
    const raw = (url.searchParams.get("categoria") ?? "").trim();
    if (raw && raw.toUpperCase() !== "TODOS") {
      const list = raw.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
      for (const c of list) if (!isMovementCategory(c)) throw badRequest(`categoria inválida: ${c}.`);
      where.push(`m.categoria IN (${list.map(() => "?").join(",")})`);
      binds.push(...list);
    }
  }

  // El vendedor queda siempre acotado a su sucursal; el administrador puede elegir.
  const branch = scopedBranch(me, queryInt(url, "sucursal_id"));
  if (branch !== null) {
    where.push("m.sucursal_id = ?");
    binds.push(branch);
  } else {
    where.push(orgBranchesSql(me, "m.sucursal_id")); // consolidado = solo las sucursales de MI organización
  }

  const desde = queryDate(url, "desde");
  const hasta = queryDate(url, "hasta");
  if (desde && hasta && desde > hasta) throw badRequest("La fecha inicial no puede ser posterior a la final.");
  if (desde) { where.push("date(m.created_at, '-4 hours') >= ?"); binds.push(desde); }
  if (hasta) { where.push("date(m.created_at, '-4 hours') <= ?"); binds.push(hasta); }

  for (const [param, column] of [["producto_id", "m.producto_id"], ["talla_id", "m.talla_id"], ["color_id", "m.color_id"], ["usuario_id", "m.usuario_id"]] as const) {
    const value = queryInt(url, param);
    if (value !== null) { where.push(`${column} = ?`); binds.push(value); }
  }

  // Motivo registrado (devoluciones, cambios y salidas). SIN_CLASIFICAR = registros anteriores sin motivo estructurado.
  const motivo = (url.searchParams.get("motivo_codigo") ?? "").trim().toUpperCase();
  if (motivo) {
    if (motivo === "SIN_CLASIFICAR") {
      where.push("m.categoria IN ('CAMBIO', 'DEVOLUCION') AND COALESCE(o.motivo_codigo, m.motivo_codigo) IS NULL");
    } else {
      if (!(RETURN_REASONS as readonly string[]).includes(motivo) && !(EXIT_REASONS as readonly string[]).includes(motivo)) {
        throw badRequest(`motivo_codigo inválido: ${motivo}.`);
      }
      where.push("COALESCE(o.motivo_codigo, m.motivo_codigo) = ?");
      binds.push(motivo);
    }
  }

  // Lote (código L-000123 = id de la raíz): movimientos que tocaron ese lote en cualquier ubicación.
  const lote = queryInt(url, "lote");
  if (lote !== null) {
    where.push(`EXISTS (SELECT 1 FROM lote_movimientos lm JOIN lotes l ON l.id = lm.lote_id WHERE lm.movimiento_id = m.id AND COALESCE(l.lote_raiz_id, l.id) = ?)`);
    binds.push(lote);
  }

  const estado = url.searchParams.get("estado");
  if (estado) {
    if (!["pendiente", "enviado", "recibido", "cancelado"].includes(estado)) throw badRequest("estado inválido.");
    where.push(`m.referencia_tipo IN ${TRANSFER_REFS} AND tr.estado = ?`);
    binds.push(estado);
  }

  const q = (url.searchParams.get("q") ?? "").trim();
  if (q) {
    if (q.length > 80) throw badRequest("La búsqueda es demasiado larga.");
    const clauses = [
      "p.nombre LIKE ? ESCAPE '\\'", "t.nombre LIKE ? ESCAPE '\\'", "c.nombre LIKE ? ESCAPE '\\'",
      "m.observaciones LIKE ? ESCAPE '\\'", "u.nombre LIKE ? ESCAPE '\\'",
    ];
    const vals: unknown[] = [like(q), like(q), like(q), like(q), like(q)];
    const ref = parseRef(q);
    if (ref) {
      switch (ref.kind) {
        case "MOV": clauses.push("m.id = ?"); vals.push(ref.id); break;
        case "TR": clauses.push(`(m.referencia_tipo IN ${TRANSFER_REFS} AND m.referencia_id = ?)`); vals.push(ref.id); break;
        case "V":
          clauses.push(`(m.referencia_tipo = 'venta' AND m.referencia_id = ?)`);
          clauses.push(`(m.referencia_tipo IN ${OPERATION_REFS} AND o.venta_id = ?)`);
          vals.push(ref.id, ref.id);
          break;
        case "L":
          clauses.push(`EXISTS (SELECT 1 FROM lote_movimientos lm JOIN lotes l ON l.id = lm.lote_id WHERE lm.movimiento_id = m.id AND COALESCE(l.lote_raiz_id, l.id) = ?)`);
          vals.push(ref.id);
          break;
        case "REC": clauses.push(`(m.referencia_tipo = 'recepcion' AND m.referencia_id = ?)`); vals.push(ref.id); break;
        case "DV": case "CM": case "AN":
          clauses.push(`(m.referencia_tipo IN ${OPERATION_REFS} AND m.referencia_id = ? AND o.tipo = ?)`);
          vals.push(ref.id, ref.kind === "CM" ? "cambio" : ref.kind === "AN" ? "anulacion" : "devolucion");
          break;
        default:
          clauses.push("m.id = ?", "m.referencia_id = ?");
          vals.push(ref.id, ref.id);
      }
    }
    where.push(`(${clauses.join(" OR ")})`);
    binds.push(...vals);
  }

  return { where, binds };
}

function documentOf(refTipo: string | null, refId: number | null, operationType: string | null) {
  if (!refTipo || refId === null) return null;
  if (refTipo === "venta") return { tipo: "venta", id: refId, codigo: saleRef(refId) };
  if (refTipo === "traspaso" || refTipo === "traspaso_cancelado") return { tipo: "traspaso", id: refId, codigo: transferRef(refId) };
  if (refTipo === "recepcion") return { tipo: "recepcion", id: refId, codigo: receiptRef(refId) };
  if (operationType) return { tipo: operationType, id: refId, codigo: operationRef(operationType, refId) };
  return null;
}

function reasonText(code: string | null): string | null {
  if (!code) return null;
  return RETURN_REASON_LABELS[code as ReturnReason] ?? EXIT_REASON_LABELS[code as ExitReason] ?? null;
}

const EFFECT: Record<string, string> = { "1": "Entrada", "-1": "Salida", "0": "Cuarentena (no vendible)" };

/**
 * Libro de movimientos: filtros combinables (categoría REAL del negocio, no "subió o bajó el stock"), búsqueda por
 * referencia o producto y paginación. Los usuarios y datos que nunca se guardaron en registros antiguos salen como null
 * (la interfaz muestra "No registrado"); nada se inventa.
 */
export async function list(url: URL, env: Env, me: AuthUser): Promise<Response> {
  const main = buildFilters(url, me, true);
  const counts = buildFilters(url, me, false);
  const whereSql = main.where.length ? `WHERE ${main.where.join(" AND ")}` : "";
  const countsSql = counts.where.length ? `WHERE ${counts.where.join(" AND ")}` : "";
  const limite = Math.min(queryInt(url, "limite") ?? 25, 100);
  const pagina = Math.max(queryInt(url, "pagina") ?? 1, 1);

  const [rows, total, byCategory] = await env.DB.batch([
    env.DB
      .prepare(
        `SELECT m.id, m.created_at, m.categoria, m.signo, m.cantidad, m.cantidad_anterior, m.cantidad_resultante,
                m.referencia_tipo, m.referencia_id, m.observaciones, m.motivo_codigo, m.usuario_id, u.nombre AS usuario,
                m.sucursal_id, s.nombre AS sucursal, m.producto_id, p.nombre AS producto, m.talla_id, t.nombre AS talla,
                m.color_id, c.nombre AS color, so.nombre AS origen, sd.nombre AS destino,
                tr.estado AS estado_traspaso, o.tipo AS operacion_tipo, o.motivo AS operacion_motivo, o.motivo_codigo AS operacion_motivo_codigo,
                (SELECT GROUP_CONCAT(DISTINCT COALESCE(l.lote_raiz_id, l.id)) FROM lote_movimientos lm JOIN lotes l ON l.id = lm.lote_id
                  WHERE lm.movimiento_id = m.id) AS lotes_ids
           ${FROM} ${whereSql}
          ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...main.binds, limite, (pagina - 1) * limite),
    env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(m.cantidad), 0) AS unidades,
                      COALESCE(SUM(CASE WHEN m.signo = 1 THEN m.cantidad ELSE 0 END), 0) AS entradas,
                      COALESCE(SUM(CASE WHEN m.signo = -1 THEN m.cantidad ELSE 0 END), 0) AS salidas ${FROM} ${whereSql}`).bind(...main.binds),
    env.DB
      .prepare(`SELECT m.categoria, COUNT(*) AS movimientos, COALESCE(SUM(m.cantidad), 0) AS unidades ${FROM} ${countsSql} GROUP BY m.categoria`)
      .bind(...counts.binds),
  ]);

  const stats = new Map((byCategory.results as { categoria: string; movimientos: number; unidades: number }[]).map((r) => [r.categoria, r]));

  return ok({
    filas: (rows.results as Record<string, unknown>[]).map((r) => {
      const categoria = r.categoria as MovementCategory;
      const code = (r.operacion_motivo_codigo ?? r.motivo_codigo ?? null) as string | null;
      return {
        id: r.id,
        referencia: movementRef(r.id as number),
        fecha: iso(r.created_at as string),
        categoria,
        categoria_etiqueta: MOVEMENT_LABELS[categoria] ?? categoria,
        signo: r.signo,
        efecto: r.signo === null ? "Sin dato" : (EFFECT[String(r.signo)] ?? "Sin dato"),
        cantidad: r.cantidad,
        cantidad_anterior: r.cantidad_anterior,
        cantidad_resultante: r.cantidad_resultante,
        producto: { id: r.producto_id, nombre: r.producto },
        talla: { id: r.talla_id, nombre: r.talla },
        color: { id: r.color_id, nombre: r.color },
        sucursal: { id: r.sucursal_id, nombre: r.sucursal },
        origen: r.origen ?? null,
        destino: r.destino ?? null,
        estado_traspaso: r.estado_traspaso ?? null,
        usuario: r.usuario_id === null ? null : { id: r.usuario_id, nombre: r.usuario ?? "No registrado" },
        documento: documentOf(r.referencia_tipo as string | null, r.referencia_id as number | null, (r.operacion_tipo ?? null) as string | null),
        motivo_codigo: code,
        motivo_etiqueta: reasonText(code),
        motivo: categoria === "CAMBIO" || categoria === "DEVOLUCION" ? ((r.operacion_motivo ?? r.observaciones ?? null) as string | null) : null,
        observaciones: r.observaciones ?? null,
        // Lotes que tocó este movimiento (vacío en movimientos anteriores a los lotes).
        lotes: String(r.lotes_ids ?? "").split(",").filter(Boolean).map((id) => ({ id: Number(id), codigo: lotRef(Number(id)) })),
      };
    }),
    total: (total.results[0] as { n: number }).n,
    unidades: (total.results[0] as { unidades: number }).unidades,
    // Unidades que entraron y salieron del stock vendible con los filtros elegidos (por ubicación, fecha y producto).
    entradas: (total.results[0] as { entradas: number }).entradas,
    salidas: (total.results[0] as { salidas: number }).salidas,
    pagina,
    limite,
    // Conteo por categoría con los mismos filtros EXCEPTO la categoría elegida: sirve para los contadores de las pestañas.
    por_categoria: MOVEMENT_CATEGORIES.map((c) => ({
      categoria: c,
      etiqueta: MOVEMENT_LABELS[c],
      movimientos: stats.get(c)?.movimientos ?? 0,
      unidades: stats.get(c)?.unidades ?? 0,
    })),
  });
}
