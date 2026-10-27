import { DUMMY_HASH, hashPassword, randomToken, sha256Hex, verifyPassword } from "./crypto";
import { forbidden, HttpError, ok, readJson, unauthorized, type Env } from "./http";
import { oneOf, optionalInt, str } from "./validate";

export type Role = "admin" | "vendedor";

export interface AuthUser {
  id: number;
  email: string;
  username: string | null;
  nombre: string;
  rol: Role;
  sucursal_id: number | null;
  /** Organización matriz (MISSI BOLIVIA) a la que pertenece el usuario. */
  organizacion_id: number | null;
  organizacion: string | null;
  /**
   * Sucursales a las que PUEDE acceder según el servidor: un administrador, todas las de su organización;
   * un vendedor, solo la suya. Nunca viene del cliente.
   */
  branch_ids: number[];
}

interface LoginUser extends Omit<AuthUser, "branch_ids"> {
  password_hash: string;
  activo: number;
}

const MAX_FAILED_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 12;
const LOGIN_ERROR = "Correo, usuario o contraseña incorrectos.";
const BEARER = /^Bearer ([A-Za-z0-9_-]{20,100})$/;
// Sin "@" para que un nombre de usuario nunca pueda confundirse con un correo.
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,29}$/;

export function validatePassword(password: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
    throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
  return password;
}

export function validateUsername(value: unknown): string {
  const username = str(value, "username", 30).toLowerCase();
  if (!USERNAME.test(username)) {
    throw new HttpError(400, "El nombre de usuario debe tener 3 a 30 caracteres (letras, números, punto, guion o guion bajo) y no puede contener @.");
  }
  return username;
}

function sessionHours(env: Env): number {
  const n = Number(env.SESSION_TTL_HOURS);
  return Number.isFinite(n) && n > 0 && n <= 72 ? n : 12;
}

/** Devuelve el usuario de la sesión o lanza 401. Los tokens solo existen en claro en el cliente. */
export async function authenticate(request: Request, env: Env): Promise<AuthUser> {
  const match = BEARER.exec(request.headers.get("Authorization") ?? "");
  if (!match) throw unauthorized();

  const tokenHash = await sha256Hex(match[1]);
  const row = await env.DB
    .prepare(
      `SELECT u.id, u.email, u.username, u.nombre, u.rol, u.sucursal_id, u.organizacion_id,
              (SELECT o.nombre FROM organizaciones o WHERE o.id = u.organizacion_id) AS organizacion
         FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
        WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.activo = 1`,
    )
    .bind(tokenHash)
    .first<Omit<AuthUser, "branch_ids">>();

  if (!row) throw unauthorized("Sesión inválida o vencida.");

  // Sucursales accesibles (todas las de la organización, activas o no: el historial de una sucursal cerrada sigue siendo legible).
  let branchIds: number[] = [];
  if (row.organizacion_id !== null) {
    const { results } = await env.DB
      .prepare("SELECT id FROM sucursales WHERE organizacion_id = ? ORDER BY id")
      .bind(row.organizacion_id)
      .all<{ id: number }>();
    branchIds = results.map((b) => b.id);
  }
  if (row.rol !== "admin") branchIds = branchIds.filter((id) => id === row.sucursal_id);

  return { ...row, branch_ids: branchIds };
}

export function requireAdmin(user: AuthUser): void {
  if (user.rol !== "admin") throw forbidden("Solo un administrador puede realizar esta acción.");
}

/** Admin: cualquier sucursal de su organización. Vendedor: solo la suya. */
export function requireBranch(user: AuthUser, branchId: number): void {
  if (!user.branch_ids.includes(branchId)) {
    throw forbidden("No tienes acceso a esa sucursal.");
  }
}

/**
 * Condición SQL para consultas consolidadas (sin sucursal elegida): limita a las sucursales de la organización del usuario,
 * de modo que "todas" nunca incluye datos de otra organización. Los ids vienen de la base (enteros), no del cliente.
 */
export function orgBranchesSql(user: AuthUser, column: string): string {
  return user.branch_ids.length ? `${column} IN (${user.branch_ids.join(",")})` : "1 = 0";
}

/** Sucursal efectiva de una consulta: el vendedor siempre queda acotado a la suya. */
export function scopedBranch(user: AuthUser, requested: number | null): number | null {
  if (requested !== null && !user.branch_ids.includes(requested)) {
    throw forbidden("No tienes acceso a esa sucursal.");
  }
  if (user.rol === "admin") return requested;
  return user.sucursal_id;
}

export async function audit(
  env: Env,
  userId: number | null,
  action: string,
  entity: string,
  entityId: number | null,
  detail: string | null,
): Promise<void> {
  await env.DB
    .prepare("INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, detalle) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, action, entity, entityId, detail)
    .run();
}

/** Acepta `identifier` (correo o usuario). Por compatibilidad también `email` o `username`. */
function readIdentifier(body: Record<string, unknown>): string {
  for (const candidate of [body.identifier, body.email, body.username]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

export async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const raw = readIdentifier(body);

  if (!raw || raw.length > 254 || /[\r\n]/.test(raw)) throw unauthorized(LOGIN_ERROR);

  const identifier = raw.toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";

  // Correo o nombre de usuario, sin distinguir mayúsculas.
  const user = await env.DB
    .prepare(
      `SELECT id, email, username, nombre, rol, sucursal_id, password_hash, activo, organizacion_id,
              (SELECT o.nombre FROM organizaciones o WHERE o.id = usuarios.organizacion_id) AS organizacion
         FROM usuarios
        WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE
        LIMIT 1`,
    )
    .bind(identifier, identifier)
    .first<LoginUser>();

  // Los intentos se cuentan por cuenta (correo) si existe, o por el texto ingresado si no.
  const attemptKey = (user?.email ?? identifier).toLowerCase();

  const recent = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM intentos_login WHERE email = ? AND ocurrido_en > datetime('now', '-15 minutes')")
    .bind(attemptKey)
    .first<{ n: number }>();

  if ((recent?.n ?? 0) >= MAX_FAILED_ATTEMPTS) {
    throw new HttpError(429, "Demasiados intentos fallidos. Inténtalo de nuevo en 15 minutos.");
  }

  // Siempre se calcula un hash para no revelar (por tiempo) si la cuenta existe.
  const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);

  if (!user || !valid || user.activo !== 1) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM intentos_login WHERE ocurrido_en <= datetime('now', '-1 day')"),
      env.DB.prepare("INSERT INTO intentos_login (email) VALUES (?)").bind(attemptKey),
    ]);
    throw unauthorized(LOGIN_ERROR);
  }

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const hours = sessionHours(env);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM sesiones WHERE expires_at <= datetime('now')"),
    env.DB.prepare("DELETE FROM intentos_login WHERE email = ? OR ocurrido_en <= datetime('now', '-1 day')").bind(attemptKey),
    env.DB
      .prepare("INSERT INTO sesiones (token_hash, usuario_id, expires_at) VALUES (?, ?, datetime('now', ?))")
      .bind(tokenHash, user.id, `+${hours} hours`),
    env.DB.prepare("UPDATE usuarios SET ultimo_login = CURRENT_TIMESTAMP WHERE id = ?").bind(user.id),
  ]);

  const expires = await env.DB
    .prepare("SELECT expires_at FROM sesiones WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ expires_at: string }>();

  return ok({
    token,
    expires_at: expires?.expires_at ?? null,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      nombre: user.nombre,
      rol: user.rol,
      sucursal_id: user.sucursal_id,
      organizacion_id: user.organizacion_id,
      organizacion: user.organizacion,
    },
  });
}

/** Invalida solo la sesión que hace la petición. */
export async function logout(request: Request, env: Env): Promise<Response> {
  const match = BEARER.exec(request.headers.get("Authorization") ?? "");
  if (match) {
    await env.DB.prepare("DELETE FROM sesiones WHERE token_hash = ?").bind(await sha256Hex(match[1])).run();
  }
  return ok({ cerrada: true });
}

// -- usuarios (solo admin)

/** Solo las cuentas de la organización del administrador. */
export async function listUsers(env: Env, admin: AuthUser): Promise<Response> {
  const { results } = await env.DB
    .prepare("SELECT id, email, username, nombre, rol, sucursal_id, activo, created_at, ultimo_login FROM usuarios WHERE organizacion_id = ? ORDER BY id")
    .bind(admin.organizacion_id)
    .all();
  return ok(results);
}

function uniqueError(err: unknown): HttpError | null {
  const msg = err instanceof Error ? err.message : "";
  if (/UNIQUE/i.test(msg)) {
    return new HttpError(409, /username/i.test(msg) ? "Ya existe un usuario con ese nombre de usuario." : "Ya existe un usuario con ese correo.");
  }
  if (/FOREIGN KEY/i.test(msg)) return new HttpError(400, "La sucursal no existe.");
  return null;
}

export async function createUser(request: Request, env: Env, admin: AuthUser): Promise<Response> {
  const body = await readJson(request);
  const email = str(body.email, "email", 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Correo inválido.");
  const username = body.username === undefined || body.username === null || body.username === "" ? null : validateUsername(body.username);
  const nombre = str(body.nombre, "nombre", 120);
  const rol = oneOf(body.rol, "rol", ["admin", "vendedor"] as const);
  const sucursalId = optionalInt(body.sucursal_id, "sucursal_id");
  const password = validatePassword(body.password);

  if (rol === "vendedor" && sucursalId === null) throw new HttpError(400, "Un vendedor debe tener sucursal asignada.");
  if (rol === "admin" && sucursalId !== null) throw new HttpError(400, "Un administrador no se asigna a una sucursal.");
  // La sucursal debe ser de la organización del administrador que crea la cuenta (nunca de otra organización).
  if (sucursalId !== null && !admin.branch_ids.includes(sucursalId)) throw new HttpError(400, "La sucursal no existe.");

  const passwordHash = await hashPassword(password);

  try {
    const res = await env.DB
      .prepare("INSERT INTO usuarios (email, username, nombre, password_hash, rol, sucursal_id, organizacion_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(email, username, nombre, passwordHash, rol, sucursalId, admin.organizacion_id)
      .run();
    const id = Number(res.meta.last_row_id);
    await audit(env, admin.id, "crear_usuario", "usuarios", id, `${rol} ${email}`);
    return ok({ id, email, username, nombre, rol, sucursal_id: sucursalId });
  } catch (err) {
    throw uniqueError(err) ?? err;
  }
}

export async function updateUser(request: Request, env: Env, admin: AuthUser, id: number): Promise<Response> {
  const body = await readJson(request);
  // Solo se pueden modificar cuentas de la propia organización (las demás "no existen" para este administrador).
  const target = await env.DB.prepare("SELECT organizacion_id FROM usuarios WHERE id = ?").bind(id).first<{ organizacion_id: number | null }>();
  if (!target || target.organizacion_id !== admin.organizacion_id) throw new HttpError(404, "Usuario no encontrado.");
  const statements: D1PreparedStatement[] = [];
  let revoke = false;

  if (body.activo !== undefined) {
    if (typeof body.activo !== "boolean") throw new HttpError(400, "activo debe ser booleano.");
    if (id === admin.id && !body.activo) throw new HttpError(400, "No puedes desactivar tu propia cuenta.");
    statements.push(env.DB.prepare("UPDATE usuarios SET activo = ? WHERE id = ?").bind(body.activo ? 1 : 0, id));
    if (!body.activo) revoke = true;
  }

  if (body.username !== undefined) {
    const username = body.username === null || body.username === "" ? null : validateUsername(body.username);
    statements.push(env.DB.prepare("UPDATE usuarios SET username = ? WHERE id = ?").bind(username, id));
  }

  if (body.nombre !== undefined) {
    statements.push(env.DB.prepare("UPDATE usuarios SET nombre = ? WHERE id = ?").bind(str(body.nombre, "nombre", 120), id));
  }

  // Rol y sucursal se validan juntos: un vendedor siempre tiene sucursal; un administrador no.
  if (body.rol !== undefined || body.sucursal_id !== undefined) {
    const current = await env.DB
      .prepare("SELECT rol, sucursal_id FROM usuarios WHERE id = ?")
      .bind(id)
      .first<{ rol: Role; sucursal_id: number | null }>();
    if (!current) throw new HttpError(404, "Usuario no encontrado.");
    const rol = body.rol !== undefined ? oneOf(body.rol, "rol", ["admin", "vendedor"] as const) : current.rol;
    const sucursal = body.sucursal_id !== undefined ? optionalInt(body.sucursal_id, "sucursal_id") : current.sucursal_id;
    if (id === admin.id && rol !== "admin") throw new HttpError(400, "No puedes quitarte el rol de administrador.");
    const finalSucursal = rol === "admin" ? null : sucursal;
    if (finalSucursal !== null && !admin.branch_ids.includes(finalSucursal)) throw new HttpError(400, "La sucursal no existe.");
    if (rol === "vendedor" && finalSucursal === null) throw new HttpError(400, "Un vendedor debe tener sucursal asignada.");
    statements.push(env.DB.prepare("UPDATE usuarios SET rol = ?, sucursal_id = ? WHERE id = ?").bind(rol, finalSucursal, id));
    // Si cambiaron los permisos, la persona debe volver a iniciar sesión.
    if (rol !== current.rol || finalSucursal !== current.sucursal_id) revoke = true;
  }

  if (body.password !== undefined) {
    const hash = await hashPassword(validatePassword(body.password));
    statements.push(env.DB.prepare("UPDATE usuarios SET password_hash = ? WHERE id = ?").bind(hash, id));
    revoke = true;
  }

  if (statements.length === 0) throw new HttpError(400, "No hay cambios que aplicar.");
  if (revoke) statements.push(env.DB.prepare("DELETE FROM sesiones WHERE usuario_id = ?").bind(id));

  let results: D1Result[];
  try {
    results = await env.DB.batch(statements);
  } catch (err) {
    throw uniqueError(err) ?? err;
  }
  if (results[0].meta.changes === 0) throw new HttpError(404, "Usuario no encontrado.");

  await audit(env, admin.id, "actualizar_usuario", "usuarios", id, null);
  return ok({ id });
}
