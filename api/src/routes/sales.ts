import { orgBranchesSql, requireBranch, scopedBranch, type AuthUser } from "../auth";
import {
  MODALIDAD_FROM_DB,
  MODALIDAD_TO_DB,
  PAGO_FROM_DB,
  PAGO_TO_DB,
  isStockViolation,
  isUniqueViolation,
  iso,
} from "../db";
import { stockChange } from "../inventory";
import { PANTS_SIZES, departmentKey, parseRef, saleRef, sizeAllowedForNewStock } from "../../../shared/catalogo";
import { badRequest, conflict, HttpError, notFound, ok, readJson, type Env } from "../http";
import { int, money, oneOf, optionalPhone, optionalStr, queryDate, queryInt, str, uuid } from "../validate";

export const SALE_SELECT = `
  SELECT v.id, v.fecha, v.total, v.sucursal_id, v.metodo_pago, v.tipo_entrega, v.estado,
         v.motivo_cancelacion, v.cliente_nombre, v.cliente_telefono, v.observaciones,
         (SELECT u.nombre FROM usuarios u WHERE u.id = v.vendedor_id) AS vendedor,
         COALESCE(dep.nombre, d.departamento_manual) AS departamento,
         d.ciudad, d.provincia, d.municipio, d.direccion, d.agencia_transporte, d.referencia AS referencias
    FROM ventas v
    LEFT JOIN destinos_entrega d ON d.id = v.destino_id
    LEFT JOIN departamentos dep ON dep.id = d.departamento_id`;

export interface SaleRow {
  id: number;
  fecha: string;
  total: number;
  sucursal_id: number;
  metodo_pago: string | null;
  tipo_entrega: string | null;
  estado: string;
  motivo_cancelacion: string | null;
  cliente_nombre: string | null;
  cliente_telefono: string | null;
  observaciones: string | null;
  vendedor: string | null;
  departamento: string | null;
  ciudad: string | null;
  provincia: string | null;
  municipio: string | null;
  direccion: string | null;
  agencia_transporte: string | null;
  referencias: string | null;
}

export function shapeSale(r: SaleRow) {
  return {
    id: r.id,
    fecha: iso(r.fecha),
    total: r.total,
    sucursal_id: r.sucursal_id,
    metodo_pago: r.metodo_pago ? (PAGO_FROM_DB[r.metodo_pago] ?? r.metodo_pago) : null,
    modalidad: r.tipo_entrega ? (MODALIDAD_FROM_DB[r.tipo_entrega] ?? r.tipo_entrega) : null,
    departamento: r.departamento,
    ciudad: r.ciudad,
    provincia: r.provincia,
    municipio: r.municipio,
    direccion: r.direccion,
    agencia_transporte: r.agencia_transporte,
    referencias: r.referencias,
    cliente_nombre: r.cliente_nombre,
    cliente_telefono: r.cliente_telefono,
    observaciones: r.observaciones,
    vendedor: r.vendedor,
    estado: r.estado,
    motivo_cancelacion: r.motivo_cancelacion,
  };
}

const likeParam = (text: string) => `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** Clave de comparación de departamentos en SQL: minúsculas, sin tildes y con espacios simples (no modifica los datos). */
export function departmentKeySql(column: string): string {
  let expr = `lower(trim(COALESCE(${column}, '')))`;
  for (const [a, b] of [["á", "a"], ["é", "e"], ["í", "i"], ["ó", "o"], ["ú", "u"], ["Á", "a"], ["É", "e"], ["Í", "i"], ["Ó", "o"], ["Ú", "u"], ["  ", " "], ["  ", " "]]) {
    expr = `replace(${expr}, '${a}', '${b}')`;
  }
  return expr;
}

/** Condición sobre UNA línea de venta (alias dv): modelo, talla y color. Vacío si no se pidió ninguno. */
export function lineFilter(url: URL, alias = "dv"): { sql: string; binds: unknown[] } {
  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const [param, column] of [["producto_id", "producto_id"], ["talla_id", "talla_id"], ["color_id", "color_id"]] as const) {
    const value = queryInt(url, param);
    if (value !== null) {
      parts.push(`${alias}.${column} = ?`);
      binds.push(value);
    }
  }
  return { sql: parts.join(" AND "), binds };
}

/** Filtros compartidos por el listado y los reportes. `v`, `d` y `dep` son los alias del SELECT. */
export function saleFilters(url: URL, user: AuthUser, onlyCompleted: boolean, opts: { skipDates?: boolean } = {}) {
  const where: string[] = [];
  const binds: unknown[] = [];

  const estado = url.searchParams.get("estado");
  if (onlyCompleted) where.push("v.estado = 'completada'");
  else if (estado) {
    where.push("v.estado = ?");
    binds.push(oneOf(estado, "estado", ["completada", "cancelada"] as const));
  }

  const branch = scopedBranch(user, queryInt(url, "sucursal_id"));
  if (branch !== null) {
    where.push("v.sucursal_id = ?");
    binds.push(branch);
  } else {
    where.push(orgBranchesSql(user, "v.sucursal_id"));
  }

  // Fechas en hora de Bolivia (UTC-4, sin horario de verano).
  if (!opts.skipDates) {
    const from = queryDate(url, "desde");
    const to = queryDate(url, "hasta");
    if (from && to && from > to) throw badRequest("La fecha inicial no puede ser posterior a la final.");
    const desde = queryDate(url, "desde");
    if (desde) {
      where.push("date(v.fecha, '-4 hours') >= ?");
      binds.push(desde);
    }
    const hasta = queryDate(url, "hasta");
    if (hasta) {
      where.push("date(v.fecha, '-4 hours') <= ?");
      binds.push(hasta);
    }
  }

  const pago = url.searchParams.get("metodo_pago");
  if (pago) {
    where.push("v.metodo_pago = ?");
    binds.push(PAGO_TO_DB[oneOf(pago, "metodo_pago", ["QR", "efectivo"] as const)]);
  }

  const modalidad = url.searchParams.get("modalidad");
  if (modalidad) {
    where.push("v.tipo_entrega = ?");
    binds.push(MODALIDAD_TO_DB[oneOf(modalidad, "modalidad", ["entrega_directa", "envio", "envio_interprovincial"] as const)]);
  }

  // Departamento de DESTINO guardado en la venta (nunca el de la sucursal). Se compara sin tildes ni mayúsculas, sin reescribir el dato.
  const depto = url.searchParams.get("departamento");
  if (depto) {
    if (depto === "SIN_REGISTRAR") {
      where.push(`v.tipo_entrega IN ('interdepartamental', 'interprovincial') AND TRIM(COALESCE(dep.nombre, d.departamento_manual, '')) = ''`);
    } else {
      where.push(`${departmentKeySql("COALESCE(dep.nombre, d.departamento_manual)")} = ?`);
      binds.push(departmentKey(str(depto, "departamento", 60)));
    }
  }

  const provincia = url.searchParams.get("provincia");
  if (provincia) {
    where.push("d.provincia LIKE ? ESCAPE '\\'");
    binds.push(likeParam(str(provincia, "provincia", 100)));
  }
  const municipio = url.searchParams.get("municipio");
  if (municipio) {
    where.push("d.municipio LIKE ? ESCAPE '\\'");
    binds.push(likeParam(str(municipio, "municipio", 100)));
  }

  const usuario = queryInt(url, "usuario_id");
  if (usuario !== null) {
    where.push("v.vendedor_id = ?");
    binds.push(usuario);
  }

  // Modelo, talla y color deben coincidir en la MISMA línea de la venta.
  const line = lineFilter(url);
  if (line.sql) {
    where.push(`EXISTS (SELECT 1 FROM detalle_venta dv WHERE dv.venta_id = v.id AND ${line.sql})`);
    binds.push(...line.binds);
  }

  // Referencia (V-000123 o 123) y cliente (nombre o teléfono).
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q) {
    if (q.length > 80) throw badRequest("La búsqueda es demasiado larga.");
    const clauses = ["v.cliente_nombre LIKE ? ESCAPE '\\'", "v.cliente_telefono LIKE ? ESCAPE '\\'"];
    const vals: unknown[] = [likeParam(q), likeParam(q)];
    const ref = parseRef(q);
    if (ref && (ref.kind === null || ref.kind === "V")) {
      clauses.push("v.id = ?");
      vals.push(ref.id);
    }
    where.push(`(${clauses.join(" OR ")})`);
    binds.push(...vals);
  }

  return { whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

export async function listSales(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const { whereSql, binds } = saleFilters(url, user, false);
  const limit = Math.min(queryInt(url, "limit") ?? 50, 500);

  const { results } = await env.DB
    .prepare(`${SALE_SELECT} ${whereSql} ORDER BY v.fecha DESC, v.id DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<SaleRow>();

  return ok(results.map(shapeSale));
}

export const SALE_JOINS = `LEFT JOIN destinos_entrega d ON d.id = v.destino_id LEFT JOIN departamentos dep ON dep.id = d.departamento_id`;

/**
 * Ventas con TODOS los filtros combinados (intersección), paginadas en el servidor, con sus líneas y totales.
 * Los totales usan los mismos filtros que la lista, así que cuadran con los reportes.
 * Pago: el sistema solo registra el método (QR o efectivo); no existe un estado de pago de la venta, por eso no hay filtro de estado de pago.
 */
export async function salesHistory(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const { whereSql, binds } = saleFilters(url, user, false);
  const limite = Math.min(queryInt(url, "limite") ?? 25, 100);
  const pagina = Math.max(queryInt(url, "pagina") ?? 1, 1);
  const line = lineFilter(url);

  const completed = `${whereSql ? `${whereSql} AND` : "WHERE"} v.estado = 'completada'`;
  const [rows, count, lines] = await env.DB.batch([
    env.DB
      .prepare(`${SALE_SELECT} ${whereSql} ORDER BY v.fecha DESC, v.id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limite, (pagina - 1) * limite),
    env.DB
      .prepare(
        `SELECT COUNT(*) AS ventas, COALESCE(SUM(v.estado = 'completada'), 0) AS completadas,
                ROUND(COALESCE(SUM(CASE WHEN v.estado = 'completada' THEN v.total END), 0), 2) AS ingresos
           FROM ventas v ${SALE_JOINS} ${whereSql}`,
      )
      .bind(...binds),
    env.DB
      .prepare(
        `SELECT COALESCE(SUM(dv.cantidad), 0) AS unidades, ROUND(COALESCE(SUM(dv.subtotal), 0), 2) AS ingresos_lineas
           FROM detalle_venta dv JOIN ventas v ON v.id = dv.venta_id ${SALE_JOINS}
           ${completed}${line.sql ? ` AND ${line.sql}` : ""}`,
      )
      .bind(...binds, ...line.binds),
  ]);

  const list = rows.results as unknown as SaleRow[];
  const ids = list.map((r) => r.id);
  let items: { venta_id: number; producto: string; talla: string; color: string; cantidad: number; precio_unitario: number; subtotal: number }[] = [];
  if (ids.length > 0) {
    items = (
      await env.DB
        .prepare(
          `SELECT dv.venta_id, p.nombre AS producto, t.nombre AS talla, c.nombre AS color, dv.cantidad, dv.precio_unitario, dv.subtotal
             FROM detalle_venta dv JOIN productos p ON p.id = dv.producto_id JOIN tallas t ON t.id = dv.talla_id JOIN colores c ON c.id = dv.color_id
            WHERE dv.venta_id IN (${ids.map(() => "?").join(",")}) ORDER BY dv.id`,
        )
        .bind(...ids)
        .all<(typeof items)[number]>()
    ).results;
  }
  const { results: branches } = await env.DB.prepare("SELECT id, nombre FROM sucursales").all<{ id: number; nombre: string }>();
  const branchName = new Map(branches.map((b) => [b.id, b.nombre]));
  const c = count.results[0] as { ventas: number; completadas: number; ingresos: number };
  const l = lines.results[0] as { unidades: number; ingresos_lineas: number };

  return ok({
    filas: list.map((r) => {
      const own = items.filter((i) => i.venta_id === r.id).map(({ venta_id: _v, ...rest }) => { void _v; return rest; });
      return {
        ...shapeSale(r),
        referencia: saleRef(r.id),
        sucursal: branchName.get(r.sucursal_id) ?? null,
        items: own,
        unidades: own.reduce((a, i) => a + i.cantidad, 0),
      };
    }),
    total: c.ventas,
    pagina,
    limite,
    // Totales de las ventas COMPLETADAS que cumplen los filtros. Con filtro de modelo/talla/color, ingresos y unidades salen de las líneas que coinciden.
    totales: {
      ventas: c.completadas,
      unidades: l.unidades,
      ingresos: line.sql ? l.ingresos_lineas : c.ingresos,
      base: line.sql ? "lineas" : "ventas",
    },
  });
}

export async function getSaleOrFail(env: Env, id: number): Promise<SaleRow> {
  const row = await env.DB.prepare(`${SALE_SELECT} WHERE v.id = ?`).bind(id).first<SaleRow>();
  if (!row) throw notFound("Venta no encontrada.");
  return row;
}

/** Recibo de una venta confirmada: datos reales de la base (nunca se inventan). */
export async function saleReceipt(env: Env, id: number, repetida: boolean) {
  const sale = await getSaleOrFail(env, id);
  const branch = await env.DB.prepare("SELECT nombre FROM sucursales WHERE id = ?").bind(sale.sucursal_id).first<{ nombre: string }>();
  const { results: items } = await env.DB
    .prepare(
      `SELECT d.cantidad, d.precio_unitario, d.subtotal, p.nombre AS producto, t.nombre AS talla, c.nombre AS color
         FROM detalle_venta d
         JOIN productos p ON p.id = d.producto_id
         JOIN tallas t ON t.id = d.talla_id
         JOIN colores c ON c.id = d.color_id
        WHERE d.venta_id = ? ORDER BY d.id`,
    )
    .bind(id)
    .all<{ cantidad: number; precio_unitario: number; subtotal: number; producto: string; talla: string; color: string }>();

  return { ...shapeSale(sale), sucursal: branch?.nombre ?? null, items, repetida };
}

export async function saleDetails(env: Env, user: AuthUser, id: number): Promise<Response> {
  const sale = await getSaleOrFail(env, id);
  requireBranch(user, sale.sucursal_id);

  const { results } = await env.DB
    .prepare(
      `SELECT id, venta_id, producto_id, talla_id, color_id, cantidad, precio_unitario, subtotal
         FROM detalle_venta WHERE venta_id = ? ORDER BY id`,
    )
    .bind(id)
    .all();
  return ok(results);
}

interface Line {
  producto: number;
  talla: number;
  color: number;
  qty: number;
  price: number;
}

export async function createSale(request: Request, env: Env, user: AuthUser): Promise<Response> {
  const body = await readJson(request);

  const key = uuid(body.idempotency_key, "idempotency_key");
  const branch = int(body.sucursal_id, "sucursal_id");
  requireBranch(user, branch);

  const metodo = oneOf(body.metodo_pago, "metodo_pago", ["QR", "efectivo"] as const);
  const modalidad = oneOf(body.modalidad, "modalidad", ["entrega_directa", "envio", "envio_interprovincial"] as const);

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
    throw badRequest("items debe tener entre 1 y 100 productos.");
  }

  // --- repetición con la misma clave: devuelve la venta original sin tocar nada
  const existing = await env.DB.prepare("SELECT id, total, sucursal_id FROM ventas WHERE idempotency_key = ?").bind(key).first<{ id: number; total: number; sucursal_id: number }>();
  if (existing) {
    requireBranch(user, existing.sucursal_id);
    return ok(await saleReceipt(env, existing.id, true));
  }

  // --- destino
  let destination: D1PreparedStatement | null = null;
  const referencia = optionalStr(body.referencias, "referencias", 300);
  const telefono = optionalPhone(body.cliente_telefono);
  const observaciones = optionalStr(body.observaciones, "observaciones", 300);

  if (modalidad === "envio") {
    const depto = str(body.departamento, "departamento", 60);
    const dep = await env.DB.prepare("SELECT id FROM departamentos WHERE nombre = ? AND estado = 1").bind(depto).first<{ id: number }>();
    if (!dep) throw badRequest("Departamento no válido (usa uno de los 9 departamentos de Bolivia).");
    destination = env.DB
      .prepare(
        `INSERT INTO destinos_entrega (tipo_entrega, departamento_id, ciudad, direccion, referencia)
         VALUES ('interdepartamental', ?, ?, ?, ?)`,
      )
      .bind(dep.id, optionalStr(body.ciudad, "ciudad", 100), optionalStr(body.direccion, "direccion", 300), referencia);
  } else if (modalidad === "envio_interprovincial") {
    destination = env.DB
      .prepare(
        `INSERT INTO destinos_entrega
           (tipo_entrega, departamento_manual, provincia, municipio, direccion, agencia_transporte, referencia)
         VALUES ('interprovincial', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        optionalStr(body.departamento, "departamento", 60),
        str(body.provincia, "provincia", 100),
        optionalStr(body.municipio, "municipio", 100),
        optionalStr(body.direccion, "direccion", 300),
        optionalStr(body.agencia_transporte, "agencia_transporte", 100),
        referencia,
      );
  }

  // --- líneas: validar catálogo, stock y precio (precio_venta del modelo si no se envía)
  const seen = new Set<string>();
  const raw = (body.items as unknown[]).map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw badRequest(`items[${i}] inválido.`);
    const e = entry as Record<string, unknown>;
    const line = {
      producto: int(e.producto_id, `items[${i}].producto_id`),
      talla: int(e.talla_id, `items[${i}].talla_id`),
      color: int(e.color_id, `items[${i}].color_id`),
      qty: int(e.cantidad, `items[${i}].cantidad`, 1, 10_000),
      price: e.precio_unitario === undefined || e.precio_unitario === null ? null : money(e.precio_unitario, `items[${i}].precio_unitario`),
    };
    const k = `${line.producto}-${line.talla}-${line.color}`;
    if (seen.has(k)) throw badRequest("Hay líneas repetidas de la misma variante; agrúpalas en una sola línea.");
    seen.add(k);
    return line;
  });

  const checks = await env.DB.batch(
    raw.map((l) =>
      env.DB
        .prepare(
          `SELECT p.precio_venta, p.categoria, i.cantidad, p.nombre AS producto, t.nombre AS talla, c.nombre AS color
             FROM productos p
             JOIN tallas t ON t.id = ?
             JOIN colores c ON c.id = ?
             LEFT JOIN inventario i ON i.producto_id = p.id AND i.talla_id = t.id AND i.color_id = c.id AND i.sucursal_id = ?
            WHERE p.id = ? AND p.activo = 1`,
        )
        .bind(l.talla, l.color, branch, l.producto),
    ),
  );

  const lines: Line[] = raw.map((l, i) => {
    const row = checks[i].results[0] as
      | { precio_venta: number; categoria: string; cantidad: number | null; producto: string; talla: string; color: string }
      | undefined;
    if (!row) throw badRequest(`Producto ${i + 1} de la venta: ese modelo, talla o color ya no existe o fue desactivado.`);
    if (!sizeAllowedForNewStock(row.categoria, row.talla)) {
      throw badRequest(`${row.producto}: la talla «${row.talla}» no es una talla de pantalón válida (${PANTS_SIZES.join(", ")}).`);
    }
    if ((row.cantidad ?? 0) < l.qty) {
      throw conflict(
        `Stock insuficiente para ${row.producto} · talla ${row.talla} · ${row.color}. Disponible: ${row.cantidad ?? 0}. Solicitado: ${l.qty}. No se guardó ninguna parte de la venta.`,
      );
    }
    const price = l.price ?? row.precio_venta;
    if (!(price > 0)) throw badRequest(`${row.producto}: escribe el precio de venta (este modelo no tiene precio guardado).`);
    return { producto: l.producto, talla: l.talla, color: l.color, qty: l.qty, price };
  });

  // --- lote atómico (una transacción): destino, venta, stock, detalle, total, movimientos
  const byKey = "(SELECT id FROM ventas WHERE idempotency_key = ?)";
  const statements: D1PreparedStatement[] = [];

  if (destination) statements.push(destination);

  statements.push(
    env.DB
      .prepare(
        `INSERT INTO ventas (sucursal_id, total, metodo_pago, tipo_entrega, estado, cliente_nombre, cliente_telefono, destino_id, idempotency_key, vendedor_id, observaciones)
         VALUES (?, 0, ?, ?, 'completada', ?, ?, ${destination ? "last_insert_rowid()" : "NULL"}, ?, ?, ?)`,
      )
      .bind(
        branch,
        PAGO_TO_DB[metodo],
        MODALIDAD_TO_DB[modalidad],
        optionalStr(body.cliente_nombre, "cliente_nombre", 120),
        telefono,
        key,
        user.id,
        observaciones,
      ),
  );

  for (const l of lines) {
    // La línea se registra primero para que cada unidad descontada quede enlazada a ella y al lote del que salió.
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO detalle_venta (venta_id, producto_id, talla_id, color_id, cantidad, precio_unitario, subtotal)
           VALUES (${byKey}, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(key, l.producto, l.talla, l.color, l.qty, l.price, Math.round(l.qty * l.price * 100) / 100),
      // Lotes más antiguos primero (FIFO); stockChange revierte todo si los lotes o la fila de stock no alcanzan.
      ...stockChange(env, {
        sucursal: branch, producto: l.producto, talla: l.talla, color: l.color, qty: l.qty,
        categoria: "VENTA", signo: -1, tipo: "venta", usuarioId: user.id,
        refTipo: "venta", refIdSql: byKey, refIdBinds: [key], observaciones: null,
        lote: {
          detalleVentaSql: `(SELECT id FROM detalle_venta WHERE venta_id = ${byKey} AND producto_id = ? AND talla_id = ? AND color_id = ?)`,
          detalleVentaBinds: [key, l.producto, l.talla, l.color],
        },
      }),
    );
  }

  statements.push(
    env.DB
      .prepare("UPDATE ventas SET total = (SELECT ROUND(SUM(subtotal), 2) FROM detalle_venta WHERE venta_id = ventas.id) WHERE idempotency_key = ?")
      .bind(key),
  );

  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err, "idempotency_key")) {
      const dup = await env.DB.prepare("SELECT id, total FROM ventas WHERE idempotency_key = ?").bind(key).first<{ id: number; total: number }>();
      if (dup) return ok(await saleReceipt(env, dup.id, true));
    }
    if (isStockViolation(err) || /operacion_validacion|CHECK constraint failed: ok/i.test(String((err as Error)?.message ?? err))) {
      throw conflict("Stock insuficiente: otra operación consumió el stock mientras se registraba la venta. No se guardó nada ni se descontó inventario.");
    }
    throw err;
  }

  const created = await env.DB.prepare("SELECT id, total FROM ventas WHERE idempotency_key = ?").bind(key).first<{ id: number; total: number }>();
  if (!created) throw new HttpError(500, "No se pudo confirmar la venta.");
  return ok(await saleReceipt(env, created.id, false));
}

