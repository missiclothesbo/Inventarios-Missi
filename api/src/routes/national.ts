/**
 * Vista MISSI BOLIVIA: toda la mercadería de la organización con el desglose por sucursal y lo enviado a cada una.
 *
 * El total NO se guarda en ningún lado: se calcula sumando el stock de cada sucursal. La mercadería despachada que aún no
 * se recibió (traspaso "enviado") ya salió del origen y todavía no está en el destino: se informa como "en tránsito" para que
 * la mercadería total de la organización siempre cuadre (en stock + en tránsito). Los borradores no mueven stock y los traspasos
 * cancelados no cuentan.
 */
import { orgBranchesSql, requireAdmin, type AuthUser } from "../auth";
import { ok, type Env } from "../http";

interface VariantRow {
  producto_id: number;
  producto: string;
  talla_id: number;
  talla: string;
  color_id: number;
  color: string;
  sucursal_id: number;
  cantidad: number;
}

export async function nationalInventory(env: Env, user: AuthUser): Promise<Response> {
  requireAdmin(user);
  const orgBranch = (col: string) => orgBranchesSql(user, col);

  const [branches, stock, transit, quarantine, toBranch, fromBranch, org] = await env.DB.batch([
    env.DB.prepare(`SELECT id, nombre, tipo FROM sucursales WHERE ${orgBranch("id")} AND activa = 1 ORDER BY tipo = 'almacen' DESC, es_central DESC, nombre`),
    env.DB.prepare(
      `SELECT i.producto_id, p.nombre AS producto, i.talla_id, t.nombre AS talla, i.color_id, c.nombre AS color, i.sucursal_id, i.cantidad
         FROM inventario i
         JOIN productos p ON p.id = i.producto_id JOIN tallas t ON t.id = i.talla_id JOIN colores c ON c.id = i.color_id
        WHERE i.cantidad > 0 AND ${orgBranch("i.sucursal_id")}
        ORDER BY p.nombre, t.orden, c.nombre`,
    ),
    env.DB.prepare(
      `SELECT COALESCE(SUM(d.cantidad), 0) AS n FROM traspaso_detalles d JOIN traspasos t ON t.id = d.traspaso_id
        WHERE t.estado = 'enviado' AND ${orgBranch("t.sucursal_origen_id")} AND ${orgBranch("t.sucursal_destino_id")}`,
    ),
    env.DB.prepare(`SELECT COALESCE(SUM(cantidad), 0) AS n FROM inventario_danado WHERE ${orgBranch("sucursal_id")}`),
    env.DB.prepare(
      `SELECT t.sucursal_destino_id AS id,
              COALESCE(SUM(CASE WHEN t.estado IN ('enviado', 'recibido') THEN d.cantidad ELSE 0 END), 0) AS enviado_a,
              COALESCE(SUM(CASE WHEN t.estado = 'recibido' THEN d.cantidad ELSE 0 END), 0) AS recibido,
              COALESCE(SUM(CASE WHEN t.estado = 'enviado' THEN d.cantidad ELSE 0 END), 0) AS en_transito,
              COALESCE(SUM(CASE WHEN t.estado = 'pendiente' THEN d.cantidad ELSE 0 END), 0) AS pendiente,
              COUNT(DISTINCT CASE WHEN t.estado = 'recibido' THEN t.id END) AS traspasos_recibidos
         FROM traspasos t JOIN traspaso_detalles d ON d.traspaso_id = t.id
        WHERE ${orgBranch("t.sucursal_origen_id")} AND ${orgBranch("t.sucursal_destino_id")}
        GROUP BY t.sucursal_destino_id`,
    ),
    env.DB.prepare(
      `SELECT t.sucursal_origen_id AS id,
              COALESCE(SUM(CASE WHEN t.estado IN ('enviado', 'recibido') THEN d.cantidad ELSE 0 END), 0) AS despachado
         FROM traspasos t JOIN traspaso_detalles d ON d.traspaso_id = t.id
        WHERE ${orgBranch("t.sucursal_origen_id")} AND ${orgBranch("t.sucursal_destino_id")}
        GROUP BY t.sucursal_origen_id`,
    ),
    env.DB.prepare("SELECT nombre FROM organizaciones WHERE id = ?").bind(user.organizacion_id),
  ]);

  const branchList = branches.results as { id: number; nombre: string; tipo: string }[];
  const rows = stock.results as unknown as VariantRow[];

  // Una fila por variante, con lo que hay en cada sucursal; el total sale de sumarlas.
  const variants = new Map<string, { producto: { id: number; nombre: string }; talla: { id: number; nombre: string }; color: { id: number; nombre: string }; total: number; por_sucursal: { sucursal_id: number; cantidad: number }[] }>();
  for (const r of rows) {
    const key = `${r.producto_id}-${r.talla_id}-${r.color_id}`;
    let v = variants.get(key);
    if (!v) {
      v = { producto: { id: r.producto_id, nombre: r.producto }, talla: { id: r.talla_id, nombre: r.talla }, color: { id: r.color_id, nombre: r.color }, total: 0, por_sucursal: [] };
      variants.set(key, v);
    }
    v.total += r.cantidad;
    v.por_sucursal.push({ sucursal_id: r.sucursal_id, cantidad: r.cantidad });
  }

  const perBranchUnits = new Map<number, number>();
  for (const r of rows) perBranchUnits.set(r.sucursal_id, (perBranchUnits.get(r.sucursal_id) ?? 0) + r.cantidad);

  const incoming = new Map((toBranch.results as { id: number; enviado_a: number; recibido: number; en_transito: number; pendiente: number; traspasos_recibidos: number }[]).map((r) => [r.id, r]));
  const outgoing = new Map((fromBranch.results as { id: number; despachado: number }[]).map((r) => [r.id, r.despachado]));

  const totalEnStock = rows.reduce((a, r) => a + r.cantidad, 0);
  const enTransito = (transit.results[0] as { n: number }).n;

  return ok({
    organizacion: (org.results[0] as { nombre: string } | undefined)?.nombre ?? "MISSI BOLIVIA",
    sucursales: branchList.map((b) => ({ id: b.id, nombre: b.nombre, es_almacen: b.tipo === "almacen", unidades: perBranchUnits.get(b.id) ?? 0 })),
    total_en_stock: totalEnStock,
    en_transito: enTransito,
    total_mercaderia: totalEnStock + enTransito,
    en_cuarentena: (quarantine.results[0] as { n: number }).n,
    filas: [...variants.values()],
    envios: branchList.map((b) => ({
      sucursal_id: b.id,
      nombre: b.nombre,
      enviado_a: incoming.get(b.id)?.enviado_a ?? 0,
      recibido: incoming.get(b.id)?.recibido ?? 0,
      en_transito: incoming.get(b.id)?.en_transito ?? 0,
      pendiente: incoming.get(b.id)?.pendiente ?? 0,
      despachado_desde: outgoing.get(b.id) ?? 0,
      traspasos_recibidos: incoming.get(b.id)?.traspasos_recibidos ?? 0,
    })),
  });
}
