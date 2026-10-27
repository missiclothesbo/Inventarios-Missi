/**
 * Validación del formulario de cuentas (solo administrador). Refleja las reglas del servidor
 * (api/src/auth.ts), que vuelve a validar todo. Sin dependencias: se prueba en Node.
 */
export type Rol = "admin" | "vendedor";

export interface UserForm {
  nombre: string;
  email: string;
  username: string;
  rol: Rol;
  sucursalId: string;
  password: string;
  password2: string;
}

export type UserErrors = Partial<Record<keyof UserForm, string>>;

export const EMPTY_USER: UserForm = { nombre: "", email: "", username: "", rol: "vendedor", sucursalId: "", password: "", password2: "" };

export const MIN_PASSWORD = 12;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,29}$/;

export const normalizeEmail = (v: string) => v.trim().toLowerCase();
export const normalizeUsername = (v: string) => v.trim().toLowerCase();

export function passwordError(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`;
  if (password.length > 200) return "La contraseña es demasiado larga.";
  if (password !== confirm) return "Las contraseñas no coinciden.";
  return null;
}

/** Errores del formulario de alta. Vacío = se puede enviar. */
export function validateNewUser(f: UserForm): UserErrors {
  const e: UserErrors = {};
  if (!f.nombre.trim()) e.nombre = "Escribe el nombre.";
  else if (f.nombre.trim().length > 120) e.nombre = "Máximo 120 caracteres.";
  if (!EMAIL.test(normalizeEmail(f.email))) e.email = "Correo inválido.";
  const u = normalizeUsername(f.username);
  if (u && !USERNAME.test(u)) e.username = "3 a 30 caracteres: letras, números, punto, guion o guion bajo (sin @).";
  if (f.rol === "vendedor" && !f.sucursalId) e.sucursalId = "Un vendedor debe tener sucursal.";
  const p = passwordError(f.password, f.password2);
  if (p) e.password = p;
  return e;
}

export interface EditForm {
  nombre: string;
  username: string;
  rol: Rol;
  sucursalId: string;
}

export function validateEdit(f: EditForm): Partial<Record<keyof EditForm, string>> {
  const e: Partial<Record<keyof EditForm, string>> = {};
  if (!f.nombre.trim()) e.nombre = "Escribe el nombre.";
  else if (f.nombre.trim().length > 120) e.nombre = "Máximo 120 caracteres.";
  const u = normalizeUsername(f.username);
  if (u && !USERNAME.test(u)) e.username = "3 a 30 caracteres: letras, números, punto, guion o guion bajo (sin @).";
  if (f.rol === "vendedor" && !f.sucursalId) e.sucursalId = "Un vendedor debe tener sucursal.";
  return e;
}

/**
 * Solo los campos que cambiaron (PATCH parcial). `permisos` indica si cambia rol o sucursal:
 * el servidor cierra entonces las sesiones de esa cuenta.
 */
export function editPatch(
  original: { nombre: string; username: string | null; rol: Rol; sucursal_id: number | null },
  f: EditForm,
) {
  const patch: { nombre?: string; username?: string | null; rol?: Rol; sucursal_id?: number | null } = {};
  const nombre = f.nombre.trim();
  if (nombre !== original.nombre) patch.nombre = nombre;
  const username = normalizeUsername(f.username) || null;
  if (username !== (original.username ?? null)) patch.username = username;
  const sucursal = f.rol === "vendedor" ? Number(f.sucursalId) : null;
  const permisos = f.rol !== original.rol || sucursal !== original.sucursal_id;
  if (permisos) {
    patch.rol = f.rol;
    patch.sucursal_id = sucursal;
  }
  return { patch, permisos };
}

/** SQLite guarda CURRENT_TIMESTAMP en UTC sin zona ("AAAA-MM-DD HH:MM:SS"): se marca como UTC. */
export function sqliteUtcToIso(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
}

/** Cuerpo para POST /api/usuarios (datos normalizados; sin campos que el servidor no espera). */
export function newUserPayload(f: UserForm) {
  const u = normalizeUsername(f.username);
  return {
    nombre: f.nombre.trim(),
    email: normalizeEmail(f.email),
    ...(u ? { username: u } : {}),
    rol: f.rol,
    sucursal_id: f.rol === "vendedor" ? Number(f.sucursalId) : null,
    password: f.password,
  };
}
