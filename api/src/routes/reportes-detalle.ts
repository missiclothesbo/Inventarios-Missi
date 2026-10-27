import { orgBranchesSql, scopedBranch, type AuthUser } from "../auth";
import { badRequest, ok, type Env } from "../http";
import { queryInt } from "../validate";
import { MOVEMENT_LABELS, type MovementCategory } from "../../../shared/catalogo";

/** Periodo inclusivo en fecha local de Bolivia (UTC-4). Ambos extremos incluidos. */
export function periodo(url: URL): { desde: string; hasta: string } {
  const desde = url.searchParams.get("desde") ?? "";
  const hasta = url.searchParams.get("hasta") ?? "";
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
  if (!valid(desde) || !valid(hasta)) throw badRequest("El periodo debe indicar desde y hasta (AAAA-MM-DD).");
  if (desde > hasta) throw badRequest("La fecha inicial no puede ser posterior a la final.");
  return { desde, hasta };
}

/** Efecto en el stock vendible, derivado del signo registrado en el libro (+1 entra, -1 sale, 0 cuarentena). */
function efectoStock(signo: number | null): string {
  if (signo === 1) return "Entrada";
  if (signo === -1) return "Salida";
  if (signo === 0) return "Cuarentena (no vendible)";
  return "Ajuste";
}

function tipoTexto(categoria: unknown): string {
  return MOVEMENT_LABELS[String(categoria) as MovementCategory] ?? "Sin clasificar";
}

/** Movimientos de inventario del periodo (trazables: venta, devolución, cambio, anulación, traspaso, cuarentena). */
export async function movimientos(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const { desde, hasta } = periodo(url);
  const branch = scopedBranch(user, queryInt(url, "sucursal_id"));

  const where = ["date(m.created_at, '-4 hours') BETWEEN ? AND ?"];
  const binds: unknown[] = [desde, hasta];
  if (branch !== null) {
    where.push("m.sucursal_id = ?");
    binds.push(branch);
  } else {
    where.push(orgBranchesSql(user, "m.sucursal_id"));
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const { results } = await env.DB
    .prepare(
      `SELECT m.id, m.created_at, date(m.created_at, '-4 hours') AS dia, time(m.created_at, '-4 hours') AS hora,
              s.nombre AS sucursal, p.nombre AS producto, t.nombre AS talla, c.nombre AS color,
              m.categoria, m.signo, m.tipo, m.cantidad, m.referencia_tipo, m.referencia_id, m.observaciones
         FROM movimientos_inventario m
         JOIN sucursales s ON s.id = m.sucursal_id
         JOIN productos p ON p.id = m.producto_id
         JOIN tallas t ON t.id = m.talla_id
         JOIN colores c ON c.id = m.color_id
        ${whereSql}
        ORDER BY m.created_at, m.id
        LIMIT 2000`,
    )
    .bind(...binds)
    .all<Record<string, unknown>>();

  const { results: totals } = await env.DB
    .prepare(
      `SELECT m.categoria, m.signo, m.referencia_tipo, COUNT(*) AS movimientos, SUM(m.cantidad) AS unidades
         FROM movimientos_inventario m ${whereSql}
        GROUP BY m.categoria, m.signo, m.referencia_tipo ORDER BY m.categoria, m.signo, m.referencia_tipo`,
    )
    .bind(...binds)
    .all<Record<string, unknown>>();

  const total = totals.reduce((a, r) => a + Number(r.movimientos), 0);

  return ok({
    periodo: { desde, hasta },
    total_movimientos: total,
    truncado: results.length >= 2000,
    totales: totals.map((r) => ({
      tipo: tipoTexto(r.categoria),
      referencia: r.referencia_tipo ?? "",
      movimientos: Number(r.movimientos),
      unidades: Number(r.unidades),
    })),
    filas: results.map((r) => ({
      id: r.id,
      fecha: `${r.dia} ${r.hora}`,
      sucursal: r.sucursal,
      producto: r.producto,
      talla: r.talla,
      color: r.color,
      tipo: tipoTexto(r.categoria),
      efecto: efectoStock(r.signo === null || r.signo === undefined ? null : Number(r.signo)),
      cantidad: Number(r.cantidad),
      referencia: r.referencia_tipo ? `${r.referencia_tipo} #${r.referencia_id}` : "",
      observaciones: r.observaciones ?? "",
    })),
  });
}

/** Stock actual (foto del momento, no del periodo): vendible y en cuarentena, por sucursal, modelo, talla y color. */
export async function stock(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const branch = scopedBranch(user, queryInt(url, "sucursal_id"));
  const binds: unknown[] = [];
  const where: string[] = [];
  if (branch !== null) {
    where.push("i.sucursal_id = ?");
    binds.push(branch);
  } else {
    where.push(orgBranchesSql(user, "i.sucursal_id"));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { results: vendible } = await env.DB
    .prepare(
      `SELECT s.nombre AS sucursal, p.nombre AS producto, t.nombre AS talla, c.nombre AS color, i.cantidad
         FROM inventario i
         JOIN sucursales s ON s.id = i.sucursal_id
         JOIN productos p ON p.id = i.producto_id
         JOIN tallas t ON t.id = i.talla_id
         JOIN colores c ON c.id = i.color_id
        ${whereSql}
        ORDER BY s.id, p.nombre, t.orden, c.nombre`,
    )
    .bind(...binds)
    .all<Record<string, unknown>>();

  const danadoWhere = branch !== null ? "WHERE d.sucursal_id = ? AND d.cantidad > 0" : `WHERE d.cantidad > 0 AND ${orgBranchesSql(user, "d.sucursal_id")}`;
  const { results: danado } = await env.DB
    .prepare(
      `SELECT s.nombre AS sucursal, p.nombre AS producto, t.nombre AS talla, c.nombre AS color, d.cantidad
         FROM inventario_danado d
         JOIN sucursales s ON s.id = d.sucursal_id
         JOIN productos p ON p.id = d.producto_id
         JOIN tallas t ON t.id = d.talla_id
         JOIN colores c ON c.id = d.color_id
        ${danadoWhere}
        ORDER BY s.id, p.nombre`,
    )
    .bind(...(branch !== null ? [branch] : []))
    .all<Record<string, unknown>>();

  const sucursales = new Map<string, { sucursal: string; vendible: number; danado: number }>();
  for (const r of vendible) {
    const k = String(r.sucursal);
    const e = sucursales.get(k) ?? { sucursal: k, vendible: 0, danado: 0 };
    e.vendible += Number(r.cantidad);
    sucursales.set(k, e);
  }
  for (const r of danado) {
    const k = String(r.sucursal);
    const e = sucursales.get(k) ?? { sucursal: k, vendible: 0, danado: 0 };
    e.danado += Number(r.cantidad);
    sucursales.set(k, e);
  }

  return ok({
    generado: new Date().toISOString(),
    totales_por_sucursal: [...sucursales.values()],
    filas: [
      ...vendible.map((r) => ({ sucursal: r.sucursal, producto: r.producto, talla: r.talla, color: r.color, estado: "Vendible", cantidad: Number(r.cantidad) })),
      ...danado.map((r) => ({ sucursal: r.sucursal, producto: r.producto, talla: r.talla, color: r.color, estado: "Cuarentena (dañado)", cantidad: Number(r.cantidad) })),
    ],
  });
}
