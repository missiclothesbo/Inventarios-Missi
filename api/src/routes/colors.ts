/**
 * Colores administrables y su asignación por modelo (migración 0014).
 * Solo el administrador crea, edita, asigna o desactiva colores (se valida en el servidor). Nada de lo que se haga aquí
 * borra stock, ventas ni historial: los ids de color no cambian, y quitar una asignación solo deja de ofrecer ese color
 * para registrar mercadería NUEVA del modelo.
 */
import { requireAdmin, type AuthUser } from "../auth";
import { isUniqueViolation } from "../db";
import { badRequest, conflict, notFound, ok, readJson, type Env } from "../http";
import { int } from "../validate";

/** Nombre para mostrar: espacios recortados y colapsados; conserva las mayúsculas que eligió el administrador. */
export function cleanColorName(value: unknown): string {
  if (typeof value !== "string") throw badRequest("Escribe el nombre del color.");
  const name = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) throw badRequest("Escribe el nombre del color.");
  if (name.length > 40) throw badRequest("El nombre del color es demasiado largo (máximo 40 caracteres).");
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'\-/]*$/u.test(name)) {
    throw badRequest("El nombre solo puede tener letras, números, espacios, punto, guion, apóstrofo o barra.");
  }
  return name;
}

/** Clave de comparación: sin importar mayúsculas ni espacios de más. */
export const colorKey = (name: string) => name.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("es");

function idList(value: unknown, field: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200) throw badRequest(`${field} debe ser una lista de modelos.`);
  return [...new Set(value.map((v, i) => int(v, `${field}[${i}]`)))];
}

async function existingProducts(env: Env, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const { results } = await env.DB
    .prepare(`SELECT id, nombre FROM productos WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: number; nombre: string }>();
  const found = new Map(results.map((p) => [p.id, p.nombre]));
  for (const id of ids) if (!found.has(id)) throw badRequest(`El modelo ${id} no existe.`);
  return found;
}

interface ColorRow { id: number; nombre: string; estado: number; created_at: string | null; en_uso: number }

async function shape(env: Env, ids?: number[]) {
  const where = ids ? `WHERE c.id IN (${ids.map(() => "?").join(",")})` : "";
  const [colors, links] = await env.DB.batch([
    env.DB
      .prepare(
        `SELECT c.id, c.nombre, c.estado, c.created_at,
                (EXISTS (SELECT 1 FROM inventario i WHERE i.color_id = c.id)
                 OR EXISTS (SELECT 1 FROM detalle_venta d WHERE d.color_id = c.id)
                 OR EXISTS (SELECT 1 FROM lotes l WHERE l.color_id = c.id)) AS en_uso
           FROM colores c ${where} ORDER BY c.nombre COLLATE NOCASE`,
      )
      .bind(...(ids ?? [])),
    env.DB.prepare("SELECT color_id, producto_id FROM producto_colores ORDER BY producto_id"),
  ]);
  const byColor = new Map<number, number[]>();
  for (const l of links.results as { color_id: number; producto_id: number }[]) {
    byColor.set(l.color_id, [...(byColor.get(l.color_id) ?? []), l.producto_id]);
  }
  return (colors.results as unknown as ColorRow[]).map((c) => ({
    id: c.id,
    nombre: c.nombre,
    estado: c.estado === 1,
    producto_ids: byColor.get(c.id) ?? [],
    en_uso: c.en_uso === 1,
  }));
}

/** Lista de colores. Cualquier usuario autenticado ve los activos; el administrador puede pedir todos (?todos=1). */
export async function listColors(url: URL, env: Env, user: AuthUser): Promise<Response> {
  const all = url.searchParams.get("todos") === "1" && user.rol === "admin";
  const rows = await shape(env);
  return ok(all ? rows : rows.filter((c) => c.estado));
}

async function findByName(env: Env, name: string, exceptId?: number) {
  const key = colorKey(name);
  const { results } = await env.DB.prepare("SELECT id, nombre FROM colores").all<{ id: number; nombre: string }>();
  return results.find((c) => c.id !== exceptId && colorKey(c.nombre) === key) ?? null;
}

const audit = (env: Env, userId: number, action: string, id: number, detail: string) =>
  env.DB
    .prepare("INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, detalle) VALUES (?, ?, 'colores', ?, ?)")
    .bind(userId, action, id, detail)
    .run();

/** Crea un color y lo asigna a los modelos elegidos (puede ser ninguno: se asigna después). */
export async function createColor(request: Request, env: Env, admin: AuthUser): Promise<Response> {
  requireAdmin(admin);
  const body = await readJson(request);
  const nombre = cleanColorName(body.nombre);
  const productIds = idList(body.producto_ids, "producto_ids");
  const products = await existingProducts(env, productIds);

  const dup = await findByName(env, nombre);
  if (dup) throw conflict(`Ya existe el color «${dup.nombre}». Usa ese color y asígnalo al modelo que necesites.`);

  const key = colorKey(nombre);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO colores (nombre, nombre_norm, estado, created_at, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").bind(nombre, key),
      ...productIds.map((pid) =>
        env.DB.prepare("INSERT OR IGNORE INTO producto_colores (producto_id, color_id) SELECT ?, id FROM colores WHERE nombre_norm = ?").bind(pid, key),
      ),
    ]);
  } catch (err) {
    // Dos peticiones a la vez con el mismo nombre: la base lo impide y aquí se informa claro.
    if (isUniqueViolation(err)) throw conflict("Ya existe un color con ese nombre.");
    throw err;
  }
  const created = await env.DB.prepare("SELECT id FROM colores WHERE nombre_norm = ?").bind(key).first<{ id: number }>();
  if (!created) throw conflict("No se pudo guardar el color.");
  await audit(env, admin.id, "crear_color", created.id, `${nombre} → ${[...products.values()].join(", ") || "sin modelos"}`);
  return ok((await shape(env, [created.id]))[0]);
}

/**
 * Edita un color: nombre, activo/inactivo y asignación a modelos (asignar / quitar).
 * Quitar o desactivar nunca borra stock, ventas ni historial.
 */
export async function updateColor(request: Request, env: Env, admin: AuthUser, id: number): Promise<Response> {
  requireAdmin(admin);
  const body = await readJson(request);
  const current = await env.DB.prepare("SELECT id, nombre, estado FROM colores WHERE id = ?").bind(id).first<{ id: number; nombre: string; estado: number }>();
  if (!current) throw notFound("Color no encontrado.");

  const statements: D1PreparedStatement[] = [];
  const notes: string[] = [];
  let changed = false;

  if (body.nombre !== undefined) {
    const nombre = cleanColorName(body.nombre);
    const dup = await findByName(env, nombre, id);
    if (dup) throw conflict(`Ya existe el color «${dup.nombre}».`);
    if (nombre !== current.nombre) {
      statements.push(env.DB.prepare("UPDATE colores SET nombre = ?, nombre_norm = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(nombre, colorKey(nombre), id));
      notes.push(`nombre «${current.nombre}» → «${nombre}»`);
      changed = true;
    }
  }

  if (body.activo !== undefined) {
    if (typeof body.activo !== "boolean") throw badRequest("activo debe ser verdadero o falso.");
    if ((body.activo ? 1 : 0) !== current.estado) {
      statements.push(env.DB.prepare("UPDATE colores SET estado = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(body.activo ? 1 : 0, id));
      notes.push(body.activo ? "activado" : "desactivado");
      changed = true;
    }
  }

  const add = idList(body.asignar, "asignar");
  const remove = idList(body.quitar, "quitar");
  if (add.some((x) => remove.includes(x))) throw badRequest("Un modelo no puede asignarse y quitarse a la vez.");
  const names = await existingProducts(env, [...add, ...remove]);
  const { results: links } = await env.DB.prepare("SELECT producto_id FROM producto_colores WHERE color_id = ?").bind(id).all<{ producto_id: number }>();
  const has = new Set(links.map((l) => l.producto_id));
  const already = add.filter((p) => has.has(p));
  const toAdd = add.filter((p) => !has.has(p));
  const toRemove = remove.filter((p) => has.has(p));
  for (const p of toAdd) statements.push(env.DB.prepare("INSERT OR IGNORE INTO producto_colores (producto_id, color_id) VALUES (?, ?)").bind(p, id));
  for (const p of toRemove) statements.push(env.DB.prepare("DELETE FROM producto_colores WHERE producto_id = ? AND color_id = ?").bind(p, id));
  if (toAdd.length) notes.push(`asignado a ${toAdd.map((p) => names.get(p)).join(", ")}`);
  if (toRemove.length) notes.push(`quitado de ${toRemove.map((p) => names.get(p)).join(", ")}`);
  if (toAdd.length || toRemove.length) changed = true;

  if (!changed) {
    if (already.length) throw conflict(`«${current.nombre}» ya está asignado a ${already.map((p) => names.get(p)).join(", ")}.`);
    throw badRequest("No hay cambios que guardar.");
  }

  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("Ya existe un color con ese nombre.");
    throw err;
  }
  await audit(env, admin.id, "editar_color", id, notes.join("; "));
  return ok({ ...(await shape(env, [id]))[0], ya_asignados: already });
}

/** Verifica (en el servidor) que cada color esté asignado a su modelo y activo: se usa al registrar stock NUEVO. */
export async function requireColorsAssigned(env: Env, items: { producto: number; color: number }[], label: (i: number) => string): Promise<void> {
  if (items.length === 0) return;
  const rows = await env.DB.batch(
    items.map((it) =>
      env.DB
        .prepare(
          `SELECT c.nombre AS color, p.nombre AS modelo, c.estado,
                  EXISTS (SELECT 1 FROM producto_colores pc WHERE pc.producto_id = p.id AND pc.color_id = c.id) AS asignado
             FROM productos p, colores c WHERE p.id = ? AND c.id = ?`,
        )
        .bind(it.producto, it.color),
    ),
  );
  rows.forEach((r, i) => {
    const row = r.results[0] as { color: string; modelo: string; estado: number; asignado: number } | undefined;
    if (!row) return; // modelo o color inexistente: ya lo rechaza validateVariants
    if (row.estado !== 1) throw badRequest(`${label(i)}: el color «${row.color}» está desactivado.`);
    if (row.asignado !== 1) throw badRequest(`${label(i)}: el color «${row.color}» no está asignado al modelo «${row.modelo}». Asígnalo en Colores.`);
  });
}
