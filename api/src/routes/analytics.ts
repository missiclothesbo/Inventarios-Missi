/**
 * Reportes analíticos calculados en la base de datos (nunca en el navegador).
 *
 * Reglas de conteo (documentadas también en ARCHITECTURE.md):
 *  - VENTAS: solo ventas `completada`. Unidades e ingresos salen de `detalle_venta` (cada línea una sola vez);
 *    "ventas" es COUNT(DISTINCT venta) para que una venta con varias líneas cuente una vez.
 *  - DEVOLUCIONES/CAMBIOS se informan APARTE (por fecha de la operación) y nunca se mezclan con las unidades vendidas.
 *    Neto = vendido − devuelto (devolución o cambio) del mismo periodo. Los reemplazos de un cambio NO son una venta.
 *  - TRASPASOS: movimientos internos; jamás suman ingresos ni unidades vendidas ni existencias totales de la empresa.
 *  - Fechas: día calendario de Bolivia (UTC-4), extremos incluidos. Sin desde/hasta = todo el historial.
 */
import { orgBranchesSql, scopedBranch, type AuthUser } from "../auth";
import { badRequest, ok, type Env } from "../http";
import { optionalStr, queryDate, queryInt } from "../validate";
import { SALE_JOINS, lineFilter, saleFilters } from "./sales";
import {
  DEPARTMENTS,
  MOVEMENT_CATEGORIES,
  MOVEMENT_LABELS,
  RETURN_REASONS,
  RETURN_REASON_LABELS,
  SIZE_RELATED_REASONS,
  canonicalDepartment,
  departmentKey,
} from "../../../shared/catalogo";

interface Scope {
  desde: string | null;
  hasta: string | null;
  branch: number | null;
  /** Condición SQL de las sucursales de la organización del usuario (se usa en las vistas consolidadas). */
  org: (column: string) => string;
}

function readScope(url: URL, me: AuthUser): Scope {
  const desde = queryDate(url, "desde");
  const hasta = queryDate(url, "hasta");
  if (desde && hasta && desde > hasta) throw badRequest("La fecha inicial no puede ser posterior a la final.");
  return { desde, hasta, branch: scopedBranch(me, queryInt(url, "sucursal_id")), org: (column) => orgBranchesSql(me, column) };
}

/** Condiciones de fecha y sucursal sobre columnas dadas. */
function scopeWhere(scope: Scope, dateCol: string, branchCol: string | null) {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (scope.desde) { where.push(`date(${dateCol}, '-4 hours') >= ?`); binds.push(scope.desde); }
  if (scope.hasta) { where.push(`date(${dateCol}, '-4 hours') <= ?`); binds.push(scope.hasta); }
  if (branchCol && scope.branch !== null) { where.push(`${branchCol} = ?`); binds.push(scope.branch); }
  else if (branchCol) where.push(scope.org(branchCol));
  return { where, binds };
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

async function rows<T = Record<string, unknown>>(env: Env, sql: string, binds: unknown[] = []): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
}

// ================================================================ modelos más vendidos

export async function modelos(url: URL, env: Env, me: AuthUser): Promise<Response> {
  const scope = readScope(url, me);
  const limite = Math.min(queryInt(url, "limite") ?? 20, 50);
  const categoria = optionalStr(url.searchParams.get("categoria"), "categoria", 60);

  const variant: string[] = [];
  const variantBinds: unknown[] = [];
  for (const [param, col] of [["producto_id", "dv.producto_id"], ["talla_id", "dv.talla_id"], ["color_id", "dv.color_id"]] as const) {
    const value = queryInt(url, param);
    if (value !== null) { variant.push(`${col} = ?`); variantBinds.push(value); }
  }
  if (categoria) { variant.push("p.categoria = ?"); variantBinds.push(categoria); }

  // Mismos filtros que la lista de ventas (fechas, sucursal u organización, pago, entrega, departamento, provincia, municipio, responsable).
  const sf = saleFilters(url, me, true);
  const sfOps = saleFilters(url, me, true, { skipDates: true });
  const whereSql = `${sf.whereSql}${variant.map((c) => ` AND ${c}`).join("")}`;
  const binds = [...sf.binds, ...variantBinds];
  const base = `FROM detalle_venta dv JOIN ventas v ON v.id = dv.venta_id JOIN productos p ON p.id = dv.producto_id ${SALE_JOINS}`;

  const [models, totals] = await Promise.all([
    rows<{ producto_id: number; producto: string; unidades: number; ventas: number; ingresos: number }>(
      env,
      `SELECT p.id AS producto_id, p.nombre AS producto, SUM(dv.cantidad) AS unidades, COUNT(DISTINCT v.id) AS ventas,
              ROUND(SUM(dv.subtotal), 2) AS ingresos
         ${base} ${whereSql} GROUP BY p.id ORDER BY unidades DESC, ingresos DESC, p.nombre LIMIT ?`,
      [...binds, limite],
    ),
    rows<{ ventas: number; unidades: number; ingresos: number }>(
      env,
      `SELECT COUNT(DISTINCT v.id) AS ventas, COALESCE(SUM(dv.cantidad), 0) AS unidades, ROUND(COALESCE(SUM(dv.subtotal), 0), 2) AS ingresos
         ${base} ${whereSql}`,
      binds,
    ),
  ]);

  const ids = models.map((m) => m.producto_id);
  const inIds = ids.length ? `AND dv.producto_id IN (${marks(ids.length)})` : "AND 0 = 1";

  // Granularidad de la tendencia: diaria si el rango es corto y conocido; si no, mensual.
  const days = scope.desde && scope.hasta ? Math.round((Date.parse(scope.hasta) - Date.parse(scope.desde)) / 86_400_000) + 1 : null;
  const granularidad = days !== null && days <= 92 ? "dia" : "mes";
  const bucket = granularidad === "dia" ? "date(v.fecha, '-4 hours')" : "strftime('%Y-%m', v.fecha, '-4 hours')";

  const [bySize, byColor, byBranch, trend, returned] = await Promise.all([
    rows<{ producto_id: number; talla: string; unidades: number }>(
      env,
      `SELECT dv.producto_id, t.nombre AS talla, SUM(dv.cantidad) AS unidades ${base} JOIN tallas t ON t.id = dv.talla_id
        ${whereSql} ${inIds} GROUP BY dv.producto_id, t.id ORDER BY t.orden`,
      [...binds, ...ids],
    ),
    rows<{ producto_id: number; color: string; unidades: number }>(
      env,
      `SELECT dv.producto_id, c.nombre AS color, SUM(dv.cantidad) AS unidades ${base} JOIN colores c ON c.id = dv.color_id
        ${whereSql} ${inIds} GROUP BY dv.producto_id, c.id ORDER BY unidades DESC, c.nombre`,
      [...binds, ...ids],
    ),
    rows<{ producto_id: number; sucursal: string; unidades: number; ventas: number; ingresos: number }>(
      env,
      `SELECT dv.producto_id, s.nombre AS sucursal, SUM(dv.cantidad) AS unidades, COUNT(DISTINCT v.id) AS ventas, ROUND(SUM(dv.subtotal), 2) AS ingresos
         ${base} JOIN sucursales s ON s.id = v.sucursal_id ${whereSql} ${inIds} GROUP BY dv.producto_id, s.id ORDER BY s.id`,
      [...binds, ...ids],
    ),
    rows<{ producto_id: number; clave: string; unidades: number }>(
      env,
      `SELECT dv.producto_id, ${bucket} AS clave, SUM(dv.cantidad) AS unidades ${base} ${whereSql} ${inIds}
        GROUP BY dv.producto_id, clave ORDER BY clave`,
      [...binds, ...ids],
    ),
    returnedUnits(env, scope, sfOps, variant.map((c) => c.replace("dv.", "oi.")), variantBinds, ids),
  ]);

  const totalReturned = (await returnedUnits(env, scope, sfOps, variant.map((c) => c.replace("dv.", "oi.")), variantBinds, null)).reduce(
    (a, r) => a + r.devueltas,
    0,
  );
  const returnedBy = new Map(returned.map((r) => [r.producto_id, r]));

  return ok({
    filtros: { ...scope, granularidad, limite, categoria },
    definiciones: {
      unidades: "Suma de cantidades de las líneas de ventas completadas (una venta con 3 unidades cuenta 3 unidades, no 3 ventas).",
      ventas: "Ventas distintas que contienen el modelo (una venta con varias líneas del mismo modelo cuenta una vez).",
      ingresos: "Suma de los subtotales de las líneas del modelo. No incluye devoluciones ni traspasos.",
      devueltas: "Unidades del modelo devueltas o cambiadas en el periodo (por fecha de la operación).",
      netas: "unidades − devueltas. Los reemplazos entregados en un cambio no se cuentan como venta.",
    },
    totales: {
      ventas: totals[0]?.ventas ?? 0,
      unidades: totals[0]?.unidades ?? 0,
      ingresos: totals[0]?.ingresos ?? 0,
      unidades_devueltas: totalReturned,
      unidades_netas: (totals[0]?.unidades ?? 0) - totalReturned,
    },
    modelos: models.map((m) => {
      const r = returnedBy.get(m.producto_id);
      return {
        ...m,
        devueltas: r?.devueltas ?? 0,
        cambios_entregados: r?.entregadas ?? 0,
        netas: m.unidades - (r?.devueltas ?? 0),
        por_talla: bySize.filter((x) => x.producto_id === m.producto_id).map(({ producto_id: _p, ...rest }) => { void _p; return rest; }),
        por_color: byColor.filter((x) => x.producto_id === m.producto_id).map(({ producto_id: _p, ...rest }) => { void _p; return rest; }),
        por_sucursal: byBranch.filter((x) => x.producto_id === m.producto_id).map(({ producto_id: _p, ...rest }) => { void _p; return rest; }),
        tendencia: trend.filter((x) => x.producto_id === m.producto_id).map(({ producto_id: _p, ...rest }) => { void _p; return rest; }),
      };
    }),
  });
}

/** Unidades devueltas (devolución o cambio) y entregadas por cambio, por modelo, para ventas completadas. */
async function returnedUnits(env: Env, scope: Scope, sf: { whereSql: string; binds: unknown[] }, variantClauses: string[], variantBinds: unknown[], ids: number[] | null) {
  const saleConds = sf.whereSql.replace(/^WHERE /, "");
  const op = scopeWhere(scope, "o.created_at", "o.sucursal_id");
  const idClause = ids === null ? "" : ids.length ? `AND oi.producto_id IN (${marks(ids.length)})` : "AND 0 = 1";
  return rows<{ producto_id: number; devueltas: number; entregadas: number }>(
    env,
    `SELECT oi.producto_id,
            COALESCE(SUM(CASE WHEN oi.rol = 'devuelto' THEN oi.cantidad ELSE 0 END), 0) AS devueltas,
            COALESCE(SUM(CASE WHEN oi.rol = 'entregado' THEN oi.cantidad ELSE 0 END), 0) AS entregadas
       FROM operacion_items oi
       JOIN operaciones o ON o.id = oi.operacion_id
       JOIN ventas v ON v.id = o.venta_id
       JOIN productos p ON p.id = oi.producto_id
       ${SALE_JOINS}
      WHERE v.estado = 'completada' AND o.tipo IN ('devolucion', 'cambio')${[...op.where, ...variantClauses].map((c) => ` AND ${c}`).join("")}
        AND ${saleConds} ${idClause}
      GROUP BY oi.producto_id`,
    [...op.binds, ...variantBinds, ...sf.binds, ...(ids ?? [])],
  );
}

// ================================================================ envíos por departamento

interface ShippingGroup {
  depto_raw: string;
  sucursal_id: number;
  sucursal: string;
  pedidos: number;
  unidades: number;
  ingresos: number;
}

async function shippingGroups(env: Env, scope: Scope, sf: { whereSql: string; binds: unknown[] }, line: { sql: string; binds: unknown[] }, lineOps: { sql: string; binds: unknown[] }): Promise<{ groups: ShippingGroup[]; operations: { depto_raw: string; sucursal_id: number; devuelto: number; entregado: number }[]; directas: number }> {
  const saleConds = sf.whereSql.replace(/^WHERE /, "");
  // Un pedido = una venta con destino de envío registrado. Las ventas de entrega directa no tienen destino y se excluyen.
  const groups = await rows<ShippingGroup>(
    env,
    `SELECT TRIM(COALESCE(dep.nombre, d.departamento_manual, '')) AS depto_raw, v.sucursal_id, s.nombre AS sucursal,
            COUNT(*) AS pedidos, COALESCE(SUM(u.unidades), 0) AS unidades,
            ROUND(SUM(${line.sql ? "COALESCE(u.monto, 0)" : "v.total"}), 2) AS ingresos
       FROM ventas v
       JOIN destinos_entrega d ON d.id = v.destino_id
       LEFT JOIN departamentos dep ON dep.id = d.departamento_id
       JOIN sucursales s ON s.id = v.sucursal_id
       LEFT JOIN (SELECT dv.venta_id, SUM(dv.cantidad) AS unidades, SUM(dv.subtotal) AS monto FROM detalle_venta dv
                   ${line.sql ? `WHERE ${line.sql}` : ""} GROUP BY dv.venta_id) u ON u.venta_id = v.id
      WHERE v.tipo_entrega IN ('interdepartamental', 'interprovincial') AND ${saleConds}
      GROUP BY depto_raw, v.sucursal_id ORDER BY depto_raw`,
    [...line.binds, ...sf.binds],
  );

  const op = scopeWhere(scope, "o.created_at", "o.sucursal_id");
  const opSql = op.where.length ? ` AND ${op.where.join(" AND ")}` : "";
  // Neto: sin filtro de modelo/talla/color se usa el valor de la operación; con filtro, solo las líneas que coinciden.
  const operations = lineOps.sql
    ? await rows<{ depto_raw: string; sucursal_id: number; devuelto: number; entregado: number }>(
        env,
        `SELECT TRIM(COALESCE(dep.nombre, d.departamento_manual, '')) AS depto_raw, o.sucursal_id,
                COALESCE(SUM(CASE WHEN oi.rol = 'devuelto' THEN oi.cantidad * oi.precio_unitario ELSE 0 END), 0) AS devuelto,
                COALESCE(SUM(CASE WHEN oi.rol = 'entregado' AND o.tipo = 'cambio' THEN oi.cantidad * oi.precio_unitario ELSE 0 END), 0) AS entregado
           FROM operacion_items oi
           JOIN operaciones o ON o.id = oi.operacion_id
           JOIN ventas v ON v.id = o.venta_id
           JOIN destinos_entrega d ON d.id = v.destino_id
           LEFT JOIN departamentos dep ON dep.id = d.departamento_id
          WHERE o.tipo IN ('devolucion', 'cambio') AND v.tipo_entrega IN ('interdepartamental', 'interprovincial')
            AND ${saleConds} AND ${lineOps.sql}${opSql}
          GROUP BY depto_raw, o.sucursal_id`,
        [...sf.binds, ...lineOps.binds, ...op.binds],
      )
    : await rows<{ depto_raw: string; sucursal_id: number; devuelto: number; entregado: number }>(
        env,
        `SELECT TRIM(COALESCE(dep.nombre, d.departamento_manual, '')) AS depto_raw, o.sucursal_id,
                COALESCE(SUM(o.valor_devuelto), 0) AS devuelto,
                COALESCE(SUM(CASE WHEN o.tipo = 'cambio' THEN o.valor_entregado ELSE 0 END), 0) AS entregado
           FROM operaciones o
           JOIN ventas v ON v.id = o.venta_id
           JOIN destinos_entrega d ON d.id = v.destino_id
           LEFT JOIN departamentos dep ON dep.id = d.departamento_id
          WHERE o.tipo IN ('devolucion', 'cambio') AND v.tipo_entrega IN ('interdepartamental', 'interprovincial')
            AND ${saleConds}${opSql}
          GROUP BY depto_raw, o.sucursal_id`,
        [...sf.binds, ...op.binds],
      );

  const direct = await rows<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n FROM ventas v ${SALE_JOINS}
      WHERE (v.destino_id IS NULL OR v.tipo_entrega = 'directa') AND ${saleConds}`,
    sf.binds,
  );

  return { groups, operations, directas: direct[0]?.n ?? 0 };
}

interface DepartmentRow {
  departamento: string;
  reconocido: boolean;
  pedidos: number;
  unidades: number;
  ingresos_brutos: number;
  devuelto: number;
  entregado: number;
  ingresos_netos: number;
  /** Valor promedio por pedido (venta bruta / pedidos); null si el departamento no tiene pedidos. */
  ticket_promedio: number | null;
  por_sucursal: { sucursal: string; sucursal_id: number; pedidos: number; unidades: number; ingresos: number }[];
  posicion: number;
}

/** Agrupa por departamento oficial (sin tildes ni mayúsculas); lo no reconocido se conserva aparte para revisión. */
function foldDepartments(data: Awaited<ReturnType<typeof shippingGroups>>): DepartmentRow[] {
  const map = new Map<string, DepartmentRow>();
  const entry = (raw: string): DepartmentRow => {
    const official = canonicalDepartment(raw);
    const label = official ?? (raw === "" ? "Sin departamento registrado" : raw);
    const key = official ?? `x:${departmentKey(raw)}`;
    let e = map.get(key);
    if (!e) {
      e = { departamento: label, reconocido: official !== null, pedidos: 0, unidades: 0, ingresos_brutos: 0, devuelto: 0, entregado: 0, ingresos_netos: 0, ticket_promedio: null, por_sucursal: [], posicion: 0 };
      map.set(key, e);
    }
    return e;
  };

  for (const d of DEPARTMENTS) entry(d); // los 9 siempre aparecen (con 0 si no tienen pedidos)

  for (const g of data.groups) {
    const e = entry(g.depto_raw);
    e.pedidos += g.pedidos;
    e.unidades += g.unidades;
    e.ingresos_brutos += g.ingresos;
    const b = e.por_sucursal.find((x) => x.sucursal_id === g.sucursal_id);
    if (b) { b.pedidos += g.pedidos; b.unidades += g.unidades; b.ingresos = round2(b.ingresos + g.ingresos); }
    else e.por_sucursal.push({ sucursal: g.sucursal, sucursal_id: g.sucursal_id, pedidos: g.pedidos, unidades: g.unidades, ingresos: round2(g.ingresos) });
  }
  for (const o of data.operations) {
    const e = entry(o.depto_raw);
    e.devuelto += o.devuelto;
    e.entregado += o.entregado;
  }

  const list = [...map.values()].map((e) => ({
    ...e,
    ingresos_brutos: round2(e.ingresos_brutos),
    devuelto: round2(e.devuelto),
    entregado: round2(e.entregado),
    ingresos_netos: round2(e.ingresos_brutos - e.devuelto + e.entregado),
    ticket_promedio: e.pedidos > 0 ? round2(e.ingresos_brutos / e.pedidos) : null,
  }));
  list.sort((a, b) => b.pedidos - a.pedidos || b.unidades - a.unidades || b.ingresos_brutos - a.ingresos_brutos || a.departamento.localeCompare(b.departamento, "es"));
  list.forEach((e, i) => { e.posicion = i + 1; });
  return list;
}

export async function envios(url: URL, env: Env, me: AuthUser): Promise<Response> {
  const scope = readScope(url, me);
  const sf = saleFilters(url, me, true);
  const sfAll = saleFilters(url, me, true, { skipDates: true });
  const line = lineFilter(url);
  const lineOps = lineFilter(url, "oi");
  const current = await shippingGroups(env, scope, sf, line, lineOps);
  const rowsNow = foldDepartments(current);

  // Con un periodo elegido se agrega el ranking de todo el historial para comparar (misma sucursal).
  const hasRange = scope.desde !== null || scope.hasta !== null;
  const allTime = hasRange ? foldDepartments(await shippingGroups(env, { ...scope, desde: null, hasta: null }, sfAll, line, lineOps)) : rowsNow;
  const allPos = new Map(allTime.map((e) => [e.departamento, e]));

  const dept = (name: string) => rowsNow.find((e) => e.departamento === name);
  const top = (key: "pedidos" | "unidades" | "ingresos_brutos") => {
    const best = [...rowsNow].sort((a, b) => b[key] - a[key] || a.posicion - b.posicion)[0];
    return best && best[key] > 0 ? { departamento: best.departamento, valor: best[key] } : null;
  };

  return ok({
    filtros: scope,
    definiciones: {
      pedido: "Una venta completada con destino de envío registrado. Se cuenta una vez aunque tenga varias líneas.",
      unidades: "Suma de cantidades de todas las líneas de esos pedidos.",
      ingresos_brutos: "Suma del total de esos pedidos (el valor de la venta con envío; no hay costo de envío separado).",
      ingresos_netos: "ingresos brutos − valor devuelto + valor entregado por cambios (operaciones del periodo sobre esos pedidos).",
      departamento: "Se toma del destino guardado en la venta, nunca de la sucursal que vendió. Las ventas de entrega directa no cuentan.",
    },
    totales: {
      pedidos: rowsNow.reduce((a, e) => a + e.pedidos, 0),
      unidades: rowsNow.reduce((a, e) => a + e.unidades, 0),
      ingresos_brutos: round2(rowsNow.reduce((a, e) => a + e.ingresos_brutos, 0)),
      ingresos_netos: round2(rowsNow.reduce((a, e) => a + e.ingresos_netos, 0)),
      ticket_promedio: rowsNow.reduce((a, e) => a + e.pedidos, 0) > 0
        ? round2(rowsNow.reduce((a, e) => a + e.ingresos_brutos, 0) / rowsNow.reduce((a, e) => a + e.pedidos, 0))
        : null,
      ventas_sin_envio_excluidas: current.directas,
    },
    respuestas: {
      mas_pedidos: top("pedidos"),
      mas_unidades: top("unidades"),
      mas_ingresos: top("ingresos_brutos"),
      la_paz: dept("La Paz")?.pedidos ?? 0,
      oruro: dept("Oruro")?.pedidos ?? 0,
    },
    departamentos: rowsNow.map((e) => ({
      ...e,
      posicion_historica: allPos.get(e.departamento)?.posicion ?? null,
      pedidos_historicos: allPos.get(e.departamento)?.pedidos ?? 0,
    })),
    historico: hasRange ? allTime.map((e) => ({ departamento: e.departamento, pedidos: e.pedidos, unidades: e.unidades, posicion: e.posicion })) : null,
    // Valores que no coinciden con ningún departamento oficial: se muestran para revisar, no se descartan ni se reescriben.
    sin_reconocer: rowsNow.filter((e) => !e.reconocido && e.pedidos > 0).map((e) => ({ valor: e.departamento, pedidos: e.pedidos })),
  });
}

// ================================================================ resumen consolidado

async function returnsSection(env: Env, scope: Scope, me: AuthUser) {
  const op = scopeWhere(scope, "o.created_at", "o.sucursal_id");
  const opSql = op.where.length ? `WHERE ${op.where.join(" AND ")}` : "";
  const andOp = op.where.length ? ` AND ${op.where.join(" AND ")}` : "";

  const [count, units, reasons, models, byBranch, byUser] = await Promise.all([
    rows<{ devoluciones: number; cambios: number; anulaciones: number }>(
      env,
      `SELECT COALESCE(SUM(o.tipo = 'devolucion'), 0) AS devoluciones, COALESCE(SUM(o.tipo = 'cambio'), 0) AS cambios,
              COALESCE(SUM(o.tipo = 'anulacion'), 0) AS anulaciones FROM operaciones o ${opSql}`,
      op.binds,
    ),
    rows<{ tipo: string; rol: string; unidades: number }>(
      env,
      `SELECT o.tipo, oi.rol, SUM(oi.cantidad) AS unidades FROM operacion_items oi JOIN operaciones o ON o.id = oi.operacion_id
        ${opSql} GROUP BY o.tipo, oi.rol`,
      op.binds,
    ),
    rows<{ codigo: string | null; tipo: string; operaciones: number; unidades: number }>(
      env,
      `SELECT o.motivo_codigo AS codigo, o.tipo, COUNT(DISTINCT o.id) AS operaciones,
              COALESCE(SUM(CASE WHEN oi.rol = 'devuelto' THEN oi.cantidad ELSE 0 END), 0) AS unidades
         FROM operaciones o LEFT JOIN operacion_items oi ON oi.operacion_id = o.id ${opSql} GROUP BY o.motivo_codigo, o.tipo`,
      op.binds,
    ),
    rows<{ producto: string; unidades: number; operaciones: number }>(
      env,
      `SELECT p.nombre AS producto, SUM(oi.cantidad) AS unidades, COUNT(DISTINCT o.id) AS operaciones
         FROM operacion_items oi JOIN operaciones o ON o.id = oi.operacion_id JOIN productos p ON p.id = oi.producto_id
        WHERE oi.rol = 'devuelto' AND o.tipo IN ('devolucion', 'cambio')${andOp}
        GROUP BY p.id ORDER BY unidades DESC, p.nombre LIMIT 10`,
      op.binds,
    ),
    rows<{ sucursal: string; devoluciones: number; cambios: number; anulaciones: number }>(
      env,
      `SELECT s.nombre AS sucursal, COALESCE(SUM(o.tipo = 'devolucion'), 0) AS devoluciones, COALESCE(SUM(o.tipo = 'cambio'), 0) AS cambios,
              COALESCE(SUM(o.tipo = 'anulacion'), 0) AS anulaciones
         FROM operaciones o JOIN sucursales s ON s.id = o.sucursal_id ${opSql} GROUP BY s.id ORDER BY s.id`,
      op.binds,
    ),
    // Por responsable: solo para administradores (un vendedor no ve el desempeño de otros usuarios).
    me.rol === "admin"
      ? rows<{ usuario: string; operaciones: number }>(
          env,
          `SELECT u.nombre AS usuario, COUNT(*) AS operaciones FROM operaciones o JOIN usuarios u ON u.id = o.usuario_id ${opSql}
            GROUP BY u.id ORDER BY operaciones DESC, u.nombre`,
          op.binds,
        )
      : Promise.resolve(null),
  ]);

  const u = (tipo: string, rol: string) => units.find((x) => x.tipo === tipo && x.rol === rol)?.unidades ?? 0;
  const reasonRows = RETURN_REASONS.map((code) => ({
    codigo: code,
    etiqueta: RETURN_REASON_LABELS[code],
    devoluciones: reasons.filter((r) => r.codigo === code && r.tipo === "devolucion").reduce((a, r) => a + r.operaciones, 0),
    cambios: reasons.filter((r) => r.codigo === code && r.tipo === "cambio").reduce((a, r) => a + r.operaciones, 0),
    anulaciones: reasons.filter((r) => r.codigo === code && r.tipo === "anulacion").reduce((a, r) => a + r.operaciones, 0),
    unidades: reasons.filter((r) => r.codigo === code).reduce((a, r) => a + r.unidades, 0),
  }));
  const unclassified = reasons.filter((r) => r.codigo === null);
  reasonRows.push({
    codigo: "SIN_CLASIFICAR" as never,
    etiqueta: "Sin clasificar (registros anteriores)",
    devoluciones: unclassified.filter((r) => r.tipo === "devolucion").reduce((a, r) => a + r.operaciones, 0),
    cambios: unclassified.filter((r) => r.tipo === "cambio").reduce((a, r) => a + r.operaciones, 0),
    anulaciones: unclassified.filter((r) => r.tipo === "anulacion").reduce((a, r) => a + r.operaciones, 0),
    unidades: unclassified.reduce((a, r) => a + r.unidades, 0),
  });

  return {
    devoluciones: count[0]?.devoluciones ?? 0,
    cambios: count[0]?.cambios ?? 0,
    anulaciones: count[0]?.anulaciones ?? 0,
    unidades_devueltas: u("devolucion", "devuelto"),
    unidades_cambiadas: u("cambio", "devuelto"),
    unidades_entregadas_por_cambio: u("cambio", "entregado"),
    unidades_anuladas: u("anulacion", "devuelto"),
    por_motivo: reasonRows.filter((r) => r.devoluciones + r.cambios + r.anulaciones > 0),
    motivos_de_talla: reasonRows
      .filter((r) => (SIZE_RELATED_REASONS as readonly string[]).includes(r.codigo))
      .reduce((a, r) => a + r.devoluciones + r.cambios, 0),
    modelos_mas_devueltos: models,
    por_sucursal: byBranch,
    por_usuario: byUser,
  };
}

export async function resumen(url: URL, env: Env, me: AuthUser): Promise<Response> {
  const scope = readScope(url, me);
  const sale = scopeWhere(scope, "v.fecha", "v.sucursal_id");
  const saleWhere = `WHERE v.estado = 'completada'${sale.where.map((c) => ` AND ${c}`).join("")}`;
  const lineBase = `FROM detalle_venta dv JOIN ventas v ON v.id = dv.venta_id ${saleWhere}`;

  const tr = scopeWhere(scope, "t.fecha", null);
  const trWhere = [...tr.where];
  const trBinds = [...tr.binds];
  if (scope.branch !== null) {
    trWhere.push("(t.sucursal_origen_id = ? OR t.sucursal_destino_id = ?)");
    trBinds.push(scope.branch, scope.branch);
  } else {
    trWhere.push(`${scope.org("t.sucursal_origen_id")} AND ${scope.org("t.sucursal_destino_id")}`);
  }
  const trSql = trWhere.length ? `WHERE ${trWhere.join(" AND ")}` : "";
  const trAnd = trWhere.length ? ` AND ${trWhere.join(" AND ")}` : "";

  const mv = scopeWhere(scope, "m.created_at", "m.sucursal_id");
  const mvSql = mv.where.length ? `WHERE ${mv.where.join(" AND ")}` : "";

  const [salesTotals, byBranch, byModel, bySize, byColor, refunds, trTotals, trRoutes, trModels, trSizes, trColors, mvRows] = await Promise.all([
    // Ingresos = suma de ventas.total UNA vez por venta (pasar por las líneas multiplicaría el total).
    rows<{ ventas: number; ingresos: number }>(
      env,
      `SELECT COUNT(*) AS ventas, ROUND(COALESCE(SUM(v.total), 0), 2) AS ingresos FROM ventas v ${saleWhere}`,
      sale.binds,
    ),
    rows<{ sucursal: string; ventas: number; ingresos: number }>(
      env,
      `SELECT s.nombre AS sucursal, COUNT(*) AS ventas, ROUND(SUM(v.total), 2) AS ingresos
         FROM ventas v JOIN sucursales s ON s.id = v.sucursal_id ${saleWhere} GROUP BY s.id ORDER BY s.id`,
      sale.binds,
    ),
    rows<{ producto: string; unidades: number; ventas: number; ingresos: number }>(
      env,
      `SELECT p.nombre AS producto, SUM(dv.cantidad) AS unidades, COUNT(DISTINCT v.id) AS ventas, ROUND(SUM(dv.subtotal), 2) AS ingresos
         ${lineBase.replace("WHERE", "JOIN productos p ON p.id = dv.producto_id WHERE")} GROUP BY p.id ORDER BY unidades DESC, p.nombre LIMIT 10`,
      sale.binds,
    ),
    rows<{ talla: string; unidades: number }>(
      env,
      `SELECT t.nombre AS talla, SUM(dv.cantidad) AS unidades ${lineBase.replace("WHERE", "JOIN tallas t ON t.id = dv.talla_id WHERE")}
        GROUP BY t.id ORDER BY t.orden`,
      sale.binds,
    ),
    rows<{ color: string; unidades: number }>(
      env,
      `SELECT c.nombre AS color, SUM(dv.cantidad) AS unidades ${lineBase.replace("WHERE", "JOIN colores c ON c.id = dv.color_id WHERE")}
        GROUP BY c.id ORDER BY unidades DESC, c.nombre`,
      sale.binds,
    ),
    // Devoluciones y cambios (valor) del periodo: se informan aparte y restan solo en el neto.
    rows<{ devuelto: number; entregado: number }>(
      env,
      `SELECT COALESCE(SUM(o.valor_devuelto), 0) AS devuelto,
              COALESCE(SUM(CASE WHEN o.tipo = 'cambio' THEN o.valor_entregado ELSE 0 END), 0) AS entregado
         FROM operaciones o JOIN ventas v ON v.id = o.venta_id
        WHERE v.estado = 'completada' AND o.tipo IN ('devolucion', 'cambio')${(() => {
          const op = scopeWhere(scope, "o.created_at", "o.sucursal_id");
          return op.where.map((c) => ` AND ${c}`).join("");
        })()}`,
      scopeWhere(scope, "o.created_at", "o.sucursal_id").binds,
    ),
    rows<Record<string, number>>(
      env,
      `SELECT COUNT(*) AS referencias, COALESCE(SUM(t.estado = 'pendiente'), 0) AS pendientes, COALESCE(SUM(t.estado = 'enviado'), 0) AS enviados,
              COALESCE(SUM(t.estado = 'recibido'), 0) AS recibidos, COALESCE(SUM(t.estado = 'cancelado'), 0) AS cancelados
         FROM traspasos t ${trSql}`,
      trBinds,
    ),
    rows<{ origen: string; destino: string; traspasos: number; unidades: number }>(
      env,
      `SELECT so.nombre AS origen, sd.nombre AS destino, COUNT(DISTINCT t.id) AS traspasos, COALESCE(SUM(d.cantidad), 0) AS unidades
         FROM traspasos t JOIN sucursales so ON so.id = t.sucursal_origen_id JOIN sucursales sd ON sd.id = t.sucursal_destino_id
         LEFT JOIN traspaso_detalles d ON d.traspaso_id = t.id ${trSql} GROUP BY t.sucursal_origen_id, t.sucursal_destino_id ORDER BY so.id, sd.id`,
      trBinds,
    ),
    rows<{ producto: string; unidades: number }>(
      env,
      `SELECT p.nombre AS producto, SUM(d.cantidad) AS unidades FROM traspaso_detalles d JOIN traspasos t ON t.id = d.traspaso_id
         JOIN productos p ON p.id = d.producto_id WHERE t.estado <> 'cancelado'${trAnd} GROUP BY p.id ORDER BY unidades DESC, p.nombre LIMIT 10`,
      trBinds,
    ),
    rows<{ talla: string; unidades: number }>(
      env,
      `SELECT ta.nombre AS talla, SUM(d.cantidad) AS unidades FROM traspaso_detalles d JOIN traspasos t ON t.id = d.traspaso_id
         JOIN tallas ta ON ta.id = d.talla_id WHERE t.estado <> 'cancelado'${trAnd} GROUP BY ta.id ORDER BY ta.orden`,
      trBinds,
    ),
    rows<{ color: string; unidades: number }>(
      env,
      `SELECT c.nombre AS color, SUM(d.cantidad) AS unidades FROM traspaso_detalles d JOIN traspasos t ON t.id = d.traspaso_id
         JOIN colores c ON c.id = d.color_id WHERE t.estado <> 'cancelado'${trAnd} GROUP BY c.id ORDER BY unidades DESC, c.nombre`,
      trBinds,
    ),
    rows<{ categoria: string; signo: number | null; movimientos: number; unidades: number }>(
      env,
      `SELECT m.categoria, m.signo, COUNT(*) AS movimientos, SUM(m.cantidad) AS unidades FROM movimientos_inventario m ${mvSql}
        GROUP BY m.categoria, m.signo`,
      mv.binds,
    ),
  ]);

  const units = await rows<{ n: number }>(
    env,
    `SELECT COALESCE(SUM(d.cantidad), 0) AS n FROM traspaso_detalles d JOIN traspasos t ON t.id = d.traspaso_id ${trSql}`,
    trBinds,
  );
  const unitsReceived = await rows<{ n: number }>(
    env,
    `SELECT COALESCE(SUM(d.cantidad), 0) AS n FROM traspaso_detalles d JOIN traspasos t ON t.id = d.traspaso_id WHERE t.estado = 'recibido'${trAnd}`,
    trBinds,
  );

  const unitsSold = await rows<{ unidades: number }>(env, `SELECT COALESCE(SUM(dv.cantidad), 0) AS unidades ${lineBase}`, sale.binds);
  const salesRow = { ventas: salesTotals[0]?.ventas ?? 0, ingresos: salesTotals[0]?.ingresos ?? 0, unidades: unitsSold[0]?.unidades ?? 0 };
  const money = refunds[0] ?? { devuelto: 0, entregado: 0 };
  const returnsData = await returnsSection(env, scope, me);

  // Comparación con el periodo anterior de igual duración (solo si hay rango acotado).
  let anterior: unknown = null;
  if (scope.desde && scope.hasta) {
    const span = Math.round((Date.parse(scope.hasta) - Date.parse(scope.desde)) / 86_400_000) + 1;
    const prevHasta = new Date(Date.parse(scope.desde) - 86_400_000).toISOString().slice(0, 10);
    const prevDesde = new Date(Date.parse(prevHasta) - (span - 1) * 86_400_000).toISOString().slice(0, 10);
    const prev = await returnsSection(env, { ...scope, desde: prevDesde, hasta: prevHasta }, me);
    anterior = {
      desde: prevDesde,
      hasta: prevHasta,
      devoluciones: prev.devoluciones,
      cambios: prev.cambios,
      unidades_devueltas: prev.unidades_devueltas,
      unidades_cambiadas: prev.unidades_cambiadas,
    };
  }

  const mvSum = (cat: string, signo?: number) =>
    mvRows.filter((r) => r.categoria === cat && (signo === undefined || r.signo === signo)).reduce((a, r) => a + r.unidades, 0);
  const mvCount = (cat: string) => mvRows.filter((r) => r.categoria === cat).reduce((a, r) => a + r.movimientos, 0);

  return ok({
    filtros: scope,
    definiciones: {
      ingresos_brutos: "Suma de ventas.total de ventas completadas, una vez por venta.",
      ingresos_netos: "ingresos brutos − valor devuelto (devoluciones y cambios) + valor entregado en cambios, por fecha de la operación.",
      traspasos: "Movimientos internos entre sucursales: no son ventas ni ingresos y no cambian el stock total de la empresa.",
      movimientos: "Cada categoría se cuenta por separado; no se suman en una sola cifra.",
    },
    ventas: {
      completadas: salesRow.ventas,
      unidades: salesRow.unidades,
      ingresos_brutos: salesRow.ingresos,
      devoluciones_y_cambios_valor_devuelto: round2(money.devuelto),
      cambios_valor_entregado: round2(money.entregado),
      ingresos_netos: round2(salesRow.ingresos - money.devuelto + money.entregado),
      ticket_promedio: salesRow.ventas ? round2(salesRow.ingresos / salesRow.ventas) : 0,
      por_sucursal: byBranch,
      por_modelo: byModel,
      por_talla: bySize,
      por_color: byColor,
    },
    traspasos: {
      referencias: trTotals[0]?.referencias ?? 0,
      unidades: units[0]?.n ?? 0,
      unidades_recibidas: unitsReceived[0]?.n ?? 0,
      por_estado: {
        pendiente: trTotals[0]?.pendientes ?? 0,
        enviado: trTotals[0]?.enviados ?? 0,
        recibido: trTotals[0]?.recibidos ?? 0,
        cancelado: trTotals[0]?.cancelados ?? 0,
      },
      por_ruta: trRoutes,
      por_modelo: trModels,
      por_talla: trSizes,
      por_color: trColors,
    },
    devoluciones_y_cambios: { ...returnsData, periodo_anterior: anterior },
    movimientos: {
      por_categoria: MOVEMENT_CATEGORIES.map((c) => ({ categoria: c, etiqueta: MOVEMENT_LABELS[c], movimientos: mvCount(c), unidades: mvSum(c) })),
      unidades_ingresadas: mvSum("INGRESO"),
      unidades_vendidas: mvSum("VENTA"),
      cambio_unidades_entrantes: mvSum("CAMBIO", 1),
      cambio_unidades_salientes: mvSum("CAMBIO", -1),
      unidades_devueltas_al_stock: mvSum("DEVOLUCION", 1),
      unidades_en_cuarentena: mvSum("DEVOLUCION", 0) + mvSum("CAMBIO", 0),
      salidas_autorizadas: mvSum("SALIDA"),
      traspaso_unidades_salidas: mvSum("TRASPASO", -1),
      traspaso_unidades_entradas: mvSum("TRASPASO", 1),
      ajustes_positivos: mvSum("AJUSTE", 1),
      ajustes_negativos: mvSum("AJUSTE", -1),
    },
  });
}
