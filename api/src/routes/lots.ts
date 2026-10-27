/**
 * Recepciones de mercadería y lotes (migración 0012).
 *
 * - Una recepción registra una o muchas prendas que llegaron juntas (fecha y hora REAL de llegada, proveedor, guía).
 *   Cada modelo/talla/color de la recepción es un lote propio; si la misma variante llega otro día, es otro lote.
 * - Los lotes se mueven con el stock (ver inventory.ts): ventas y salidas consumen los más antiguos (FIFO), un traspaso
 *   recibido crea un lote "hijo" con la misma fecha de recepción y el mismo código, y una devolución vuelve a su lote.
 * - Nada se inventa: el stock anterior a los lotes tiene fecha de recepción desconocida (null) y se muestra así.
 */
import { orgBranchesSql, requireAdmin, requireBranch, scopedBranch, type AuthUser } from "../auth";
import { isUniqueViolation, iso } from "../db";
import { badRequest, conflict, HttpError, notFound, ok, readJson, type Env } from "../http";
import { isAssertionFailure, stockChange, validateVariants } from "../inventory";
import { lotRef, operationRef, parseRef, receiptRef, saleRef, transferRef } from "../../../shared/catalogo";
import { int, optionalStr, queryDate, queryInt, uuid } from "../validate";

const like = (s: string) => `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const toDb = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/**
 * Fecha y hora real de llegada. Acepta ISO 8601 con zona (p. ej. 2026-10-26T10:30:00-04:00 o ...Z) y la guarda en UTC.
 * Sin fecha = ahora. No se acepta una fecha futura (tolerancia de 10 minutos por relojes desfasados).
 */
function receiptDate(value: unknown): string {
  if (value === undefined || value === null || value === "") return toDb(new Date());
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw badRequest("La fecha y hora de llegada no es válida (usa fecha, hora y zona horaria).");
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest("La fecha y hora de llegada no es válida.");
  if (d.getTime() > Date.now() + 10 * 60_000) throw badRequest("La fecha de llegada no puede estar en el futuro.");
  if (d.getUTCFullYear() < 2015) throw badRequest("La fecha de llegada es demasiado antigua.");
  return toDb(d);
}

// ---------------------------------------------------------------- recepciones

/** Registra una recepción (solo administrador). Idempotente por idempotency_key: repetirla nunca suma dos veces. */
export async function createReceipt(request: Request, env: Env, admin: AuthUser): Promise<Response> {
  requireAdmin(admin);
  const body = await readJson(request);
  const key = uuid(body.idempotency_key, "idempotency_key");
  const sucursal = int(body.sucursal_id, "sucursal_id");
  requireBranch(admin, sucursal); // solo ubicaciones de su organización
  const fecha = receiptDate(body.fecha_recepcion);
  const proveedor = optionalStr(body.proveedor, "proveedor", 120);
  const referencia = optionalStr(body.referencia, "referencia", 80);
  const notas = optionalStr(body.notas, "notas", 300);

  const existing = await env.DB.prepare("SELECT id FROM recepciones WHERE idempotency_key = ?").bind(key).first<{ id: number }>();
  if (existing) return ok(await receiptShape(env, existing.id, true));

  const location = await env.DB.prepare("SELECT 1 AS ok FROM sucursales WHERE id = ? AND activa = 1").bind(sucursal).first();
  if (!location) throw badRequest("La ubicación no existe o está inactiva.");

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 200) {
    throw badRequest("La recepción debe tener entre 1 y 200 prendas.");
  }
  const seen = new Set<string>();
  const items = (body.items as unknown[]).map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw badRequest(`Prenda ${i + 1}: datos inválidos.`);
    const e = entry as Record<string, unknown>;
    const it = {
      producto: int(e.producto_id, `Prenda ${i + 1}: modelo`),
      talla: int(e.talla_id, `Prenda ${i + 1}: talla`),
      color: int(e.color_id, `Prenda ${i + 1}: color`),
      qty: int(e.cantidad, `Prenda ${i + 1}: cantidad`, 1, 100_000),
      notas: optionalStr(e.notas, `Prenda ${i + 1}: notas`, 200),
    };
    const k = `${it.producto}-${it.talla}-${it.color}`;
    if (seen.has(k)) throw badRequest("La misma talla y color aparece dos veces: súmalas en una sola línea.");
    seen.add(k);
    return it;
  });
  await validateVariants(env, items, (i) => `Prenda ${i + 1}`);

  const byKey = "(SELECT id FROM recepciones WHERE idempotency_key = ?)";
  const total = items.reduce((a, it) => a + it.qty, 0);
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `INSERT INTO recepciones (sucursal_id, fecha_recepcion, proveedor, referencia, notas, total_unidades, idempotency_key, creado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(sucursal, fecha, proveedor, referencia, notas, total, key, admin.id),
  ];
  for (const it of items) {
    statements.push(
      ...stockChange(env, {
        sucursal, producto: it.producto, talla: it.talla, color: it.color, qty: it.qty,
        categoria: "INGRESO", signo: 1, tipo: "entrada", usuarioId: admin.id,
        refTipo: "recepcion", refIdSql: byKey, refIdBinds: [key],
        observaciones: [proveedor ? `Proveedor: ${proveedor}` : null, referencia ? `Ref.: ${referencia}` : null, it.notas ?? notas]
          .filter(Boolean).join(" · ") || null,
        lote: {
          nuevo: {
            origen: "recepcion",
            fechaRecepcionSql: "?", fechaRecepcionBinds: [fecha],
            fechaLlegadaSql: "?", fechaLlegadaBinds: [fecha],
            recepcionIdSql: byKey, recepcionIdBinds: [key],
            proveedor, referencia, notas: it.notas ?? notas,
          },
        },
      }),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err, "idempotency_key")) {
      const dup = await env.DB.prepare("SELECT id FROM recepciones WHERE idempotency_key = ?").bind(key).first<{ id: number }>();
      if (dup) return ok(await receiptShape(env, dup.id, true));
    }
    if (isAssertionFailure(err)) throw conflict("No se pudo registrar la recepción porque el stock cambió al mismo tiempo. No se guardó nada.");
    throw err;
  }

  const created = await env.DB.prepare("SELECT id FROM recepciones WHERE idempotency_key = ?").bind(key).first<{ id: number }>();
  if (!created) throw new HttpError(500, "No se pudo confirmar la recepción.");
  await env.DB
    .prepare("INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, detalle) VALUES (?, 'recepcion_crear', 'recepciones', ?, ?)")
    .bind(admin.id, created.id, `${items.length} líneas, ${total} unidades`)
    .run();
  return ok(await receiptShape(env, created.id, false));
}

interface ReceiptRow {
  id: number;
  sucursal_id: number;
  sucursal: string;
  fecha_recepcion: string;
  proveedor: string | null;
  referencia: string | null;
  notas: string | null;
  total_unidades: number;
  creado_por: string | null;
  created_at: string;
}

const RECEIPT_SELECT = `SELECT r.id, r.sucursal_id, s.nombre AS sucursal, r.fecha_recepcion, r.proveedor, r.referencia, r.notas,
                               r.total_unidades, u.nombre AS creado_por, r.created_at
                          FROM recepciones r JOIN sucursales s ON s.id = r.sucursal_id LEFT JOIN usuarios u ON u.id = r.creado_por`;

async function receiptShape(env: Env, id: number, repetida: boolean) {
  const r = await env.DB.prepare(`${RECEIPT_SELECT} WHERE r.id = ?`).bind(id).first<ReceiptRow>();
  if (!r) throw notFound("Recepción no encontrada.");
  const { results } = await env.DB
    .prepare(
      `SELECT l.id, p.nombre AS producto, t.nombre AS talla, c.nombre AS color, l.cantidad_inicial, l.cantidad_restante
         FROM lotes l JOIN productos p ON p.id = l.producto_id JOIN tallas t ON t.id = l.talla_id JOIN colores c ON c.id = l.color_id
        WHERE l.recepcion_id = ? ORDER BY l.id`,
    )
    .bind(id)
    .all<{ id: number; producto: string; talla: string; color: string; cantidad_inicial: number; cantidad_restante: number }>();
  return {
    id: r.id,
    referencia_recepcion: receiptRef(r.id),
    sucursal: { id: r.sucursal_id, nombre: r.sucursal },
    fecha_recepcion: iso(r.fecha_recepcion),
    proveedor: r.proveedor,
    referencia: r.referencia,
    notas: r.notas,
    total_unidades: r.total_unidades,
    creado_por: r.creado_por,
    registrada: iso(r.created_at),
    lotes: results.map((l) => ({ ...l, codigo: lotRef(l.id) })),
    repetida,
  };
}

/** Historial de recepciones (administrador: su organización o una ubicación; vendedor: su sucursal). */
export async function listReceipts(url: URL, env: Env, me: AuthUser): Promise<Response> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const branch = scopedBranch(me, queryInt(url, "sucursal_id"));
  if (branch !== null) { where.push("r.sucursal_id = ?"); binds.push(branch); } else where.push(orgBranchesSql(me, "r.sucursal_id"));
  const desde = queryDate(url, "desde");
  const hasta = queryDate(url, "hasta");
  if (desde && hasta && desde > hasta) throw badRequest("La fecha inicial no puede ser posterior a la final.");
  if (desde) { where.push("date(r.fecha_recepcion, '-4 hours') >= ?"); binds.push(desde); }
  if (hasta) { where.push("date(r.fecha_recepcion, '-4 hours') <= ?"); binds.push(hasta); }
  const limite = Math.min(queryInt(url, "limite") ?? 25, 100);
  const { results } = await env.DB
    .prepare(`${RECEIPT_SELECT} WHERE ${where.join(" AND ")} ORDER BY r.fecha_recepcion DESC, r.id DESC LIMIT ?`)
    .bind(...binds, limite)
    .all<ReceiptRow>();
  return ok(
    results.map((r) => ({
      id: r.id,
      referencia_recepcion: receiptRef(r.id),
      sucursal: { id: r.sucursal_id, nombre: r.sucursal },
      fecha_recepcion: iso(r.fecha_recepcion),
      proveedor: r.proveedor,
      referencia: r.referencia,
      notas: r.notas,
      total_unidades: r.total_unidades,
      creado_por: r.creado_por,
      registrada: iso(r.created_at),
    })),
  );
}

// ---------------------------------------------------------------- lotes

/** Primera entrada de un lote = la que lo creó (no es una devolución ni un regreso de traspaso). */
const CREATION = "(SELECT MIN(x.id) FROM lote_movimientos x WHERE x.lote_id = l.id)";
const sumOf = (cond: string) => `(SELECT COALESCE(SUM(m.cantidad), 0) FROM lote_movimientos m WHERE m.lote_id = l.id AND ${cond})`;

const LOT_SELECT = `
  SELECT l.id, COALESCE(l.lote_raiz_id, l.id) AS raiz_id, l.lote_origen_id, l.origen, l.sucursal_id, s.nombre AS sucursal, s.tipo AS sucursal_tipo,
         l.producto_id, p.nombre AS producto, l.talla_id, t.nombre AS talla, t.orden AS talla_orden, l.color_id, c.nombre AS color,
         l.cantidad_inicial, l.cantidad_restante, l.fecha_recepcion, l.fecha_llegada, l.recepcion_id, l.traspaso_id,
         l.proveedor, l.referencia, l.notas, u.nombre AS creado_por, l.created_at,
         ${sumOf("m.tipo = 'salida' AND m.referencia_tipo IN ('venta', 'cambio')")}
           - ${sumOf(`m.tipo = 'entrada' AND m.referencia_tipo IN ('devolucion', 'anulacion') AND m.id > ${CREATION}`)} AS vendidas,
         ${sumOf("m.tipo = 'salida' AND m.referencia_tipo = 'traspaso'")}
           - ${sumOf(`m.tipo = 'entrada' AND m.referencia_tipo = 'traspaso_cancelado' AND m.id > ${CREATION}`)} AS traspasadas,
         ${sumOf("m.tipo = 'salida' AND m.referencia_tipo NOT IN ('venta', 'cambio', 'traspaso')")} AS otras_salidas,
         ${sumOf(`m.tipo = 'entrada' AND m.referencia_tipo IN ('devolucion', 'anulacion') AND m.id > ${CREATION}`)} AS devueltas,
         (SELECT COALESCE(SUM(m.cantidad), 0) FROM lote_movimientos m JOIN traspasos tr ON tr.id = m.traspaso_id
           WHERE m.lote_id = l.id AND m.tipo = 'salida' AND m.referencia_tipo = 'traspaso' AND tr.estado = 'enviado') AS en_transito,
         (SELECT MIN(m.created_at) FROM lote_movimientos m WHERE m.lote_id = l.id AND m.tipo = 'salida' AND m.referencia_tipo IN ('venta', 'cambio')) AS primera_venta,
         (SELECT MAX(m.created_at) FROM lote_movimientos m WHERE m.lote_id = l.id AND m.tipo = 'salida' AND m.referencia_tipo IN ('venta', 'cambio')) AS ultima_venta,
         julianday('now') - julianday(l.fecha_recepcion) AS dias_rec,
         julianday('now') - julianday(l.fecha_llegada) AS dias_lleg
    FROM lotes l
    JOIN sucursales s ON s.id = l.sucursal_id
    JOIN productos p ON p.id = l.producto_id
    JOIN tallas t ON t.id = l.talla_id
    JOIN colores c ON c.id = l.color_id
    LEFT JOIN usuarios u ON u.id = l.creado_por`;

interface LotRow {
  id: number; raiz_id: number; lote_origen_id: number | null; origen: string; sucursal_id: number; sucursal: string; sucursal_tipo: string;
  producto_id: number; producto: string; talla_id: number; talla: string; color_id: number; color: string;
  cantidad_inicial: number; cantidad_restante: number; devueltas: number; fecha_recepcion: string | null; fecha_llegada: string | null;
  recepcion_id: number | null; traspaso_id: number | null; proveedor: string | null; referencia: string | null; notas: string | null;
  creado_por: string | null; created_at: string; vendidas: number; traspasadas: number; otras_salidas: number; en_transito: number;
  primera_venta: string | null; ultima_venta: string | null; dias_rec: number | null; dias_lleg: number | null;
}

const ORIGIN_TEXT: Record<string, string> = {
  recepcion: "Recepción de mercadería",
  ingreso: "Ingreso de stock",
  saldo_inicial: "Stock anterior a los lotes",
  conciliacion: "Stock sin lote (fecha desconocida)",
  devolucion: "Devolución sin lote de origen",
  ajuste: "Corrección de stock",
  traspaso: "Llegó por traspaso",
};

/** Días completos transcurridos (null si la fecha es desconocida). */
const wholeDays = (d: number | null) => (d === null ? null : Math.max(0, Math.floor(d + 1e-9)));

function lotShape(r: LotRow) {
  const dias = wholeDays(r.dias_rec);
  const vendidas = r.vendidas;
  const estado =
    r.cantidad_restante > 0
      ? (vendidas > 0 ? "parcialmente_vendido" : "en_stock")
      : r.en_transito > 0
        ? "en_transito"
        : vendidas === 0 && r.traspasadas > 0
          ? "traspasado"
          : "agotado";
  // Días hasta la primera venta: solo con fecha de recepción conocida y al menos una venta (si no, no se inventa).
  const diasPrimera =
    r.fecha_recepcion && r.primera_venta
      ? Math.max(0, Math.floor((Date.parse(iso(r.primera_venta)!) - Date.parse(iso(r.fecha_recepcion)!)) / 86_400_000))
      : null;
  return {
    id: r.id,
    codigo: lotRef(r.raiz_id),
    raiz_id: r.raiz_id,
    lote_origen_id: r.lote_origen_id,
    origen: r.origen,
    origen_texto: ORIGIN_TEXT[r.origen] ?? r.origen,
    sucursal: { id: r.sucursal_id, nombre: r.sucursal, tipo: r.sucursal_tipo },
    producto: { id: r.producto_id, nombre: r.producto },
    talla: { id: r.talla_id, nombre: r.talla },
    color: { id: r.color_id, nombre: r.color },
    cantidad_inicial: r.cantidad_inicial,
    cantidad_restante: r.cantidad_restante,
    vendidas,
    traspasadas: r.traspasadas,
    otras_salidas: r.otras_salidas,
    devueltas: r.devueltas,
    en_transito: r.en_transito,
    fecha_recepcion: iso(r.fecha_recepcion),
    fecha_llegada: iso(r.fecha_llegada),
    dias_en_inventario: dias,
    dias_en_ubicacion: wholeDays(r.dias_lleg),
    primera_venta: iso(r.primera_venta),
    ultima_venta: iso(r.ultima_venta),
    dias_hasta_primera_venta: diasPrimera,
    // Promedio diario desde la recepción: solo con fecha conocida, al menos 1 día transcurrido y al menos una venta.
    promedio_diario: r.fecha_recepcion && vendidas > 0 && dias !== null && dias >= 1 ? Math.round((vendidas / dias) * 100) / 100 : null,
    estado,
    proveedor: r.proveedor,
    referencia: r.referencia,
    notas: r.notas,
    recepcion: r.recepcion_id === null ? null : { id: r.recepcion_id, codigo: receiptRef(r.recepcion_id) },
    traspaso: r.traspaso_id === null ? null : { id: r.traspaso_id, codigo: transferRef(r.traspaso_id) },
    creado_por: r.creado_por,
    registrado: iso(r.created_at),
  };
}

const ESTADOS = ["en_stock", "parcialmente_vendido", "en_transito", "traspasado", "agotado"] as const;

/**
 * Lotes con filtros (ubicación, modelo, talla, color, estado, fecha de recepción, búsqueda por código o producto).
 * Un vendedor solo ve los lotes de su sucursal.
 */
export async function listLots(url: URL, env: Env, me: AuthUser): Promise<Response> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const branch = scopedBranch(me, queryInt(url, "sucursal_id"));
  if (branch !== null) { where.push("l.sucursal_id = ?"); binds.push(branch); } else where.push(orgBranchesSql(me, "l.sucursal_id"));

  for (const [param, column] of [["producto_id", "l.producto_id"], ["talla_id", "l.talla_id"], ["color_id", "l.color_id"], ["recepcion_id", "l.recepcion_id"]] as const) {
    const v = queryInt(url, param);
    if (v !== null) { where.push(`${column} = ?`); binds.push(v); }
  }
  const lote = queryInt(url, "lote");
  if (lote !== null) { where.push("COALESCE(l.lote_raiz_id, l.id) = ?"); binds.push(lote); }
  if (url.searchParams.get("con_stock") === "1") where.push("l.cantidad_restante > 0");

  const desde = queryDate(url, "desde");
  const hasta = queryDate(url, "hasta");
  if (desde && hasta && desde > hasta) throw badRequest("La fecha inicial no puede ser posterior a la final.");
  // Filtro por fecha de recepción (hora de Bolivia). Los lotes de fecha desconocida no entran en un filtro por fecha.
  if (desde) { where.push("l.fecha_recepcion IS NOT NULL AND date(l.fecha_recepcion, '-4 hours') >= ?"); binds.push(desde); }
  if (hasta) { where.push("l.fecha_recepcion IS NOT NULL AND date(l.fecha_recepcion, '-4 hours') <= ?"); binds.push(hasta); }

  const q = (url.searchParams.get("q") ?? "").trim();
  if (q) {
    if (q.length > 80) throw badRequest("La búsqueda es demasiado larga.");
    const ref = parseRef(q);
    const clauses = ["p.nombre LIKE ? ESCAPE '\\'", "t.nombre LIKE ? ESCAPE '\\'", "c.nombre LIKE ? ESCAPE '\\'", "l.proveedor LIKE ? ESCAPE '\\'", "l.referencia LIKE ? ESCAPE '\\'"];
    const vals: unknown[] = [like(q), like(q), like(q), like(q), like(q)];
    if (ref && (ref.kind === "L" || ref.kind === null)) { clauses.push("COALESCE(l.lote_raiz_id, l.id) = ?"); vals.push(ref.id); }
    if (ref && ref.kind === "REC") { clauses.push("l.recepcion_id = ?"); vals.push(ref.id); }
    if (ref && ref.kind === "TR") { clauses.push("l.traspaso_id = ?"); vals.push(ref.id); }
    where.push(`(${clauses.join(" OR ")})`);
    binds.push(...vals);
  }

  const estado = url.searchParams.get("estado");
  if (estado && !(ESTADOS as readonly string[]).includes(estado)) throw badRequest("estado inválido.");

  const { results } = await env.DB
    .prepare(`${LOT_SELECT} WHERE ${where.join(" AND ")} ORDER BY l.fecha_recepcion IS NULL, l.fecha_recepcion DESC, l.id DESC LIMIT 1000`)
    .bind(...binds)
    .all<LotRow>();
  const filas = results.map(lotShape).filter((l) => !estado || l.estado === estado);
  return ok({
    filas,
    total: filas.length,
    truncado: results.length === 1000,
    unidades_restantes: filas.reduce((a, l) => a + l.cantidad_restante, 0),
  });
}

const REF_TEXT: Record<string, string> = {
  recepcion: "Recepción", ingreso_manual: "Ingreso de stock", saldo_inicial: "Stock anterior a los lotes", conciliacion: "Stock sin lote",
  venta: "Venta", cambio: "Cambio (prenda entregada)", salida_manual: "Salida (no es venta)", ajuste_manual: "Corrección de stock",
  devolucion: "Devolución", anulacion: "Anulación de venta", traspaso: "Traspaso", traspaso_cancelado: "Traspaso cancelado",
};

/** Un lote con toda su historia en todas las ubicaciones a las que el usuario tiene acceso. */
export async function lotDetail(env: Env, me: AuthUser, id: number): Promise<Response> {
  const row = await env.DB.prepare(`${LOT_SELECT} WHERE l.id = ?`).bind(id).first<LotRow>();
  if (!row || !me.branch_ids.includes(row.sucursal_id)) throw notFound("Lote no encontrado.");
  if (me.rol !== "admin" && row.sucursal_id !== me.sucursal_id) throw notFound("Lote no encontrado.");

  const visible = me.rol === "admin" ? orgBranchesSql(me, "l.sucursal_id") : "l.sucursal_id = ?";
  const visibleBinds = me.rol === "admin" ? [] : [me.sucursal_id];
  const [family, moves] = await env.DB.batch([
    env.DB.prepare(`${LOT_SELECT} WHERE COALESCE(l.lote_raiz_id, l.id) = ? AND ${visible} ORDER BY l.id`).bind(row.raiz_id, ...visibleBinds),
    env.DB
      .prepare(
        `SELECT m.id, m.lote_id, m.tipo, m.cantidad, m.referencia_tipo, m.referencia_id, m.detalle_venta_id, m.traspaso_id, m.movimiento_id,
                m.created_at, u.nombre AS usuario, s.nombre AS sucursal, dv.venta_id, dv.precio_unitario, o.tipo AS operacion_tipo
           FROM lote_movimientos m
           JOIN lotes l ON l.id = m.lote_id
           JOIN sucursales s ON s.id = l.sucursal_id
           LEFT JOIN usuarios u ON u.id = m.usuario_id
           LEFT JOIN detalle_venta dv ON dv.id = m.detalle_venta_id
           LEFT JOIN operaciones o ON o.id = m.referencia_id AND m.referencia_tipo IN ('devolucion', 'anulacion', 'cambio')
          WHERE COALESCE(l.lote_raiz_id, l.id) = ? AND ${visible}
          ORDER BY m.created_at, m.id`,
      )
      .bind(row.raiz_id, ...visibleBinds),
  ]);

  const documento = (m: Record<string, unknown>) => {
    const refId = m.referencia_id as number | null;
    const t = m.referencia_tipo as string;
    if (t === "venta" && refId !== null) return saleRef(refId);
    if ((t === "traspaso" || t === "traspaso_cancelado") && m.traspaso_id !== null) return transferRef(m.traspaso_id as number);
    if (t === "recepcion" && refId !== null) return receiptRef(refId);
    if (m.operacion_tipo && refId !== null) return operationRef(m.operacion_tipo as string, refId);
    return null;
  };

  return ok({
    lote: lotShape(row),
    ubicaciones: (family.results as unknown as LotRow[]).map(lotShape),
    historial: (moves.results as Record<string, unknown>[]).map((m) => ({
      id: m.id,
      lote_id: m.lote_id,
      fecha: iso(m.created_at as string),
      tipo: m.tipo,
      cantidad: m.cantidad,
      motivo: REF_TEXT[m.referencia_tipo as string] ?? m.referencia_tipo,
      referencia_tipo: m.referencia_tipo,
      documento: documento(m),
      venta: m.venta_id ? { id: m.venta_id, codigo: saleRef(m.venta_id as number), precio_unitario: m.precio_unitario } : null,
      sucursal: m.sucursal,
      usuario: m.usuario ?? null,
      movimiento_id: m.movimiento_id ?? null,
    })),
  });
}
