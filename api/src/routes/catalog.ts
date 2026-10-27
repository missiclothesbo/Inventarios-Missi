import { orgBranchesSql, requireAdmin, requireBranch, scopedBranch, type AuthUser } from "../auth";
import { isStockViolation, isUniqueViolation, iso } from "../db";
import { badRequest, conflict, HttpError, notFound, ok, readJson, type Env } from "../http";
import { stockChange, validateVariants } from "../inventory";
import { EXIT_REASONS, EXIT_REASON_LABELS } from "../../../shared/catalogo";
import { int, money, oneOf, optionalStr, queryInt, str, uuid } from "../validate";

export async function sucursales(env: Env, user: AuthUser): Promise<Response> {
  const { results } = await env.DB
    .prepare(
      `SELECT s.id, s.codigo, s.nombre, s.es_central, s.tipo, s.organizacion_id,
              (SELECT o.nombre FROM organizaciones o WHERE o.id = s.organizacion_id) AS organizacion
         FROM sucursales s WHERE s.activa = 1 ORDER BY s.es_central DESC, s.nombre`,
    )
    .all<{ id: number; codigo: string; nombre: string; es_central: number; tipo: string; organizacion_id: number | null; organizacion: string | null }>();

  // Un vendedor solo ve su sucursal.
  // Solo las sucursales a las que el servidor le permite acceder (su organización; un vendedor, la suya).
  const visible = results.filter((s) => user.branch_ids.includes(s.id));
  // es_almacen: MISSI BOLIVIA es el almacén central (ubicación con stock propio, distinta de las tiendas).
  return ok(visible.map((s) => ({ ...s, es_central: s.es_central === 1, es_almacen: s.tipo === "almacen" })));
}

export async function departamentos(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT id, nombre FROM departamentos WHERE estado = 1 ORDER BY id").all();
  return ok(results);
}

/** URL relativa de la foto. El parámetro v cambia con cada subida, así el navegador no usa una copia vieja. */
export function photoUrl(id: number, key: string | null): string | null {
  if (!key) return null;
  const version = key.slice(key.lastIndexOf("/") + 1).replace(/\.[a-z]+$/, "");
  return `/api/productos/${id}/foto?v=${version}`;
}

export async function productos(env: Env): Promise<Response> {
  const { results } = await env.DB
    .prepare("SELECT id, nombre, activo, precio_venta, fecha_creacion, foto_key FROM productos ORDER BY id")
    .all<{ id: number; nombre: string; activo: number; precio_venta: number; fecha_creacion: string; foto_key: string | null }>();

  return ok(
    results.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      estado: p.activo === 1,
      precio_venta: p.precio_venta,
      foto_url: photoUrl(p.id, p.foto_key),
      created_at: iso(p.fecha_creacion),
    })),
  );
}

// ---------------------------------------------------------------- fotos (una por modelo)

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Confirma el tipo real del archivo por sus primeros bytes (no solo por la cabecera enviada). */
function sniffImage(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  const webp = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
  if (webp.every((byte, i) => byte === 0 || b[i] === byte)) return "image/webp";
  return null;
}

/** Sube la foto de un modelo (solo admin). Cuerpo = bytes de la imagen; reemplaza la anterior. */
export async function uploadPhoto(request: Request, env: Env, admin: AuthUser, id: number): Promise<Response> {
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!PHOTO_TYPES[type]) throw new HttpError(415, "La foto debe ser JPG, PNG o WebP.");

  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_PHOTO_BYTES) throw new HttpError(413, "La foto supera el máximo de 2 MB.");

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) throw badRequest("La foto está vacía.");
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, "La foto supera el máximo de 2 MB.");
  if (sniffImage(bytes) !== type) throw badRequest("El contenido no corresponde al tipo de imagen indicado.");

  const product = await env.DB.prepare("SELECT foto_key FROM productos WHERE id = ?").bind(id).first<{ foto_key: string | null }>();
  if (!product) throw notFound("Producto no encontrado.");

  const key = `productos/${id}/${crypto.randomUUID()}.${PHOTO_TYPES[type]}`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare("UPDATE productos SET foto_key = ? WHERE id = ?").bind(key, id).run();
  if (product.foto_key) await env.PHOTOS.delete(product.foto_key);

  await env.DB
    .prepare("INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, detalle) VALUES (?, 'subir_foto', 'productos', ?, ?)")
    .bind(admin.id, id, key)
    .run();

  return ok({ id, foto_url: photoUrl(id, key) });
}

/** Foto pública (las etiquetas img no envían cabeceras de sesión). Solo lectura. */
export async function getPhoto(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare("SELECT foto_key FROM productos WHERE id = ?").bind(id).first<{ foto_key: string | null }>();
  if (!row?.foto_key) throw notFound("Este modelo no tiene foto.");

  const object = await env.PHOTOS.get(row.foto_key);
  if (!object) throw notFound("Este modelo no tiene foto.");

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function tallas(env: Env): Promise<Response> {
  // Orden oficial de pantalón primero; las tallas históricas (oficial_pantalon = 0) al final y solo de lectura:
  // la interfaz no las ofrece para inventario nuevo, pero siguen existiendo para leer el historial.
  const { results } = await env.DB
    .prepare("SELECT id, nombre, orden, oficial_pantalon, etiqueta_historica FROM tallas ORDER BY orden, id")
    .all<{ id: number; nombre: string; orden: number; oficial_pantalon: number; etiqueta_historica: string | null }>();
  return ok(
    results.map((t) => ({
      id: t.id,
      nombre: t.nombre,
      orden: t.orden,
      estado: true,
      oficial_pantalon: t.oficial_pantalon === 1,
      etiqueta_historica: t.etiqueta_historica,
    })),
  );
}

export async function colores(env: Env): Promise<Response> {
  const { results } = await env.DB
    .prepare("SELECT id, nombre, estado FROM colores WHERE estado = 1 ORDER BY nombre")
    .all<{ id: number; nombre: string; estado: number }>();
  return ok(results.map((c) => ({ ...c, estado: true })));
}

export async function createProduct(request: Request, env: Env, admin: AuthUser): Promise<Response> {
  const body = await readJson(request);
  const nombre = str(body.nombre, "nombre", 120);
  const precio = body.precio_venta === undefined ? 0 : money(body.precio_venta, "precio_venta");

  try {
    const res = await env.DB
      .prepare("INSERT INTO productos (nombre, precio_venta) VALUES (?, ?)")
      .bind(nombre, precio)
      .run();
    const id = Number(res.meta.last_row_id);
    await env.DB
      .prepare("INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, detalle) VALUES (?, 'crear_producto', 'productos', ?, ?)")
      .bind(admin.id, id, nombre)
      .run();
    return ok({ id, nombre, estado: true, precio_venta: precio, created_at: new Date().toISOString() });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("Ya existe un producto con ese nombre.");
    throw err;
  }
}

export async function updateProductPrice(request: Request, env: Env, id: number): Promise<Response> {
  const body = await readJson(request);
  const precio = money(body.precio_venta, "precio_venta");
  const res = await env.DB.prepare("UPDATE productos SET precio_venta = ? WHERE id = ?").bind(precio, id).run();
  if (res.meta.changes === 0) throw notFound("Producto no encontrado.");
  return ok({ id, precio_venta: precio });
}

interface InventoryRow {
  id: number;
  sucursal_id: number | null;
  cantidad: number;
  producto_id: number;
  producto_nombre: string;
  talla_id: number;
  talla_nombre: string;
  color_id: number;
  color_nombre: string;
  registrado?: string;
  ingreso_fecha?: string | null;
  lotes_con_stock?: number;
}

export async function inventory(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const branch = scopedBranch(user, queryInt(url, "sucursal_id"));

  // Sin sucursal (solo admin) = consolidado: una fila por variante con la suma de todas.
  const sql =
    branch === null
      ? `SELECT MIN(i.id) AS id, NULL AS sucursal_id, SUM(i.cantidad) AS cantidad,
                i.producto_id, p.nombre AS producto_nombre, i.talla_id, t.nombre AS talla_nombre,
                i.color_id, c.nombre AS color_nombre
           FROM inventario i
           JOIN productos p ON p.id = i.producto_id
           JOIN tallas t ON t.id = i.talla_id
           JOIN colores c ON c.id = i.color_id
          WHERE ${orgBranchesSql(user, "i.sucursal_id")}
          GROUP BY i.producto_id, i.talla_id, i.color_id
          ORDER BY MIN(i.id)`
      : `SELECT i.id, i.sucursal_id, i.cantidad, i.producto_id, p.nombre AS producto_nombre,
                i.talla_id, t.nombre AS talla_nombre, i.color_id, c.nombre AS color_nombre, i.created_at AS registrado,
                -- Ingreso a ESTA ubicación del lote más antiguo que aún tiene stock (UTC; NULL = fecha desconocida).
                (SELECT MIN(l.fecha_llegada) FROM lotes l WHERE l.sucursal_id = i.sucursal_id AND l.producto_id = i.producto_id
                    AND l.talla_id = i.talla_id AND l.color_id = i.color_id AND l.cantidad_restante > 0) AS ingreso_fecha,
                (SELECT COUNT(*) FROM lotes l WHERE l.sucursal_id = i.sucursal_id AND l.producto_id = i.producto_id
                    AND l.talla_id = i.talla_id AND l.color_id = i.color_id AND l.cantidad_restante > 0) AS lotes_con_stock
           FROM inventario i
           JOIN productos p ON p.id = i.producto_id
           JOIN tallas t ON t.id = i.talla_id
           JOIN colores c ON c.id = i.color_id
          WHERE i.sucursal_id = ?
          ORDER BY i.id`;

  const stmt = env.DB.prepare(sql);
  const { results } = await (branch === null ? stmt : stmt.bind(branch)).all<InventoryRow>();

  return ok(
    results.map((r) => ({
      id: r.id,
      sucursal_id: r.sucursal_id,
      cantidad: r.cantidad,
      producto: { id: r.producto_id, nombre: r.producto_nombre },
      talla: { id: r.talla_id, nombre: r.talla_nombre },
      color: { id: r.color_id, nombre: r.color_nombre },
      // Fecha y hora de ingreso a esta ubicación. Si es desconocida (stock anterior a los lotes), se informa cuándo se
      // registró en el sistema, sin presentarlo como fecha de llegada.
      ingreso: r.registrado === undefined ? null : { fecha: iso(r.ingreso_fecha ?? null), registrado: iso(r.registrado), lotes: r.lotes_con_stock ?? 0 },
    })),
  );
}

/** Ingreso de stock (solo admin). Idempotente por la cabecera Idempotency-Key. */
export async function addStock(request: Request, env: Env, admin: AuthUser): Promise<Response> {
  requireAdmin(admin);
  const key = uuid(request.headers.get("Idempotency-Key"), "Idempotency-Key");
  const body = await readJson(request);
  const v = {
    sucursal: int(body.sucursal_id, "sucursal_id"),
    producto: int(body.producto_id, "producto_id"),
    talla: int(body.talla_id, "talla_id"),
    color: int(body.color_id, "color_id"),
    qty: int(body.cantidad, "cantidad", 1, 100_000),
  };
  const notas = optionalStr(body.notas, "notas", 300);
  requireBranch(admin, v.sucursal); // solo sucursales de MI organización

  const branch = await env.DB.prepare("SELECT 1 AS ok FROM sucursales WHERE id = ? AND activa = 1").bind(v.sucursal).first();
  if (!branch) throw new HttpError(400, "Sucursal, producto, talla o color inválido.");
  // Talla oficial obligatoria para pantalones nuevos (la misma regla del catálogo compartido).
  try {
    await validateVariants(env, [{ producto: v.producto, talla: v.talla, color: v.color }], "ingreso");
  } catch (err) {
    if (err instanceof HttpError && /inexistente o inactivo/.test(err.message)) throw new HttpError(400, "Sucursal, producto, talla o color inválido.");
    throw err;
  }

  try {
    await env.DB.batch([
      // Si la clave ya existe, esta sentencia falla y TODO el lote se revierte (no se suma dos veces).
      env.DB.prepare("INSERT INTO idempotencia (clave, ruta, usuario_id) VALUES (?, 'inventario/agregar', ?)").bind(key, admin.id),
      // Lote nuevo: llegó ahora (este ingreso rápido se registra al recibir la mercadería).
      ...stockChange(env, {
        ...v, categoria: "INGRESO", signo: 1, tipo: "entrada", usuarioId: admin.id,
        refTipo: "ingreso_manual", refIdSql: "NULL", refIdBinds: [], observaciones: notas,
        lote: { nuevo: { origen: "ingreso", fechaRecepcionSql: "CURRENT_TIMESTAMP", notas } },
      }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return ok({ repetido: true });
    throw err;
  }

  return ok({ repetido: false });
}

/** Valida sucursal y variante existentes (sin exigir talla oficial: se puede dar de baja stock histórico). */
async function requireVariantExists(env: Env, v: { sucursal: number; producto: number; talla: number; color: number }) {
  const valid = await env.DB
    .prepare(
      `SELECT 1 AS ok FROM sucursales s, productos p, tallas t, colores c
        WHERE s.id = ? AND s.activa = 1 AND p.id = ? AND t.id = ? AND c.id = ?`,
    )
    .bind(v.sucursal, v.producto, v.talla, v.color)
    .first();
  if (!valid) throw new HttpError(400, "Sucursal, producto, talla o color inválido.");
}

const STOCK_EXIT_ERRORS = /CHECK constraint failed: cantidad|operacion_validacion|CHECK constraint failed: ok/i;

/**
 * Salida de stock que NO es una venta (producto dañado, pérdida, muestra, obsequio). Solo admin, idempotente,
 * con motivo obligatorio y asiento SALIDA en el libro. Nunca deja el stock negativo.
 */
export async function removeStock(request: Request, env: Env, admin: AuthUser): Promise<Response> {
  requireAdmin(admin);
  const key = uuid(request.headers.get("Idempotency-Key"), "Idempotency-Key");
  const body = await readJson(request);
  const v = {
    sucursal: int(body.sucursal_id, "sucursal_id"),
    producto: int(body.producto_id, "producto_id"),
    talla: int(body.talla_id, "talla_id"),
    color: int(body.color_id, "color_id"),
    qty: int(body.cantidad, "cantidad", 1, 100_000),
  };
  const motivo = oneOf(body.motivo_codigo, "motivo_codigo", EXIT_REASONS);
  const detalle = optionalStr(body.detalle, "detalle", 300);
  if (motivo === "OTRO" && (detalle ?? "").length < 3) throw badRequest("Explica el motivo de la salida.");
  requireBranch(admin, v.sucursal);
  await requireVariantExists(env, v);

  // Sale de los lotes más antiguos (FIFO); stockChange verifica lotes y fila de stock dentro del mismo lote.
  const changes = stockChange(env, {
    ...v, categoria: "SALIDA", signo: -1, tipo: "ajuste", usuarioId: admin.id, refTipo: "salida_manual",
    refIdSql: "NULL", refIdBinds: [], observaciones: detalle ?? EXIT_REASON_LABELS[motivo], motivoCodigo: motivo,
  });

  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO idempotencia (clave, ruta, usuario_id) VALUES (?, 'inventario/salida', ?)").bind(key, admin.id),
      ...changes,
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return ok({ repetido: true });
    if (isStockViolation(err) || STOCK_EXIT_ERRORS.test(String((err as Error)?.message ?? err))) {
      throw conflict("Stock insuficiente en esa sucursal para registrar la salida. No se guardó nada.");
    }
    throw err;
  }
  return ok({ repetido: false });
}

/**
 * Ajuste autorizado de inventario (corrección positiva o negativa). Solo admin, idempotente, motivo obligatorio.
 * Es un movimiento nuevo (AJUSTE): el historial anterior nunca se edita.
 */
export async function adjustStock(request: Request, env: Env, admin: AuthUser): Promise<Response> {
  requireAdmin(admin);
  const key = uuid(request.headers.get("Idempotency-Key"), "Idempotency-Key");
  const body = await readJson(request);
  const delta = int(body.delta, "delta", -100_000, 100_000);
  if (delta === 0) throw badRequest("El ajuste no puede ser 0.");
  const v = {
    sucursal: int(body.sucursal_id, "sucursal_id"),
    producto: int(body.producto_id, "producto_id"),
    talla: int(body.talla_id, "talla_id"),
    color: int(body.color_id, "color_id"),
    qty: Math.abs(delta),
  };
  const motivo = str(body.motivo, "motivo", 300);
  if (motivo.length < 3) throw badRequest("Explica el motivo del ajuste.");
  requireBranch(admin, v.sucursal);
  await requireVariantExists(env, v);
  if (delta > 0) {
    await validateVariants(env, [{ producto: v.producto, talla: v.talla, color: v.color }], "ajuste");
  }

  const changes = stockChange(env, {
    ...v, categoria: "AJUSTE", signo: delta > 0 ? 1 : -1, tipo: "ajuste", usuarioId: admin.id, refTipo: "ajuste_manual",
    refIdSql: "NULL", refIdBinds: [], observaciones: motivo,
  });
  // Ajuste +: lote nuevo con fecha de ingreso desconocida. Ajuste −: descuenta los lotes más antiguos (FIFO).
  const statements = [
    env.DB.prepare("INSERT INTO idempotencia (clave, ruta, usuario_id) VALUES (?, 'inventario/ajuste', ?)").bind(key, admin.id),
    ...changes,
  ];

  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err)) return ok({ repetido: true });
    if (isStockViolation(err) || STOCK_EXIT_ERRORS.test(String((err as Error)?.message ?? err))) {
      throw conflict("El ajuste dejaría el stock en negativo. No se guardó nada.");
    }
    throw err;
  }
  return ok({ repetido: false });
}

export async function dashboard(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const branch = scopedBranch(user, queryInt(url, "sucursal_id"));
  const filter = branch === null ? `AND ${orgBranchesSql(user, "sucursal_id")}` : "AND sucursal_id = ?";
  const bind = (stmt: D1PreparedStatement) => stmt; // claridad: los binds se agregan abajo

  const withBranch = (sql: string) => {
    const stmt = env.DB.prepare(sql);
    return bind(branch === null ? stmt : stmt.bind(branch));
  };

  const [stock, products, today, recent, low] = await env.DB.batch([
    withBranch(`SELECT COALESCE(SUM(cantidad), 0) AS total FROM inventario WHERE 1 = 1 ${filter}`),
    env.DB.prepare("SELECT COUNT(*) AS total FROM productos WHERE activo = 1"),
    withBranch(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS ingresos FROM ventas
        WHERE estado = 'completada' AND date(fecha, '-4 hours') = date('now', '-4 hours') ${filter}`,
    ),
    withBranch(
      `SELECT id, fecha, total FROM ventas WHERE estado = 'completada' ${filter} ORDER BY fecha DESC, id DESC LIMIT 5`,
    ),
    branch === null
      ? env.DB.prepare(
          `SELECT MIN(i.id) AS id, p.nombre AS producto, t.nombre AS talla, c.nombre AS color, SUM(i.cantidad) AS cantidad
             FROM inventario i JOIN productos p ON p.id = i.producto_id JOIN tallas t ON t.id = i.talla_id
             JOIN colores c ON c.id = i.color_id
            WHERE ${orgBranchesSql(user, "i.sucursal_id")}
            GROUP BY i.producto_id, i.talla_id, i.color_id HAVING SUM(i.cantidad) BETWEEN 1 AND 3
            ORDER BY SUM(i.cantidad), MIN(i.id) LIMIT 5`,
        )
      : env.DB
          .prepare(
            `SELECT i.id, p.nombre AS producto, t.nombre AS talla, c.nombre AS color, i.cantidad
               FROM inventario i JOIN productos p ON p.id = i.producto_id JOIN tallas t ON t.id = i.talla_id
               JOIN colores c ON c.id = i.color_id
              WHERE i.sucursal_id = ? AND i.cantidad BETWEEN 1 AND 3 ORDER BY i.cantidad, i.id LIMIT 5`,
          )
          .bind(branch),
  ]);

  const first = <T>(r: D1Result) => (r.results[0] ?? {}) as T;

  return ok({
    stats: {
      totalStock: first<{ total: number }>(stock).total ?? 0,
      totalProducts: first<{ total: number }>(products).total ?? 0,
      salesToday: first<{ n: number }>(today).n ?? 0,
      incomeToday: first<{ ingresos: number }>(today).ingresos ?? 0,
    },
    recentSales: (recent.results as { id: number; fecha: string; total: number }[]).map((s) => ({
      id: s.id,
      fecha: iso(s.fecha),
      total: s.total,
    })),
    lowStockItems: low.results,
  });
}
