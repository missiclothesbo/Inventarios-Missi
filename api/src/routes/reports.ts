import { orgBranchesSql, scopedBranch, type AuthUser } from "../auth";
import { MODALIDAD_FROM_DB, PAGO_FROM_DB } from "../db";
import { ok, type Env } from "../http";
import { queryDate, queryInt } from "../validate";
import { saleFilters } from "./sales";
import { canonicalDepartment } from "../../../shared/catalogo";

interface Group {
  clave: string;
  ventas: number;
  ingresos: number;
}

const FROM = `FROM ventas v
  LEFT JOIN destinos_entrega d ON d.id = v.destino_id
  LEFT JOIN departamentos dep ON dep.id = d.departamento_id`;

/** Agrupa por departamento oficial (sin distinguir mayúsculas/tildes/espacios); la entrega directa va aparte. */
function foldDepartments(groups: Group[]): Group[] {
  const out = new Map<string, Group>();
  for (const g of groups) {
    const label = g.clave === "__DIRECTA__" ? "Entrega directa" : (canonicalDepartment(g.clave) ?? (g.clave || "Sin departamento registrado"));
    const e = out.get(label) ?? { clave: label, ventas: 0, ingresos: 0 };
    e.ventas += g.ventas;
    e.ingresos = Math.round((e.ingresos + g.ingresos) * 100) / 100;
    out.set(label, e);
  }
  return [...out.values()].sort((a, b) => a.clave.localeCompare(b.clave, "es"));
}

/**
 * Balance real. Ingresos = suma de ventas.total de ventas COMPLETADAS (una fila por venta: los JOIN a destino
 * son 1:1, así que no se duplica). Las unidades y los productos salen de detalle_venta en consultas aparte.
 * Los traspasos se informan en su propia sección y nunca suman ingresos.
 */
export async function balance(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const { whereSql, binds } = saleFilters(url, user, true);

  const q = (sql: string) => env.DB.prepare(sql).bind(...binds);

  const branch = scopedBranch(user, queryInt(url, "sucursal_id"));
  const desde = queryDate(url, "desde");
  const hasta = queryDate(url, "hasta");
  const trWhere: string[] = [];
  const trBinds: unknown[] = [];
  if (branch !== null) {
    trWhere.push("(sucursal_origen_id = ? OR sucursal_destino_id = ?)");
    trBinds.push(branch, branch);
  } else if (user.rol !== "admin") {
    trWhere.push("1 = 0");
  } else {
    trWhere.push(`${orgBranchesSql(user, "sucursal_origen_id")} AND ${orgBranchesSql(user, "sucursal_destino_id")}`);
  }
  if (desde) {
    trWhere.push("date(fecha, '-4 hours') >= ?");
    trBinds.push(desde);
  }
  if (hasta) {
    trWhere.push("date(fecha, '-4 hours') <= ?");
    trBinds.push(hasta);
  }
  const trSql = trWhere.length ? `WHERE ${trWhere.join(" AND ")}` : "";

  const [summary, units, byPay, byBranch, byDept, byMode, byDay, top, transfers, trUnits, byHour, byWeek, byMonth] = await env.DB.batch([
    q(`SELECT COUNT(*) AS ventas, COALESCE(ROUND(SUM(v.total), 2), 0) AS ingresos ${FROM} ${whereSql}`),
    q(`SELECT COALESCE(SUM(dv.cantidad), 0) AS unidades FROM detalle_venta dv JOIN ventas v ON v.id = dv.venta_id
         LEFT JOIN destinos_entrega d ON d.id = v.destino_id LEFT JOIN departamentos dep ON dep.id = d.departamento_id ${whereSql}`),
    q(`SELECT v.metodo_pago AS k, COUNT(*) AS ventas, ROUND(SUM(v.total), 2) AS ingresos ${FROM} ${whereSql} GROUP BY v.metodo_pago ORDER BY k`),
    q(`SELECT s.nombre AS k, COUNT(*) AS ventas, ROUND(SUM(v.total), 2) AS ingresos ${FROM} JOIN sucursales s ON s.id = v.sucursal_id ${whereSql} GROUP BY s.nombre ORDER BY k`),
    q(`SELECT CASE WHEN v.destino_id IS NULL OR v.tipo_entrega = 'directa' THEN '__DIRECTA__' ELSE TRIM(COALESCE(dep.nombre, d.departamento_manual, '')) END AS k, COUNT(*) AS ventas, ROUND(SUM(v.total), 2) AS ingresos ${FROM} ${whereSql} GROUP BY k ORDER BY k`),
    q(`SELECT v.tipo_entrega AS k, COUNT(*) AS ventas, ROUND(SUM(v.total), 2) AS ingresos ${FROM} ${whereSql} GROUP BY v.tipo_entrega ORDER BY k`),
    q(`SELECT date(v.fecha, '-4 hours') AS k, COUNT(*) AS ventas, ROUND(SUM(v.total), 2) AS ingresos ${FROM} ${whereSql} GROUP BY k ORDER BY k`),
    q(`SELECT p.nombre AS producto, SUM(dv.cantidad) AS unidades, ROUND(SUM(dv.subtotal), 2) AS ingresos
         FROM detalle_venta dv JOIN ventas v ON v.id = dv.venta_id JOIN productos p ON p.id = dv.producto_id
         LEFT JOIN destinos_entrega d ON d.id = v.destino_id LEFT JOIN departamentos dep ON dep.id = d.departamento_id
         ${whereSql} GROUP BY p.nombre ORDER BY unidades DESC, ingresos DESC LIMIT 10`),
    env.DB
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(estado = 'pendiente'), 0) AS pendientes, COALESCE(SUM(estado = 'enviado'), 0) AS enviados,
                COALESCE(SUM(estado = 'recibido'), 0) AS recibidos, COALESCE(SUM(estado = 'cancelado'), 0) AS cancelados
           FROM traspasos ${trSql}`,
      )
      .bind(...trBinds),
    env.DB
      .prepare(
        `SELECT COALESCE(SUM(cantidad), 0) AS unidades FROM traspaso_detalles
          WHERE traspaso_id IN (SELECT id FROM traspasos ${trSql ? trSql + " AND" : "WHERE"} estado = 'recibido')`,
      )
      .bind(...trBinds),
    q(`SELECT strftime('%H', v.fecha, '-4 hours') || ':00' AS k, COUNT(*) AS ventas, ROUND(SUM(v.total), 2) AS ingresos ${FROM} ${whereSql} GROUP BY k ORDER BY k`),
    q(`SELECT strftime('%Y-%W', v.fecha, '-4 hours') AS k, COUNT(*) AS ventas, ROUND(SUM(v.total), 2) AS ingresos ${FROM} ${whereSql} GROUP BY k ORDER BY k`),
    q(`SELECT strftime('%Y-%m', v.fecha, '-4 hours') AS k, COUNT(*) AS ventas, ROUND(SUM(v.total), 2) AS ingresos ${FROM} ${whereSql} GROUP BY k ORDER BY k`),
  ]);

  const rows = (r: D1Result, label: (k: string | null) => string): Group[] =>
    (r.results as { k: string | null; ventas: number; ingresos: number }[]).map((x) => ({
      clave: label(x.k),
      ventas: x.ventas,
      ingresos: x.ingresos,
    }));

  const one = <T>(r: D1Result) => r.results[0] as T;

  // Devoluciones, cambios, anulaciones y dinero movido. Solo las operaciones de ventas completadas restan ingresos;
  // las anulaciones se informan aparte. Los traspasos nunca entran aquí.
  const opWhere: string[] = [];
  const opBinds: unknown[] = [];
  if (branch !== null) {
    opWhere.push("o.sucursal_id = ?");
    opBinds.push(branch);
  } else {
    opWhere.push(orgBranchesSql(user, "o.sucursal_id"));
  }
  if (desde) {
    opWhere.push("date(o.created_at, '-4 hours') >= ?");
    opBinds.push(desde);
  }
  if (hasta) {
    opWhere.push("date(o.created_at, '-4 hours') <= ?");
    opBinds.push(hasta);
  }
  const opSql = opWhere.length ? `WHERE ${opWhere.join(" AND ")}` : "";
  const payWhere = opWhere.length ? `${opSql} AND o.pago_tipo <> 'ninguno'` : "WHERE o.pago_tipo <> 'ninguno'";

  const [opSummary, payments] = await env.DB.batch([
    env.DB
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN o.tipo IN ('devolucion','cambio') AND v.estado = 'completada' THEN o.valor_devuelto ELSE 0 END), 0) AS devuelto,
           COALESCE(SUM(CASE WHEN o.tipo = 'cambio' AND v.estado = 'completada' THEN o.valor_entregado ELSE 0 END), 0) AS entregado,
           COALESCE(SUM(CASE WHEN o.tipo = 'devolucion' THEN 1 ELSE 0 END), 0) AS n_devoluciones,
           COALESCE(SUM(CASE WHEN o.tipo = 'cambio' THEN 1 ELSE 0 END), 0) AS n_cambios,
           COALESCE(SUM(CASE WHEN o.tipo = 'anulacion' THEN 1 ELSE 0 END), 0) AS n_anulaciones,
           COALESCE(SUM(CASE WHEN o.tipo = 'anulacion' THEN o.valor_devuelto ELSE 0 END), 0) AS anulado
         FROM operaciones o JOIN ventas v ON v.id = o.venta_id ${opSql}`,
      )
      .bind(...opBinds),
    env.DB
      .prepare(
        `SELECT o.pago_tipo AS tipo, o.pago_estado AS estado, COALESCE(o.pago_metodo, '') AS metodo,
                ROUND(SUM(o.monto_pago), 2) AS monto, COUNT(*) AS n
           FROM operaciones o ${payWhere}
          GROUP BY o.pago_tipo, o.pago_estado, o.pago_metodo ORDER BY o.pago_tipo, o.pago_estado`,
      )
      .bind(...opBinds),
  ]);

  const op = opSummary.results[0] as Record<string, number>;
  const ingresosBrutos = one<{ ingresos: number }>(summary).ingresos;
  const pagos = payments.results as { tipo: string; estado: string; metodo: string; monto: number; n: number }[];
  const sumPago = (tipo: string, estado: string) =>
    Math.round(pagos.filter((p) => p.tipo === tipo && p.estado === estado).reduce((a, p) => a + p.monto, 0) * 100) / 100;

  const operaciones = {
    devoluciones: op.n_devoluciones,
    cambios: op.n_cambios,
    anulaciones: op.n_anulaciones,
    valor_devuelto: Math.round(op.devuelto * 100) / 100,
    valor_cambio_entregado: Math.round(op.entregado * 100) / 100,
    valor_anulado: Math.round(op.anulado * 100) / 100,
    ingresos_brutos: ingresosBrutos,
    ingresos_netos: Math.round((ingresosBrutos - op.devuelto + op.entregado) * 100) / 100,
    cobros_completados: sumPago("cobro", "completado"),
    reembolsos_completados: sumPago("reembolso", "completado"),
    reembolsos_pendientes: sumPago("reembolso", "pendiente"),
    creditos_pendientes: sumPago("credito", "pendiente"),
    pagos,
  };

  return ok({
    operaciones,
    resumen: {
      ventas: one<{ ventas: number }>(summary).ventas,
      ingresos: one<{ ingresos: number }>(summary).ingresos,
      ticket_promedio: one<{ ventas: number }>(summary).ventas
        ? Math.round((one<{ ingresos: number }>(summary).ingresos / one<{ ventas: number }>(summary).ventas) * 100) / 100
        : 0,
      unidades: one<{ unidades: number }>(units).unidades,
    },
    por_metodo: rows(byPay, (k) => (k ? (PAGO_FROM_DB[k] ?? k) : "Sin registrar")),
    por_sucursal: rows(byBranch, (k) => k ?? "—"),
    por_departamento: foldDepartments(rows(byDept, (k) => k ?? "")),
    por_modalidad: rows(byMode, (k) => (k ? (MODALIDAD_FROM_DB[k] ?? k) : "Sin registrar")),
    por_dia: rows(byDay, (k) => k ?? "—"),
    por_hora: rows(byHour, (k) => k ?? "—"),
    por_semana: rows(byWeek, (k) => (k ? `Semana ${k.split("-")[1]} de ${k.split("-")[0]}` : "—")),
    por_mes: rows(byMonth, (k) => k ?? "—"),
    top_productos: top.results,
    traspasos: { ...one<Record<string, number>>(transfers), unidades_recibidas: one<{ unidades: number }>(trUnits).unidades },
  });
}
