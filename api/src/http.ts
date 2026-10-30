export interface Env {
  DB: D1Database;
  /** Opcional: sin R2 activado en la cuenta, las fotos de productos quedan desactivadas (el resto funciona). */
  PHOTOS?: R2Bucket;
  ALLOWED_ORIGINS: string;
  SESSION_TTL_HOURS: string;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const unauthorized = (m = "No autenticado.") => new HttpError(401, m);
export const forbidden = (m = "No tienes permiso para esta operación.") => new HttpError(403, m);
export const notFound = (m = "No encontrado.") => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

/** Cabeceras CORS: solo origenes configurados. Sin cookies, asi que no se usa credentials. */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const headers: Record<string, string> = { Vary: "Origin" };

  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Idempotency-Key";
    headers["Access-Control-Max-Age"] = "600";
  }

  return headers;
}

export function json(data: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
}

export const ok = (data: unknown, extra: Record<string, string> = {}) =>
  json({ ok: true, data }, 200, extra);

const MAX_BODY_BYTES = 64 * 1024;

/** Lee un cuerpo JSON de tamaño acotado; siempre devuelve un objeto. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.includes("application/json")) {
    throw badRequest("El cuerpo debe ser JSON (Content-Type: application/json).");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new HttpError(413, "Cuerpo demasiado grande.");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest("JSON inválido.");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("El cuerpo debe ser un objeto JSON.");
  }

  return value as Record<string, unknown>;
}
