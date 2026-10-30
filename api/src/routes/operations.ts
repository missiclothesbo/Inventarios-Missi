import { audit, orgBranchesSql, requireAdmin, requireBranch, scopedBranch, type AuthUser } from "../auth";
import { MODALIDAD_TO_DB, iso } from "../db";
import { badRequest, conflict, HttpError, notFound, ok, readJson, type Env } from "../http";
import { stockChange, validateVariants } from "../inventory";
import { getSaleOrFail, shapeSale, SALE_SELECT, type SaleRow } from "./sales";
import { int, oneOf, optionalStr, queryDate, queryInt, str, uuid } from "../validate";
import {
  RETURN_REASONS,
  RETURN_REASON_LABELS,
  isReturnReason,
  operationRef,
  parseRef,
  saleRef,
  type ReturnReason,
} from "../../../shared/catalogo";

/**
 * Motivo estructurado + explicación. Sin código se asume "Otro" (compatibilidad con clientes anteriores) y entonces
 * la explicación es obligatoria. El texto guardado en `motivo` es siempre legible: "Etiqueta: detalle" o la etiqueta.
 */
function readReason(body: Record<string, unknown>): { codigo: ReturnReason; motivo: string } {
  const raw = body.motivo_codigo;
  const codigo = raw === undefined || raw === null ? "OTRO" : oneOf(raw, "motivo_codigo", RETURN_REASONS);
  const detalle = optionalStr(body.motivo, "motivo", 300);
  if (codigo === "OTRO" && !detalle) throw badRequest("Explica el motivo (es obligatorio cuando eliges «Otro»).");
  const label = RETURN_REASON_LABELS[codigo];
  const motivo = detalle ? (codigo === "OTRO" ? detalle : `${label}: ${detalle}`) : label;
  return { codigo, motivo: motivo.slice(0, 300) };
}

const reasonLabel = (code: unknown) => (isReturnReason(code) ? RETURN_REASON_LABELS[code] : null);

// ---------------------------------------------------------------- reglas

const SETTLEMENTS = ["reembolso_inmediato", "reembolso_pendiente", "credito"] as const;
const PAYMENTS = ["qr", "efectivo"] as const;
type Payment = (typeof PAYMENTS)[number];

interface PaymentPlan {
  tipo: "ninguno" | "cobro" | "reembolso" | "credito";
  estado: "no_aplica" | "completado" | "pendiente";
  metodo: Payment | null;
  monto: number;
}

/** Dinero de una operación según la diferencia. diferencia > 0: cobra el cliente; < 0: se le debe. */
function paymentPlan(diferencia: number, settlement: unknown, metodo: unknown): PaymentPlan {
  const diff = round2(diferencia);
  if (diff === 0) return { tipo: "ninguno", estado: "no_aplica", metodo: null, monto: 0 };

  if (diff > 0) {
    // El cliente paga la diferencia ahora (siempre queda completado).
    const m = oneOf(metodo, "metodo", PAYMENTS);
    return { tipo: "cobro", estado: "completado", metodo: m, monto: diff };
  }

  const amount = round2(-diff);
  // Sin elegir, el reembolso queda PENDIENTE: nunca se registra dinero entregado sin confirmación.
  const choice = settlement === undefined || settlement === null ? "reembolso_pendiente" : oneOf(settlement, "liquidacion", SETTLEMENTS);
  if (choice === "reembolso_inmediato") {
    return { tipo: "reembolso", estado: "completado", metodo: oneOf(metodo, "metodo", PAYMENTS), monto: amount };
  }
  if (choice === "reembolso_pendiente") {
    return { tipo: "reembolso", estado: "pendiente", metodo: metodo === undefined || metodo === null ? null : oneOf(metodo, "metodo", PAYMENTS), monto: amount };
  }
  // Crédito a favor del cliente: pasivo pendiente, nunca dinero entregado.
  return { tipo: "credito", estado: "pendiente", metodo: null, monto: amount };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function like(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ---------------------------------------------------------------- búsqueda y detalle

export async function searchSales(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const where: string[] = [];
  const binds: unknown[] = [];

  const branch = scopedBranch(user, queryInt(url, "sucursal_id"));
  if (branch !== null) {
    where.push("v.sucursal_id = ?");
    binds.push(branch);
  } else {
    where.push(orgBranchesSql(user, "v.sucursal_id"));
  }

  const numero = url.searchParams.get("numero")?.trim();
  if (numero) {
    if (!/^\d{1,9}$/.test(numero)) throw badRequest("El número de venta debe ser numérico.");
    where.push("v.id = ?");
    binds.push(Number(numero));
  }

  const cliente = url.searchParams.get("cliente")?.trim();
  if (cliente) {
    where.push("v.cliente_nombre LIKE ? ESCAPE '\\'");
    binds.push(like(str(cliente, "cliente", 120)));
  }

  const telefono = url.searchParams.get("telefono")?.trim();
  if (telefono) {
    if (!/^\d{1,8}$/.test(telefono)) throw badRequest("El teléfono de búsqueda debe ser numérico.");
    where.push("v.cliente_telefono LIKE ? ESCAPE '\\'");
    binds.push(like(telefono));
  }

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

  const estado = url.searchParams.get("estado");
  if (estado) {
    where.push("v.estado = ?");
    binds.push(oneOf(estado, "estado", ["completada", "cancelada"] as const));
  }

  const producto = url.searchParams.get("producto")?.trim();
  if (producto) {
    where.push(`EXISTS (SELECT 1 FROM detalle_venta dv JOIN productos p ON p.id = dv.producto_id
                        WHERE dv.venta_id = v.id AND p.nombre LIKE ? ESCAPE '\\')`);
    binds.push(like(str(producto, "producto", 120)));
  }
  for (const [param, table, column] of [["talla", "tallas", "t"], ["color", "colores", "c"]] as const) {
    const value = url.searchParams.get(param)?.trim();
    if (!value) continue;
    where.push(`EXISTS (SELECT 1 FROM detalle_venta dv JOIN ${table} ${column} ON ${column}.id = dv.${param === "talla" ? "talla_id" : "color_id"}
                        WHERE dv.venta_id = v.id AND ${column}.nombre = ?)`);
    binds.push(str(value, param, 40));
  }

  const modalidad = url.searchParams.get("modalidad");
  if (modalidad) {
    where.push("v.tipo_entrega = ?");
    binds.push(MODALIDAD_TO_DB[oneOf(modalidad, "modalidad", ["entrega_directa", "envio", "envio_interprovincial"] as const)]);
  }
  const depto = url.searchParams.get("departamento")?.trim();
  if (depto) {
    where.push("COALESCE(dep.nombre, d.departamento_manual) = ?");
    binds.push(str(depto, "departamento", 60));
  }
  const provincia = url.searchParams.get("provincia")?.trim();
  if (provincia) {
    where.push("d.provincia LIKE ? ESCAPE '\\'");
    binds.push(like(str(provincia, "provincia", 100)));
  }
  const direccion = url.searchParams.get("direccion")?.trim();
  if (direccion) {
    where.push("d.direccion LIKE ? ESCAPE '\\'");
    binds.push(like(str(direccion, "direccion", 200)));
  }

  // Búsqueda universal: cada palabra debe aparecer en alguno de los datos de la venta (AND entre palabras,
  // OR entre campos). Coincide con número, cliente, teléfono, fecha, sucursal, destino, notas, pago y artículos.
  const q = url.searchParams.get("q")?.trim();
  if (q) {
    // Un texto que solo parece teléfono ("+591 7123 4567", "(712) 34-567") se busca como un único número.
    const looksLikePhone = /^[\d\s+()-]+$/.test(q) && q.replace(/\D/g, "").length >= 6 && /[\s+()-]/.test(q) && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(q);
    const tokens = looksLikePhone ? [q.replace(/\D/g, "")] : q.split(/\s+/).filter(Boolean).slice(0, 6);
    for (const t of tokens) {
      if (t.length > 60) throw badRequest("Una de las palabras de búsqueda es demasiado larga.");
      const clauses: string[] = [];
      const vals: unknown[] = [];
      const textFields = [
        "v.cliente_nombre", "v.observaciones", "v.metodo_pago",
        "(SELECT nombre FROM sucursales WHERE id = v.sucursal_id)",
        "COALESCE(dep.nombre, d.departamento_manual)", "d.provincia", "d.municipio", "d.ciudad", "d.direccion",
        "d.agencia_transporte", "d.referencia",
      ];
      for (const f of textFields) {
        clauses.push(`${f} LIKE ? ESCAPE '\\'`);
        vals.push(like(t));
      }
      const idMatch = /^#?(\d{1,9})$/.exec(t);
      if (idMatch) {
        clauses.push("v.id = ?");
        vals.push(Number(idMatch[1]));
      }
      const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
      const dateText = dmy ? `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}` : t;
      if (/^[\d/-]{4,10}$/.test(t)) {
        clauses.push("date(v.fecha, '-4 hours') LIKE ? ESCAPE '\\'");
        vals.push(like(dateText));
      }
      // Teléfono: solo dígitos; un prefijo de país (591) se quita para que "+591 7000 0000" coincida con "70000000".
      let digits = t.replace(/\D/g, "");
      if (digits.length > 8 && digits.startsWith("591")) digits = digits.slice(3);
      if (digits.length >= 3) {
        clauses.push("v.cliente_telefono LIKE ? ESCAPE '\\'");
        vals.push(like(digits));
      }
      clauses.push(`EXISTS (SELECT 1 FROM detalle_venta dv
                             JOIN productos p ON p.id = dv.producto_id
                             JOIN tallas tq ON tq.id = dv.talla_id
                             JOIN colores cq ON cq.id = dv.color_id
                            WHERE dv.venta_id = v.id
                              AND (p.nombre LIKE ? ESCAPE '\\' OR tq.nombre LIKE ? ESCAPE '\\' OR cq.nombre LIKE ? ESCAPE '\\'))`);
      vals.push(like(t), like(t), like(t));
      where.push(`(${clauses.join(" OR ")})`);
      binds.push(...vals);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await env.DB
    .prepare(
      `${SALE_SELECT} ${whereSql} ORDER BY v.fecha DESC, v.id DESC LIMIT 50`,
    )
    .bind(...binds)
    .all<SaleRow>();

  const ids = results.map((r) => r.id);
  let items: { venta_id: number; producto: string; talla: string; color: string; cantidad: number; precio_unitario: number }[] = [];
  if (ids.length > 0) {
    const marks = ids.map(() => "?").join(",");
    items = (
      await env.DB
        .prepare(
          `SELECT dv.venta_id, p.nombre AS producto, t.nombre AS talla, c.nombre AS color, dv.cantidad, dv.precio_unitario
             FROM detalle_venta dv
             JOIN productos p ON p.id = dv.producto_id
             JOIN tallas t ON t.id = dv.talla_id
             JOIN colores c ON c.id = dv.color_id
            WHERE dv.venta_id IN (${marks}) ORDER BY dv.id`,
        )
        .bind(...ids)
        .all<(typeof items)[number]>()
    ).results;
  }

  const branches = await env.DB.prepare("SELECT id, nombre FROM sucursales").all<{ id: number; nombre: string }>();
  const branchName = new Map(branches.results.map((b) => [b.id, b.nombre]));

  return ok(
    results.map((r) => ({
      ...shapeSale(r),
      sucursal: branchName.get(r.sucursal_id) ?? null,
      items: items.filter((i) => i.venta_id === r.id).map(({ venta_id: _v, ...rest }) => { void _v; return rest; }),
    })),
  );
}

interface LineRow {
  detalle_id: number;
  producto_id: number;
  talla_id: number;
  color_id: number;
  producto: string;
  talla: string;
  color: string;
  cantidad: number;
  precio_unitario: number;
  devuelta: number;
}

/** Líneas de una venta con lo que ya se devolvió (o se cambió) y lo que aún queda. */
async function saleLines(env: Env, ventaId: number): Promise<LineRow[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT dv.id AS detalle_id, dv.producto_id, dv.talla_id, dv.color_id, p.nombre AS producto, t.nombre AS talla,
              c.nombre AS color, dv.cantidad, dv.precio_unitario,
              COALESCE((SELECT SUM(oi.cantidad) FROM operacion_items oi
                         WHERE oi.detalle_venta_id = dv.id AND oi.rol = 'devuelto'), 0) AS devuelta
         FROM detalle_venta dv
         JOIN productos p ON p.id = dv.producto_id
         JOIN tallas t ON t.id = dv.talla_id
         JOIN colores c ON c.id = dv.color_id
        WHERE dv.venta_id = ? ORDER BY dv.id`,
    )
    .bind(ventaId)
    .all<LineRow>();
  return results;
}

async function operationsOf(env: Env, ventaId: number | null, limit = 100) {
  const where = ventaId === null ? "" : "WHERE o.venta_id = ?";
  const stmt = env.DB.prepare(
    `SELECT o.id, o.tipo, o.venta_id, o.sucursal_id, o.usuario_id, u.nombre AS operador, o.motivo, o.motivo_codigo,
            o.valor_devuelto, o.valor_entregado, o.diferencia, o.pago_tipo, o.pago_estado, o.pago_metodo,
            o.monto_pago, o.created_at
       FROM operaciones o JOIN usuarios u ON u.id = o.usuario_id
       ${where} ORDER BY o.id DESC LIMIT ?`,
  );
  const { results } = await (ventaId === null ? stmt.bind(limit) : stmt.bind(ventaId, limit)).all<Record<string, unknown>>();
  if (results.length === 0) return [];

  const ids = results.map((r) => r.id as number);
  const marks = ids.map(() => "?").join(",");
  const { results: items } = await env.DB
    .prepare(
      `SELECT oi.operacion_id, oi.rol, oi.detalle_venta_id, p.nombre AS producto, t.nombre AS talla, c.nombre AS color,
              oi.cantidad, oi.precio_unitario, oi.condicion
         FROM operacion_items oi
         JOIN productos p ON p.id = oi.producto_id
         JOIN tallas t ON t.id = oi.talla_id
         JOIN colores c ON c.id = oi.color_id
        WHERE oi.operacion_id IN (${marks}) ORDER BY oi.id`,
    )
    .bind(...ids)
    .all<Record<string, unknown>>();

  return results.map((r) => ({
    id: r.id,
    referencia: operationRef(String(r.tipo), r.id as number),
    tipo: r.tipo,
    venta_id: r.venta_id,
    sucursal_id: r.sucursal_id,
    operador: r.operador,
    motivo: r.motivo,
    motivo_codigo: r.motivo_codigo ?? null,
    motivo_etiqueta: reasonLabel(r.motivo_codigo),
    fecha: iso(r.created_at as string),
    valor_devuelto: r.valor_devuelto,
    valor_entregado: r.valor_entregado,
    diferencia: r.diferencia,
    pago: { tipo: r.pago_tipo, estado: r.pago_estado, metodo: r.pago_metodo, monto: r.monto_pago },
    items: items
      .filter((i) => i.operacion_id === r.id)
      .map(({ operacion_id: _o, ...rest }) => { void _o; return rest; }),
  }));
}

export async function saleDetail(env: Env, user: AuthUser, id: number): Promise<Response> {
  const sale = await getSaleOrFail(env, id);
  requireBranch(user, sale.sucursal_id);
  const lines = await saleLines(env, id);
  const remaining = lines.reduce((a, l) => a + (l.cantidad - l.devuelta), 0);
  const operaciones = await operationsOf(env, id);
  const sucursal = await env.DB.prepare("SELECT nombre FROM sucursales WHERE id = ?").bind(sale.sucursal_id).first<{ nombre: string }>();

  return ok({
    venta: { ...shapeSale(sale), sucursal: sucursal?.nombre ?? null },
    lineas: lines.map((l) => ({ ...l, pendiente: l.cantidad - l.devuelta })),
    unidades_pendientes: remaining,
    puede_anular: sale.estado === "completada" && remaining > 0 && user.rol === "admin",
    operaciones,
  });
}

export async function listOperations(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const branch = scopedBranch(user, queryInt(url, "sucursal_id"));
  const ventaId = queryInt(url, "venta_id");
  const desde = queryDate(url, "desde");
  const hasta = queryDate(url, "hasta");
  const where: string[] = [];
  const binds: unknown[] = [];
  if (branch !== null) {
    where.push("o.sucursal_id = ?");
    binds.push(branch);
  } else {
    where.push(orgBranchesSql(user, "o.sucursal_id"));
  }
  if (ventaId !== null) {
    where.push("o.venta_id = ?");
    binds.push(ventaId);
  }
  if (desde) {
    where.push("date(o.created_at, '-4 hours') >= ?");
    binds.push(desde);
  }
  if (hasta) {
    where.push("date(o.created_at, '-4 hours') <= ?");
    binds.push(hasta);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await env.DB
    .prepare(
      `SELECT o.id, o.tipo, o.venta_id, o.sucursal_id, u.nombre AS operador, o.motivo, o.valor_devuelto,
              o.valor_entregado, o.diferencia, o.pago_tipo, o.pago_estado, o.pago_metodo, o.monto_pago, o.created_at
         FROM operaciones o JOIN usuarios u ON u.id = o.usuario_id ${whereSql}
        ORDER BY o.id DESC LIMIT 200`,
    )
    .bind(...binds)
    .all<Record<string, unknown>>();
  return ok(results.map((r) => ({ ...r, fecha: iso(r.created_at as string), created_at: undefined })));
}

// ---------------------------------------------------------------- núcleo transaccional

interface DevueltoPlan {
  detalleId: number;
  productoId: number;
  tallaId: number;
  colorId: number;
  cantidad: number;
  precio: number;
  condicion: "vendible" | "danado";
}

interface EntregadoPlan {
  productoId: number;
  tallaId: number;
  colorId: number;
  cantidad: number;
  precio: number;
}

interface OperationPlan {
  tipo: "devolucion" | "cambio" | "anulacion";
  sale: SaleRow;
  user: AuthUser;
  motivo: string;
  motivoCodigo: ReturnReason;
  key: string;
  devueltos: DevueltoPlan[];
  entregados: EntregadoPlan[];
  pago: PaymentPlan;
  valorDevuelto: number;
  valorEntregado: number;
  saleCancels: boolean;
}

const opIdSql = "(SELECT id FROM operaciones WHERE idempotency_key = ?)";

/**
 * Ejecuta una operación completa en UN lote de D1 (una transacción). Si cualquier paso falla —cantidades
 * ya devueltas, stock insuficiente, venta cambiada por otra petición— el lote entero se revierte:
 * no queda stock, dinero ni registro a medias. Las aserciones usan NOT NULL / CHECK a propósito.
 */
async function runOperation(env: Env, plan: OperationPlan) {
  const { sale, user } = plan;
  const sucursal = sale.sucursal_id;
  const statements: D1PreparedStatement[] = [
    // 1) Encabezado. Solo se inserta si la venta sigue completada en el momento de ejecutar el lote.
    env.DB
      .prepare(
        `INSERT INTO operaciones (tipo, venta_id, sucursal_id, usuario_id, motivo, motivo_codigo, valor_devuelto, valor_entregado,
                                  diferencia, pago_tipo, pago_estado, pago_metodo, monto_pago, idempotency_key)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM ventas WHERE id = ? AND estado = 'completada' AND sucursal_id = ?)`,
      )
      .bind(
        plan.tipo, sale.id, sucursal, user.id, plan.motivo, plan.motivoCodigo, plan.valorDevuelto, plan.valorEntregado,
        round2(plan.valorEntregado - plan.valorDevuelto), plan.pago.tipo, plan.pago.estado, plan.pago.metodo, plan.pago.monto,
        plan.key, sale.id, sucursal,
      ),
  ];

  // 2) Líneas devueltas: solo se insertan si la cantidad sigue disponible DENTRO de este lote.
  for (const d of plan.devueltos) {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO operacion_items (operacion_id, rol, detalle_venta_id, producto_id, talla_id, color_id, cantidad, precio_unitario, condicion)
           SELECT ${opIdSql}, 'devuelto', dv.id, dv.producto_id, dv.talla_id, dv.color_id, ?, dv.precio_unitario, ?
             FROM detalle_venta dv
            WHERE dv.id = ? AND dv.venta_id = ?
              AND ? <= dv.cantidad - (SELECT COALESCE(SUM(oi.cantidad), 0) FROM operacion_items oi
                                       WHERE oi.detalle_venta_id = dv.id AND oi.rol = 'devuelto')`,
        )
        .bind(plan.key, d.cantidad, d.condicion, d.detalleId, sale.id, d.cantidad),
    );
  }

  // 3) Líneas entregadas (reemplazos del cambio).
  for (const e of plan.entregados) {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO operacion_items (operacion_id, rol, detalle_venta_id, producto_id, talla_id, color_id, cantidad, precio_unitario, condicion)
           VALUES (${opIdSql}, 'entregado', NULL, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(plan.key, e.productoId, e.tallaId, e.colorId, e.cantidad, e.precio),
    );
  }

  // 4) Aserción: todas las líneas se insertaron (si no, algo cambió y se revierte todo).
  const expected = plan.devueltos.length + plan.entregados.length;
  statements.push(
    env.DB
      .prepare(`INSERT INTO operacion_validacion (ok) SELECT CASE WHEN (SELECT COUNT(*) FROM operacion_items WHERE operacion_id = ${opIdSql}) = ? THEN 1 ELSE 0 END`)
      .bind(plan.key, expected),
  );

  // 5) Aserción de stock para lo entregado (un UPDATE sin filas no debe pasar en silencio).
  for (const e of plan.entregados) {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO operacion_validacion (ok)
           SELECT CASE WHEN COALESCE((SELECT SUM(cantidad) FROM inventario WHERE sucursal_id = ? AND producto_id = ? AND talla_id = ? AND color_id = ?), 0) >= ?
                       THEN 1 ELSE 0 END`,
        )
        .bind(sucursal, e.productoId, e.tallaId, e.colorId, e.cantidad),
    );
  }

  // 6) Stock de lo devuelto: vendible vuelve al inventario; dañado va a cuarentena. Todo con asiento en el libro.
  //    Devolución y anulación = DEVOLUCION; lo devuelto y lo entregado en un cambio = CAMBIO (se registran por separado).
  const categoria = plan.tipo === "cambio" ? "CAMBIO" : "DEVOLUCION";
  const ledger = { usuarioId: user.id, refIdSql: opIdSql, refIdBinds: [plan.key], observaciones: plan.motivo, motivoCodigo: plan.motivoCodigo };
  for (const d of plan.devueltos) {
    const v = { sucursal, producto: d.productoId, talla: d.tallaId, color: d.colorId, qty: d.cantidad };
    if (d.condicion === "vendible") {
      statements.push(
        // Vuelve al mismo lote del que salió esa línea de venta (si se vendió antes de los lotes: lote de fecha desconocida).
        ...stockChange(env, {
          ...v, ...ledger, categoria, signo: 1, tipo: "entrada", refTipo: plan.tipo === "anulacion" ? "anulacion" : "devolucion",
          lote: { restaurar: { detalleVentaId: d.detalleId, origenResto: "devolucion" } },
        }),
      );
    } else {
      statements.push(
        env.DB
          .prepare(
            `INSERT INTO inventario_danado (sucursal_id, producto_id, talla_id, color_id, cantidad) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (sucursal_id, producto_id, talla_id, color_id)
             DO UPDATE SET cantidad = cantidad + excluded.cantidad`,
          )
          .bind(sucursal, d.productoId, d.tallaId, d.colorId, d.cantidad),
        // signo 0: no entra al stock vendible, pero queda el asiento (cuarentena) con su motivo.
        ...stockChange(env, { ...v, ...ledger, categoria, signo: 0, tipo: "ajuste", refTipo: "devolucion_danada" }),
      );
    }
  }

  // 7) Stock del reemplazo: sale de la sucursal de la venta original (nunca de otra).
  for (const e of plan.entregados) {
    const v = { sucursal, producto: e.productoId, talla: e.tallaId, color: e.colorId, qty: e.cantidad };
    statements.push(...stockChange(env, { ...v, ...ledger, categoria: "CAMBIO", signo: -1, tipo: "venta", refTipo: "cambio" }));
  }

  // 8) Anulación: la venta pasa a cancelada en el mismo lote.
  if (plan.saleCancels) {
    statements.push(
      env.DB
        .prepare("UPDATE ventas SET estado = 'cancelada', motivo_cancelacion = ?, cancelada_at = CURRENT_TIMESTAMP WHERE id = ? AND estado = 'completada'")
        .bind(plan.motivo, sale.id),
    );
  }

  return env.DB.batch(statements);
}

/** Traduce los fallos del lote a mensajes en español. Nada se guarda cuando hay error. */
function mapBatchError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/NOT NULL constraint failed: operacion_items\.operacion_id/i.test(msg)) {
    return conflict("La venta cambió mientras registrabas la operación (ya fue anulada o devuelta). No se guardó nada; vuelve a consultarla.");
  }
  if (/operacion_validacion/i.test(msg) || /CHECK constraint failed: ok/i.test(msg)) {
    return conflict("Las cantidades o el stock cambiaron mientras registrabas la operación. No se guardó nada; revisa la venta y vuelve a intentarlo.");
  }
  if (/CHECK constraint failed: cantidad/i.test(msg)) {
    return conflict("Stock insuficiente para el reemplazo en esta sucursal. No se guardó nada.");
  }
  throw err;
}

async function existingOperation(env: Env, key: string) {
  return env.DB.prepare("SELECT id FROM operaciones WHERE idempotency_key = ?").bind(key).first<{ id: number }>();
}

async function operationReceipt(env: Env, id: number, repetida: boolean) {
  const row = await env.DB.prepare("SELECT venta_id FROM operaciones WHERE id = ?").bind(id).first<{ venta_id: number }>();
  if (!row) throw notFound("Operación no encontrada.");
  const op = (await operationsOf(env, row.venta_id, 200)).find((o) => o.id === id);
  if (!op) throw notFound("Operación no encontrada.");
  const sale = await getSaleOrFail(env, row.venta_id);
  const sucursal = await env.DB.prepare("SELECT nombre FROM sucursales WHERE id = ?").bind(sale.sucursal_id).first<{ nombre: string }>();
  return { ...op, venta: { id: sale.id, fecha: iso(sale.fecha), total: sale.total, sucursal: sucursal?.nombre ?? null, cliente: sale.cliente_nombre }, repetida };
}

// ---------------------------------------------------------------- endpoints de operación

interface ReturnLineInput {
  detalleId: number;
  cantidad: number;
  condicion: "vendible" | "danado";
}

function readReturnLines(raw: unknown): ReturnLineInput[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) throw badRequest("Selecciona al menos un artículo a devolver.");
  const seen = new Set<number>();
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw badRequest(`items[${i}] inválido.`);
    const e = entry as Record<string, unknown>;
    const detalleId = int(e.detalle_id, `items[${i}].detalle_id`);
    if (seen.has(detalleId)) throw badRequest("Hay líneas repetidas en la devolución.");
    seen.add(detalleId);
    return {
      detalleId,
      cantidad: int(e.cantidad, `items[${i}].cantidad`, 1, 10_000),
      condicion: oneOf(e.condicion, `items[${i}].condicion`, ["vendible", "danado"] as const),
    };
  });
}

/** Valida las cantidades contra lo que queda por devolver, y arma el plan de devolución. */
async function returnPlan(env: Env, sale: SaleRow, lines: ReturnLineInput[]) {
  const current = await saleLines(env, sale.id);
  const devueltos: DevueltoPlan[] = lines.map((r) => {
    const line = current.find((l) => l.detalle_id === r.detalleId);
    if (!line) throw badRequest("Una de las líneas no pertenece a esta venta.");
    const pendiente = line.cantidad - line.devuelta;
    if (r.cantidad > pendiente) {
      throw badRequest(`No puedes devolver ${r.cantidad} de ${line.producto} (${line.talla}, ${line.color}): quedan ${pendiente} por devolver.`);
    }
    return {
      detalleId: r.detalleId,
      productoId: line.producto_id,
      tallaId: line.talla_id,
      colorId: line.color_id,
      cantidad: r.cantidad,
      precio: line.precio_unitario,
      condicion: r.condicion,
    };
  });
  const valorDevuelto = round2(devueltos.reduce((a, d) => a + d.cantidad * d.precio, 0));
  return { devueltos, valorDevuelto };
}

export async function devolucion(request: Request, env: Env, user: AuthUser): Promise<Response> {
  const body = await readJson(request);
  const key = uuid(body.idempotency_key, "idempotency_key");
  const ventaId = int(body.venta_id, "venta_id");
  const { codigo: motivoCodigo, motivo } = readReason(body);

  const sale = await getSaleOrFail(env, ventaId);
  requireBranch(user, sale.sucursal_id);
  if (sale.estado !== "completada") throw conflict("La venta está anulada; no admite devoluciones.");

  const repeated = await existingOperation(env, key);
  if (repeated) return ok(await operationReceipt(env, repeated.id, true));

  const { devueltos, valorDevuelto } = await returnPlan(env, sale, readReturnLines(body.items));
  const pago = paymentPlan(-valorDevuelto, body.liquidacion, body.metodo_pago);

  try {
    await runOperation(env, { tipo: "devolucion", sale, user, motivo, motivoCodigo, key, devueltos, entregados: [], pago, valorDevuelto, valorEntregado: 0, saleCancels: false });
  } catch (err) {
    if (isDuplicate(err)) {
      const dup = await existingOperation(env, key);
      if (dup) return ok(await operationReceipt(env, dup.id, true));
    }
    throw mapBatchError(err);
  }
  const created = await existingOperation(env, key);
  return ok(await operationReceipt(env, created!.id, false));
}

export async function cambio(request: Request, env: Env, user: AuthUser): Promise<Response> {
  const body = await readJson(request);
  const key = uuid(body.idempotency_key, "idempotency_key");
  const ventaId = int(body.venta_id, "venta_id");
  const { codigo: motivoCodigo, motivo } = readReason(body);

  const sale = await getSaleOrFail(env, ventaId);
  requireBranch(user, sale.sucursal_id);
  if (sale.estado !== "completada") throw conflict("La venta está anulada; no admite cambios.");

  const repeated = await existingOperation(env, key);
  if (repeated) return ok(await operationReceipt(env, repeated.id, true));

  const { devueltos, valorDevuelto } = await returnPlan(env, sale, readReturnLines(body.items));

  if (!Array.isArray(body.reemplazos) || body.reemplazos.length === 0 || body.reemplazos.length > 100) {
    throw badRequest("Indica el producto de reemplazo (talla, color y cantidad).");
  }
  const entregados: EntregadoPlan[] = [];
  for (const [i, entry] of (body.reemplazos as unknown[]).entries()) {
    if (typeof entry !== "object" || entry === null) throw badRequest(`reemplazos[${i}] inválido.`);
    const e = entry as Record<string, unknown>;
    const productoId = int(e.producto_id, `reemplazos[${i}].producto_id`);
    const tallaId = int(e.talla_id, `reemplazos[${i}].talla_id`);
    const colorId = int(e.color_id, `reemplazos[${i}].color_id`);
    const cantidad = int(e.cantidad, `reemplazos[${i}].cantidad`, 1, 10_000);
    const [valid] = await validateVariants(env, [{ producto: productoId, talla: tallaId, color: colorId }], () => `reemplazos[${i}]`, true);
    const precio = e.precio_unitario === undefined || e.precio_unitario === null ? valid.precio_venta : Number(e.precio_unitario);
    if (!Number.isFinite(precio) || precio <= 0) throw badRequest(`reemplazos[${i}]: el modelo no tiene precio; indica precio_unitario.`);
    entregados.push({ productoId, tallaId, colorId, cantidad, precio: round2(precio) });
  }

  const valorEntregado = round2(entregados.reduce((a, e) => a + e.cantidad * e.precio, 0));
  const pago = paymentPlan(valorEntregado - valorDevuelto, body.liquidacion, body.metodo_pago);

  try {
    await runOperation(env, { tipo: "cambio", sale, user, motivo, motivoCodigo, key, devueltos, entregados, pago, valorDevuelto, valorEntregado, saleCancels: false });
  } catch (err) {
    if (isDuplicate(err)) {
      const dup = await existingOperation(env, key);
      if (dup) return ok(await operationReceipt(env, dup.id, true));
    }
    throw mapBatchError(err);
  }
  const created = await existingOperation(env, key);
  return ok(await operationReceipt(env, created!.id, false));
}

/** Anulación total de lo que falta por devolver. Solo administrador. Idempotente por venta. */
export async function anularVenta(request: Request, env: Env, admin: AuthUser, id: number): Promise<Response> {
  requireAdmin(admin);
  const body = await readJson(request);
  const { codigo: motivoCodigo, motivo } = readReason(body);

  const sale = await getSaleOrFail(env, id);
  requireBranch(admin, sale.sucursal_id); // un administrador solo anula ventas de su organización
  if (sale.estado === "cancelada") throw conflict("La venta ya está cancelada.");

  const lines = await saleLines(env, id);
  const pendientes = lines.filter((l) => l.cantidad - l.devuelta > 0);
  if (pendientes.length === 0) {
    throw conflict("No quedan unidades por anular: todo ya fue devuelto o cambiado. Usa la devolución correspondiente.");
  }

  const devueltos: DevueltoPlan[] = pendientes.map((l) => ({
    detalleId: l.detalle_id,
    productoId: l.producto_id,
    tallaId: l.talla_id,
    colorId: l.color_id,
    cantidad: l.cantidad - l.devuelta,
    precio: l.precio_unitario,
    condicion: "vendible",
  }));
  const valorDevuelto = round2(devueltos.reduce((a, d) => a + d.cantidad * d.precio, 0));
  const pago = paymentPlan(-valorDevuelto, body.liquidacion, body.metodo_pago);
  const key = `anulacion-${id}-${crypto.randomUUID()}`;

  try {
    await runOperation(env, { tipo: "anulacion", sale, user: admin, motivo, motivoCodigo, key, devueltos, entregados: [], pago, valorDevuelto, valorEntregado: 0, saleCancels: true });
  } catch (err) {
    throw mapBatchError(err);
  }

  const op = await env.DB.prepare("SELECT id FROM operaciones WHERE idempotency_key = ?").bind(key).first<{ id: number }>();
  await audit(env, admin.id, "cancelar_venta", "ventas", id, motivo);
  return ok({ id, estado: "cancelada", operacion: op ? await operationReceipt(env, op.id, false) : null });
}

function isDuplicate(err: unknown): boolean {
  return /UNIQUE constraint failed: operaciones\.idempotency_key/i.test(err instanceof Error ? err.message : String(err));
}



// ---------------------------------------------------------------- historial buscable de devoluciones y cambios

const likeText = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Historial de devoluciones, cambios y anulaciones con filtros combinables y paginación.
 * Cada fila trae la venta original, el cliente, el responsable, el motivo (código y texto), lo devuelto y lo entregado.
 */
export async function history(url: URL, env: Env, me: AuthUser): Promise<Response> {
  const where: string[] = [];
  const binds: unknown[] = [];

  const branch = scopedBranch(me, queryInt(url, "sucursal_id"));
  if (branch !== null) { where.push("o.sucursal_id = ?"); binds.push(branch); } else { where.push(orgBranchesSql(me, "o.sucursal_id")); }

  const tipo = url.searchParams.get("tipo");
  if (tipo) {
    where.push("o.tipo = ?");
    binds.push(oneOf(tipo, "tipo", ["devolucion", "cambio", "anulacion"] as const));
  }
  const motivo = url.searchParams.get("motivo_codigo");
  if (motivo) {
    if (motivo === "SIN_CLASIFICAR") where.push("o.motivo_codigo IS NULL");
    else { where.push("o.motivo_codigo = ?"); binds.push(oneOf(motivo, "motivo_codigo", RETURN_REASONS)); }
  }
  const usuario = queryInt(url, "usuario_id");
  if (usuario !== null) { where.push("o.usuario_id = ?"); binds.push(usuario); }
  const desde = queryDate(url, "desde");
  if (desde) { where.push("date(o.created_at, '-4 hours') >= ?"); binds.push(desde); }
  const hasta = queryDate(url, "hasta");
  if (hasta) { where.push("date(o.created_at, '-4 hours') <= ?"); binds.push(hasta); }

  const itemFilters: string[] = [];
  const itemBinds: unknown[] = [];
  for (const [param, column] of [["producto_id", "producto_id"], ["talla_id", "talla_id"], ["color_id", "color_id"]] as const) {
    const value = queryInt(url, param);
    if (value !== null) { itemFilters.push(`oi.${column} = ?`); itemBinds.push(value); }
  }
  if (itemFilters.length) {
    where.push(`EXISTS (SELECT 1 FROM operacion_items oi WHERE oi.operacion_id = o.id AND ${itemFilters.join(" AND ")})`);
    binds.push(...itemBinds);
  }

  const q = (url.searchParams.get("q") ?? "").trim();
  if (q) {
    if (q.length > 80) throw badRequest("La búsqueda es demasiado larga.");
    const ref = parseRef(q);
    const clauses = [
      "v.cliente_nombre LIKE ? ESCAPE '\\'", "v.cliente_telefono LIKE ? ESCAPE '\\'", "o.motivo LIKE ? ESCAPE '\\'", "u.nombre LIKE ? ESCAPE '\\'",
      `EXISTS (SELECT 1 FROM operacion_items oi JOIN productos p ON p.id = oi.producto_id JOIN tallas t ON t.id = oi.talla_id
               JOIN colores c ON c.id = oi.color_id
              WHERE oi.operacion_id = o.id AND (p.nombre LIKE ? ESCAPE '\\' OR t.nombre LIKE ? ESCAPE '\\' OR c.nombre LIKE ? ESCAPE '\\'))`,
    ];
    const vals: unknown[] = [likeText(q), likeText(q), likeText(q), likeText(q), likeText(q), likeText(q), likeText(q)];
    if (ref) {
      if (ref.kind === "V") { clauses.push("o.venta_id = ?"); vals.push(ref.id); }
      else if (ref.kind === "DV" || ref.kind === "CM" || ref.kind === "AN") {
        clauses.push("(o.id = ? AND o.tipo = ?)");
        vals.push(ref.id, ref.kind === "CM" ? "cambio" : ref.kind === "AN" ? "anulacion" : "devolucion");
      } else if (ref.kind === null) { clauses.push("(o.id = ? OR o.venta_id = ?)"); vals.push(ref.id, ref.id); }
    }
    where.push(`(${clauses.join(" OR ")})`);
    binds.push(...vals);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const from = `FROM operaciones o JOIN ventas v ON v.id = o.venta_id JOIN usuarios u ON u.id = o.usuario_id
                JOIN sucursales s ON s.id = o.sucursal_id ${whereSql}`;
  const limite = Math.min(queryInt(url, "limite") ?? 25, 100);
  const pagina = Math.max(queryInt(url, "pagina") ?? 1, 1);

  const [rows, total] = await env.DB.batch([
    env.DB
      .prepare(
        `SELECT o.id, o.tipo, o.venta_id, o.sucursal_id, s.nombre AS sucursal, o.usuario_id, u.nombre AS operador, o.motivo, o.motivo_codigo,
                o.valor_devuelto, o.valor_entregado, o.diferencia, o.pago_tipo, o.pago_estado, o.pago_metodo, o.monto_pago, o.created_at,
                v.cliente_nombre, v.cliente_telefono, v.fecha AS venta_fecha, v.total AS venta_total
           ${from} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limite, (pagina - 1) * limite),
    env.DB.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...binds),
  ]);

  const list = rows.results as Record<string, unknown>[];
  let items: Record<string, unknown>[] = [];
  if (list.length > 0) {
    const marks = list.map(() => "?").join(",");
    items = (
      await env.DB
        .prepare(
          `SELECT oi.operacion_id, oi.rol, oi.detalle_venta_id, oi.producto_id, p.nombre AS producto, oi.talla_id, t.nombre AS talla,
                  oi.color_id, c.nombre AS color, oi.cantidad, oi.precio_unitario, oi.condicion
             FROM operacion_items oi
             JOIN productos p ON p.id = oi.producto_id JOIN tallas t ON t.id = oi.talla_id JOIN colores c ON c.id = oi.color_id
            WHERE oi.operacion_id IN (${marks}) ORDER BY oi.id`,
        )
        .bind(...list.map((r) => r.id))
        .all<Record<string, unknown>>()
    ).results;
  }

  return ok({
    filas: list.map((r) => {
      const own = items.filter((i) => i.operacion_id === r.id);
      const strip = ({ operacion_id: _o, rol: _r, ...rest }: Record<string, unknown>) => { void _o; void _r; return rest; };
      return {
        id: r.id,
        referencia: operationRef(String(r.tipo), r.id as number),
        tipo: r.tipo,
        venta_id: r.venta_id,
        venta_referencia: saleRef(r.venta_id as number),
        venta_fecha: iso(r.venta_fecha as string),
        venta_total: r.venta_total,
        sucursal_id: r.sucursal_id,
        sucursal: r.sucursal,
        fecha: iso(r.created_at as string),
        operador: { id: r.usuario_id, nombre: r.operador },
        cliente_nombre: r.cliente_nombre,
        cliente_telefono: r.cliente_telefono,
        motivo: r.motivo,
        motivo_codigo: r.motivo_codigo ?? null,
        motivo_etiqueta: reasonLabel(r.motivo_codigo) ?? "Sin clasificar",
        valor_devuelto: r.valor_devuelto,
        valor_entregado: r.valor_entregado,
        diferencia: r.diferencia,
        pago: { tipo: r.pago_tipo, estado: r.pago_estado, metodo: r.pago_metodo, monto: r.monto_pago },
        devueltos: own.filter((i) => i.rol === "devuelto").map(strip),
        entregados: own.filter((i) => i.rol === "entregado").map(strip),
      };
    }),
    total: (total.results[0] as { n: number }).n,
    pagina,
    limite,
  });
}
