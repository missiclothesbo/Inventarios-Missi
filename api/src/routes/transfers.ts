import { audit, orgBranchesSql, requireBranch, scopedBranch, type AuthUser } from "../auth";
import { isStockViolation, isUniqueViolation, iso } from "../db";
import { badRequest, conflict, notFound, ok, readJson, type Env } from "../http";
import { isAssertionFailure, stockChange, validateVariants } from "../inventory";
import { lotRef, parseRef, transferRef } from "../../../shared/catalogo";
import { int, optionalStr, queryDate, queryInt, uuid } from "../validate";

interface TransferRow {
  id: number;
  sucursal_origen_id: number;
  sucursal_destino_id: number;
  estado: string;
  responsable: string;
  observaciones: string | null;
  fecha: string;
  enviado_at: string | null;
  recibido_at: string | null;
  cancelado_at: string | null;
  creado_por: number | null;
  despachado_por: number | null;
  recibido_por: number | null;
  cancelado_por: number | null;
}

interface ItemRow {
  id: number;
  traspaso_id: number;
  producto_id: number;
  talla_id: number;
  color_id: number;
  cantidad: number;
}

const shape = (t: TransferRow) => ({
  id: t.id,
  referencia: transferRef(t.id),
  origen_id: t.sucursal_origen_id,
  destino_id: t.sucursal_destino_id,
  estado: t.estado,
  responsable: t.responsable,
  notas: t.observaciones,
  fecha: iso(t.fecha),
  enviado_at: iso(t.enviado_at),
  recibido_at: iso(t.recibido_at),
  cancelado_at: iso(t.cancelado_at),
  creado_por: t.creado_por,
  despachado_por: t.despachado_por,
  recibido_por: t.recibido_por,
  cancelado_por: t.cancelado_por,
});

const COLUMNS =
  "id, sucursal_origen_id, sucursal_destino_id, estado, responsable, observaciones, fecha, enviado_at, recibido_at, cancelado_at, creado_por, despachado_por, recibido_por, cancelado_por";

/** Un vendedor solo ve los traspasos donde su sucursal es origen o destino. */
function visibility(user: AuthUser) {
  return user.rol === "admin"
    ? { sql: `WHERE ${orgBranchesSql(user, "sucursal_origen_id")} AND ${orgBranchesSql(user, "sucursal_destino_id")}`, binds: [] as unknown[] }
    : { sql: "WHERE sucursal_origen_id = ? OR sucursal_destino_id = ?", binds: [user.sucursal_id, user.sucursal_id] };
}

export async function listTransfers(env: Env, user: AuthUser): Promise<Response> {
  const v = visibility(user);
  const { results } = await env.DB
    .prepare(`SELECT ${COLUMNS} FROM traspasos ${v.sql} ORDER BY id DESC LIMIT 100`)
    .bind(...v.binds)
    .all<TransferRow>();
  return ok(results.map(shape));
}

export async function listTransferItems(env: Env, user: AuthUser): Promise<Response> {
  const v = visibility(user);
  const { results } = await env.DB
    .prepare(
      `SELECT d.id, d.traspaso_id, d.producto_id, d.talla_id, d.color_id, d.cantidad
         FROM traspaso_detalles d
        WHERE d.traspaso_id IN (SELECT id FROM (SELECT id FROM traspasos ${v.sql} ORDER BY id DESC LIMIT 100))
        ORDER BY d.id`,
    )
    .bind(...v.binds)
    .all<ItemRow>();
  return ok(results);
}

// ---------------------------------------------------------------- historial y detalle

interface HistoryRow extends TransferRow {
  origen_nombre: string;
  destino_nombre: string;
  creado_por_nombre: string | null;
  despachado_por_nombre: string | null;
  recibido_por_nombre: string | null;
  cancelado_por_nombre: string | null;
}

interface DetailLine {
  traspaso_id: number;
  producto_id: number;
  producto: string;
  talla_id: number;
  talla: string;
  color_id: number;
  color: string;
  cantidad: number;
}

const user = (id: number | null, nombre: string | null) => (id === null ? null : { id, nombre: nombre ?? "No registrado" });

function historyShape(r: HistoryRow, lines: DetailLine[]) {
  const items = lines.filter((l) => l.traspaso_id === r.id).map(({ traspaso_id: _t, ...rest }) => { void _t; return rest; });
  return {
    ...shape(r),
    origen: { id: r.sucursal_origen_id, nombre: r.origen_nombre },
    destino: { id: r.sucursal_destino_id, nombre: r.destino_nombre },
    // Los usuarios solo existen en traspasos nuevos: en los antiguos queda null (la interfaz muestra "No registrado").
    creado_por: user(r.creado_por, r.creado_por_nombre),
    despachado_por: user(r.despachado_por, r.despachado_por_nombre),
    recibido_por: user(r.recibido_por, r.recibido_por_nombre),
    cancelado_por: user(r.cancelado_por, r.cancelado_por_nombre),
    items,
    unidades: items.reduce((a, i) => a + i.cantidad, 0),
  };
}

const HISTORY_SELECT = `
  SELECT t.id, t.sucursal_origen_id, t.sucursal_destino_id, t.estado, t.responsable, t.observaciones, t.fecha,
         t.enviado_at, t.recibido_at, t.cancelado_at, t.creado_por, t.despachado_por, t.recibido_por, t.cancelado_por,
         so.nombre AS origen_nombre, sd.nombre AS destino_nombre,
         uc.nombre AS creado_por_nombre, ud.nombre AS despachado_por_nombre,
         ur.nombre AS recibido_por_nombre, ux.nombre AS cancelado_por_nombre
    FROM traspasos t
    JOIN sucursales so ON so.id = t.sucursal_origen_id
    JOIN sucursales sd ON sd.id = t.sucursal_destino_id
    LEFT JOIN usuarios uc ON uc.id = t.creado_por
    LEFT JOIN usuarios ud ON ud.id = t.despachado_por
    LEFT JOIN usuarios ur ON ur.id = t.recibido_por
    LEFT JOIN usuarios ux ON ux.id = t.cancelado_por`;

async function linesOf(env: Env, ids: number[]): Promise<DetailLine[]> {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  const { results } = await env.DB
    .prepare(
      `SELECT d.traspaso_id, d.producto_id, p.nombre AS producto, d.talla_id, ta.nombre AS talla, d.color_id, c.nombre AS color, d.cantidad
         FROM traspaso_detalles d
         JOIN productos p ON p.id = d.producto_id
         JOIN tallas ta ON ta.id = d.talla_id
         JOIN colores c ON c.id = d.color_id
        WHERE d.traspaso_id IN (${marks}) ORDER BY d.id`,
    )
    .bind(...ids)
    .all<DetailLine>();
  return results;
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Historial de traspasos con filtros combinables y paginación. Cada fila trae todas sus líneas
 * (modelo, talla, color, cantidad) y quién creó, despachó y recibió. Un vendedor solo ve su sucursal.
 */
export async function history(url: URL, env: Env, me: AuthUser): Promise<Response> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (me.rol !== "admin") {
    where.push("(t.sucursal_origen_id = ? OR t.sucursal_destino_id = ?)");
    binds.push(me.sucursal_id, me.sucursal_id);
  } else {
    const branch = scopedBranch(me, queryInt(url, "sucursal_id"));
    if (branch !== null) {
      where.push("(t.sucursal_origen_id = ? OR t.sucursal_destino_id = ?)");
      binds.push(branch, branch);
    } else {
      where.push(`${orgBranchesSql(me, "t.sucursal_origen_id")} AND ${orgBranchesSql(me, "t.sucursal_destino_id")}`);
    }
  }

  const origen = queryInt(url, "origen_id");
  if (origen !== null) { where.push("t.sucursal_origen_id = ?"); binds.push(origen); }
  const destino = queryInt(url, "destino_id");
  if (destino !== null) { where.push("t.sucursal_destino_id = ?"); binds.push(destino); }

  const estado = url.searchParams.get("estado");
  if (estado) {
    if (!["pendiente", "enviado", "recibido", "cancelado"].includes(estado)) throw badRequest("estado inválido.");
    where.push("t.estado = ?");
    binds.push(estado);
  }

  const desde = queryDate(url, "desde");
  if (desde) { where.push("date(t.fecha, '-4 hours') >= ?"); binds.push(desde); }
  const hasta = queryDate(url, "hasta");
  if (hasta) { where.push("date(t.fecha, '-4 hours') <= ?"); binds.push(hasta); }

  const usuario = queryInt(url, "usuario_id");
  if (usuario !== null) {
    where.push("(t.creado_por = ? OR t.despachado_por = ? OR t.recibido_por = ? OR t.cancelado_por = ?)");
    binds.push(usuario, usuario, usuario, usuario);
  }

  const variantFilters: string[] = [];
  const variantBinds: unknown[] = [];
  for (const [param, column] of [["producto_id", "producto_id"], ["talla_id", "talla_id"], ["color_id", "color_id"]] as const) {
    const value = queryInt(url, param);
    if (value !== null) { variantFilters.push(`d.${column} = ?`); variantBinds.push(value); }
  }
  if (variantFilters.length) {
    where.push(`EXISTS (SELECT 1 FROM traspaso_detalles d WHERE d.traspaso_id = t.id AND ${variantFilters.join(" AND ")})`);
    binds.push(...variantBinds);
  }

  const q = (url.searchParams.get("q") ?? "").trim();
  if (q) {
    if (q.length > 80) throw badRequest("La búsqueda es demasiado larga.");
    const ref = parseRef(q);
    const clauses = [
      "t.responsable LIKE ? ESCAPE '\\'", "t.observaciones LIKE ? ESCAPE '\\'",
      "uc.nombre LIKE ? ESCAPE '\\'", "ud.nombre LIKE ? ESCAPE '\\'", "ur.nombre LIKE ? ESCAPE '\\'",
      `EXISTS (SELECT 1 FROM traspaso_detalles d JOIN productos p ON p.id = d.producto_id
                JOIN tallas ta ON ta.id = d.talla_id JOIN colores c ON c.id = d.color_id
               WHERE d.traspaso_id = t.id AND (p.nombre LIKE ? ESCAPE '\\' OR ta.nombre LIKE ? ESCAPE '\\' OR c.nombre LIKE ? ESCAPE '\\'))`,
    ];
    const vals: unknown[] = [like(q), like(q), like(q), like(q), like(q), like(q), like(q), like(q)];
    if (ref && (ref.kind === null || ref.kind === "TR")) {
      clauses.push("t.id = ?");
      vals.push(ref.id);
    }
    where.push(`(${clauses.join(" OR ")})`);
    binds.push(...vals);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limite = Math.min(queryInt(url, "limite") ?? 25, 100);
  const pagina = Math.max(queryInt(url, "pagina") ?? 1, 1);

  const [rows, total, units] = await env.DB.batch([
    env.DB.prepare(`${HISTORY_SELECT} ${whereSql} ORDER BY t.id DESC LIMIT ? OFFSET ?`).bind(...binds, limite, (pagina - 1) * limite),
    env.DB
      .prepare(`SELECT COUNT(*) AS n FROM traspasos t LEFT JOIN usuarios uc ON uc.id = t.creado_por LEFT JOIN usuarios ud ON ud.id = t.despachado_por
                  LEFT JOIN usuarios ur ON ur.id = t.recibido_por ${whereSql}`)
      .bind(...binds),
    env.DB
      .prepare(`SELECT COALESCE(SUM(d.cantidad), 0) AS n FROM traspaso_detalles d
                 WHERE d.traspaso_id IN (SELECT t.id FROM traspasos t LEFT JOIN usuarios uc ON uc.id = t.creado_por
                   LEFT JOIN usuarios ud ON ud.id = t.despachado_por LEFT JOIN usuarios ur ON ur.id = t.recibido_por ${whereSql})`)
      .bind(...binds),
  ]);

  const list = rows.results as unknown as HistoryRow[];
  const lines = await linesOf(env, list.map((r) => r.id));
  return ok({
    filas: list.map((r) => historyShape(r, lines)),
    total: (total.results[0] as { n: number }).n,
    unidades: (units.results[0] as { n: number }).n,
    pagina,
    limite,
  });
}

/** Detalle de un traspaso con sus líneas y los movimientos de inventario que generó. */
export async function detail(env: Env, me: AuthUser, id: number): Promise<Response> {
  const row = await env.DB.prepare(`${HISTORY_SELECT} WHERE t.id = ?`).bind(id).first<HistoryRow>();
  if (!row) throw notFound("Traspaso no encontrado.");
  if (me.rol !== "admin" && me.sucursal_id !== row.sucursal_origen_id && me.sucursal_id !== row.sucursal_destino_id) {
    throw notFound("Traspaso no encontrado.");
  }
  const lines = await linesOf(env, [id]);
  const { results: movimientos } = await env.DB
    .prepare(
      `SELECT m.id, m.created_at, m.categoria, m.signo, m.cantidad, m.cantidad_anterior, m.cantidad_resultante, m.referencia_tipo,
              s.nombre AS sucursal, p.nombre AS producto, t.nombre AS talla, c.nombre AS color, u.nombre AS usuario
         FROM movimientos_inventario m
         JOIN sucursales s ON s.id = m.sucursal_id JOIN productos p ON p.id = m.producto_id
         JOIN tallas t ON t.id = m.talla_id JOIN colores c ON c.id = m.color_id
         LEFT JOIN usuarios u ON u.id = m.usuario_id
        WHERE m.referencia_tipo IN ('traspaso', 'traspaso_cancelado') AND m.referencia_id = ? ORDER BY m.id`,
    )
    .bind(id)
    .all<Record<string, unknown>>();
  // Lotes: de qué lote salió cada unidad y en qué lote quedó en el destino (misma fecha de recepción).
  const { results: lotes } = await env.DB
    .prepare(
      `SELECT lm.tipo, lm.cantidad, lm.referencia_tipo, COALESCE(l.lote_raiz_id, l.id) AS raiz_id, l.id AS lote_id, l.fecha_recepcion,
              s.nombre AS sucursal, p.nombre AS producto, t.nombre AS talla, c.nombre AS color
         FROM lote_movimientos lm JOIN lotes l ON l.id = lm.lote_id JOIN sucursales s ON s.id = l.sucursal_id
         JOIN productos p ON p.id = l.producto_id JOIN tallas t ON t.id = l.talla_id JOIN colores c ON c.id = l.color_id
        WHERE lm.traspaso_id = ? ORDER BY lm.id`,
    )
    .bind(id)
    .all<Record<string, unknown>>();
  return ok({
    ...historyShape(row, lines),
    movimientos: movimientos.map((m) => ({ ...m, fecha: iso(m.created_at as string), created_at: undefined, usuario: m.usuario ?? null })),
    lotes: lotes.map((l) => ({
      ...l,
      codigo: lotRef(l.raiz_id as number),
      fecha_recepcion: iso(l.fecha_recepcion as string | null),
    })),
  });
}

// ---------------------------------------------------------------- altas y transiciones

async function getOrFail(env: Env, id: number): Promise<TransferRow> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM traspasos WHERE id = ?`).bind(id).first<TransferRow>();
  if (!row) throw notFound("Traspaso no encontrado.");
  return row;
}

async function getItems(env: Env, id: number): Promise<ItemRow[]> {
  const { results } = await env.DB
    .prepare("SELECT id, traspaso_id, producto_id, talla_id, color_id, cantidad FROM traspaso_detalles WHERE traspaso_id = ? ORDER BY id")
    .bind(id)
    .all<ItemRow>();
  return results;
}

export async function createTransfer(request: Request, env: Env, me: AuthUser): Promise<Response> {
  const body = await readJson(request);
  const key = uuid(body.idempotency_key, "idempotency_key");
  const origin = int(body.origen_id, "origen_id");
  const destination = int(body.destino_id, "destino_id");

  if (origin === destination) throw badRequest("El origen y el destino deben ser distintos.");
  requireBranch(me, origin); // el vendedor solo envía desde su propia sucursal

  // El responsable es el usuario autenticado; el texto del cliente solo se acepta como nota de quién entrega físicamente.
  const responsable = optionalStr(body.responsable, "responsable", 120) ?? me.nombre;
  const notas = optionalStr(body.notas, "notas", 300);

  const repeated = await env.DB.prepare("SELECT id FROM traspasos WHERE idempotency_key = ?").bind(key).first<{ id: number }>();
  if (repeated) return ok({ id: repeated.id, referencia: transferRef(repeated.id), repetido: true });

  const branches = await env.DB
    // Origen y destino deben ser sucursales activas de LA MISMA organización que el usuario.
    .prepare("SELECT COUNT(*) AS n FROM sucursales WHERE id IN (?, ?) AND activa = 1 AND organizacion_id = ?")
    .bind(origin, destination, me.organizacion_id)
    .first<{ n: number }>();
  if (branches?.n !== 2) throw badRequest("Sucursal inexistente o inactiva.");

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
    throw badRequest("items debe tener entre 1 y 100 productos.");
  }

  const seen = new Set<string>();
  const items = (body.items as unknown[]).map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw badRequest(`items[${i}] inválido.`);
    const e = entry as Record<string, unknown>;
    const it = {
      producto: int(e.producto_id, `items[${i}].producto_id`),
      talla: int(e.talla_id, `items[${i}].talla_id`),
      color: int(e.color_id, `items[${i}].color_id`),
      qty: int(e.cantidad, `items[${i}].cantidad`, 1, 10_000),
    };
    const k = `${it.producto}-${it.talla}-${it.color}`;
    if (seen.has(k)) throw badRequest("Hay líneas repetidas de la misma variante.");
    seen.add(k);
    return it;
  });

  // Mover stock que ya existe: un color desactivado no impide traspasarlo (el historial no se rompe).
  await validateVariants(env, items, "items", true);

  const byKey = "(SELECT id FROM traspasos WHERE idempotency_key = ?)";
  try {
    await env.DB.batch([
      env.DB
        .prepare(
          "INSERT INTO traspasos (sucursal_origen_id, sucursal_destino_id, estado, responsable, observaciones, idempotency_key, creado_por) VALUES (?, ?, 'pendiente', ?, ?, ?, ?)",
        )
        .bind(origin, destination, responsable, notas, key, me.id),
      ...items.map((it) =>
        env.DB
          .prepare(`INSERT INTO traspaso_detalles (traspaso_id, producto_id, talla_id, color_id, cantidad) VALUES (${byKey}, ?, ?, ?, ?)`)
          .bind(key, it.producto, it.talla, it.color, it.qty),
      ),
    ]);
  } catch (err) {
    if (isUniqueViolation(err, "idempotency_key")) {
      const dup = await env.DB.prepare("SELECT id FROM traspasos WHERE idempotency_key = ?").bind(key).first<{ id: number }>();
      if (dup) return ok({ id: dup.id, referencia: transferRef(dup.id), repetido: true });
    }
    throw err;
  }

  const created = await env.DB.prepare("SELECT id FROM traspasos WHERE idempotency_key = ?").bind(key).first<{ id: number }>();
  await audit(env, me.id, "traspaso_crear", "traspasos", created?.id ?? null, `${items.length} líneas`);
  return ok({ id: created?.id, referencia: created ? transferRef(created.id) : null, repetido: false });
}

type Action = "despachar" | "recibir" | "cancelar";

/**
 * Transiciones de estado (pendiente = borrador → enviado → recibido; cancelado desde pendiente o enviado).
 * Cada una es un único lote atómico:
 *  - la primera sentencia cambia el estado solo si el estado actual es el esperado, marca un token único y guarda
 *    quién lo hizo;
 *  - las siguientes mueven stock y escriben el libro solo si ese token quedó escrito (es decir, si ESTA llamada ganó);
 *  - si el stock del origen no alcanza, el CHECK (cantidad >= 0) revierte todo el lote.
 * Repetir o cruzar llamadas nunca descuenta ni suma dos veces. Un borrador no reserva ni descuenta stock.
 */
export async function transition(env: Env, me: AuthUser, id: number, action: Action): Promise<Response> {
  const t = await getOrFail(env, id);

  if (action === "recibir") requireBranch(me, t.sucursal_destino_id);
  else requireBranch(me, t.sucursal_origen_id);

  const items = await getItems(env, id);
  const token = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  let stateGuard: string;

  const base = { usuarioId: me.id, refTipo: "traspaso", refIdSql: "?", refIdBinds: [id], origenId: t.sucursal_origen_id, destinoId: t.sucursal_destino_id };

  if (action === "despachar") {
    if (t.estado !== "pendiente") throw conflict(`Solo se puede despachar un traspaso pendiente (estado actual: ${t.estado}).`);
    statements.push(
      env.DB
        .prepare("UPDATE traspasos SET estado = 'enviado', enviado_at = CURRENT_TIMESTAMP, despachado_por = ?, op_token = ? WHERE id = ? AND estado = 'pendiente'")
        .bind(me.id, token, id),
    );
    stateGuard = "EXISTS (SELECT 1 FROM traspasos WHERE id = ? AND op_token = ? AND estado = 'enviado')";
    for (const it of items) {
      statements.push(
        ...stockChange(
          env,
          { ...base, sucursal: t.sucursal_origen_id, producto: it.producto_id, talla: it.talla_id, color: it.color_id, qty: it.cantidad, categoria: "TRASPASO", signo: -1, tipo: "traspaso_salida", observaciones: `Traspaso ${transferRef(id)}: salida hacia el destino`, lote: { traspasoId: id } },
          stateGuard,
          [id, token],
        ),
      );
    }
  } else if (action === "recibir") {
    if (t.estado !== "enviado") throw conflict(`Solo se puede recibir un traspaso enviado (estado actual: ${t.estado}).`);
    statements.push(
      env.DB
        .prepare("UPDATE traspasos SET estado = 'recibido', recibido_at = CURRENT_TIMESTAMP, recibido_por = ?, op_token = ? WHERE id = ? AND estado = 'enviado'")
        .bind(me.id, token, id),
    );
    stateGuard = "EXISTS (SELECT 1 FROM traspasos WHERE id = ? AND op_token = ? AND estado = 'recibido')";
    for (const it of items) {
      statements.push(
        ...stockChange(
          env,
          { ...base, sucursal: t.sucursal_destino_id, producto: it.producto_id, talla: it.talla_id, color: it.color_id, qty: it.cantidad, categoria: "TRASPASO", signo: 1, tipo: "traspaso_entrada", observaciones: `Traspaso ${transferRef(id)}: entrada desde el origen`, lote: { desdeTraspaso: { traspasoId: id, origenSucursal: t.sucursal_origen_id } } },
          stateGuard,
          [id, token],
        ),
      );
    }
  } else {
    if (t.estado === "recibido" || t.estado === "cancelado") throw conflict(`No se puede cancelar un traspaso ${t.estado}.`);
    statements.push(
      env.DB
        .prepare("UPDATE traspasos SET estado = 'cancelado', cancelado_at = CURRENT_TIMESTAMP, cancelado_por = ?, op_token = ? WHERE id = ? AND estado IN ('pendiente', 'enviado')")
        .bind(me.id, token, id),
    );
    // Si ya estaba enviado, el stock salió del origen: se devuelve.
    stateGuard = "EXISTS (SELECT 1 FROM traspasos WHERE id = ? AND op_token = ? AND estado = 'cancelado' AND enviado_at IS NOT NULL)";
    if (t.estado === "enviado") {
      for (const it of items) {
        statements.push(
          ...stockChange(
            env,
            { ...base, refTipo: "traspaso_cancelado", sucursal: t.sucursal_origen_id, producto: it.producto_id, talla: it.talla_id, color: it.color_id, qty: it.cantidad, categoria: "TRASPASO", signo: 1, tipo: "ajuste", observaciones: `Traspaso ${transferRef(id)} cancelado: devolución al origen`, lote: { restaurar: { traspasoId: id, origenResto: "traspaso" } } },
            stateGuard,
            [id, token],
          ),
        );
      }
    }
  }

  let results: D1Result[];
  try {
    results = await env.DB.batch(statements);
  } catch (err) {
    // Stock o lotes insuficientes, o la variante no existe en el origen: el lote entero se revirtió.
    if (isStockViolation(err) || isAssertionFailure(err)) {
      throw conflict("Stock insuficiente en la sucursal de origen. El traspaso sigue pendiente y no se movió nada.");
    }
    throw err;
  }

  if (results[0].meta.changes === 0) {
    throw conflict("El traspaso cambió de estado mientras se procesaba. No se movió stock.");
  }

  await audit(env, me.id, `traspaso_${action}`, "traspasos", id, null);
  const fresh = await getOrFail(env, id);
  return ok(shape(fresh));
}
