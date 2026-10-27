/**
 * Sesión del usuario. El token es opaco (no contiene datos) y se guarda en sessionStorage:
 * se pierde al cerrar la pestaña y no se comparte entre pestañas. Si el almacenamiento no está
 * disponible se mantiene solo en memoria.
 */
export interface SessionUser {
  id: number;
  email: string;
  username?: string | null;
  nombre: string;
  rol: "admin" | "vendedor";
  sucursal_id: number | null;
  organizacion_id?: number | null;
  organizacion?: string | null;
}

const TOKEN_KEY = "missi.token";
const USER_KEY = "missi.user";

let memoryToken: string | null = null;
let memoryUser: SessionUser | null = null;
const listeners = new Set<() => void>();

function readStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* sin almacenamiento: queda en memoria */
  }
}

export function getToken(): string | null {
  return memoryToken ?? readStorage(TOKEN_KEY);
}

export function getStoredUser(): SessionUser | null {
  if (memoryUser) return memoryUser;
  const raw = readStorage(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: SessionUser) {
  memoryToken = token;
  memoryUser = user;
  writeStorage(TOKEN_KEY, token);
  writeStorage(USER_KEY, JSON.stringify(user));
  listeners.forEach((fn) => fn());
}

export function clearSession() {
  memoryToken = null;
  memoryUser = null;
  writeStorage(TOKEN_KEY, null);
  writeStorage(USER_KEY, null);
  listeners.forEach((fn) => fn());
}

export function onSessionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
