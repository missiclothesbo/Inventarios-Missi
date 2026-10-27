/**
 * Cliente HTTP mínimo para el Worker de Cloudflare (MISSI API).
 *
 * - No toca import.meta.env ni otras fuentes de datos: la configuración se inyecta, por eso es
 *   testeable en Node (ver scripts/test-api-client.mjs).
 * - Autenticación por token Bearer opaco (getToken). Sin cookies (credentials: "omit"),
 *   por lo que no hay superficie CSRF. Si el servidor responde 401 se avisa con onUnauthorized
 *   para que la app cierre la sesión.
 * - Solo permite rutas /api/... del host configurado.
 */

/** Sobre de respuesta del Worker: `{ok:true,data}` / `{ok:true,...campos}` / `{ok:false,error}`. */
export type ApiEnvelope<T> =
  | ({ ok: true; data: T } & Record<string, unknown>)
  | { ok: false; error: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: "CONFIG" | "RED" | "TIMEOUT" | "HTTP" | "RESPUESTA";

  constructor(
    message: string,
    code: "CONFIG" | "RED" | "TIMEOUT" | "HTTP" | "RESPUESTA",
    status = 0,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export interface ApiClientOptions {
  /** Valor crudo de VITE_API_BASE_URL (puede estar vacío o ser inválido). */
  baseUrl: string | undefined;
  /** Milisegundos antes de abortar cada petición. Por defecto 10 000. */
  timeoutMs?: number;
  /** Para pruebas; por defecto el fetch global. */
  fetchImpl?: typeof fetch;
  /** Token de sesión actual (o null). Se envía como Authorization: Bearer. */
  getToken?: () => string | null;
  /** Se invoca cuando la API responde 401 estando autenticado. */
  onUnauthorized?: () => void;
}

export interface RequestOptions {
  body?: unknown;
  /** Cuerpo binario (p. ej. una foto). Si se usa, `contentType` es obligatorio y `body` se ignora. */
  raw?: Blob;
  contentType?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Devuelve el origen normalizado, o un texto de error en español. */
export function parseBaseUrl(
  raw: string | undefined,
): { url: string; error: "" } | { url: ""; error: string } {
  const value = (raw ?? "").trim();

  if (!value) {
    return { url: "", error: "Falta la variable VITE_API_BASE_URL en el archivo .env." };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { url: "", error: "VITE_API_BASE_URL no es una URL válida (ej.: https://mi-worker.workers.dev)." };
  }

  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";

  if (parsed.protocol !== "https:" && !(isLocal && parsed.protocol === "http:")) {
    return { url: "", error: "VITE_API_BASE_URL debe empezar con https:// (http solo en localhost)." };
  }

  if (parsed.username || parsed.password) {
    return { url: "", error: "VITE_API_BASE_URL no debe contener usuario ni contraseña." };
  }

  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return { url: "", error: "VITE_API_BASE_URL debe ser solo el dominio, sin rutas (las rutas /api/... las agrega el cliente)." };
  }

  return { url: parsed.origin, error: "" };
}

export function createApiClient(options: ApiClientOptions) {
  const { url: base, error: configError } = parseBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<T>(method: "GET" | "POST" | "PATCH", path: string, opts: RequestOptions = {}): Promise<T> {
    const { signal } = opts;
    if (configError) {
      throw new ApiError(configError, "CONFIG");
    }

    // Solo rutas internas /api/...: evita construir URLs hacia otros hosts.
    if (!/^\/api\/[A-Za-z0-9/_-]*(\?[A-Za-z0-9=&_%.+-]*)?$/.test(path)) {
      throw new ApiError(`Ruta de API no permitida: ${path}`, "CONFIG");
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });

    let response: Response;
    try {
      const token = options.getToken?.() ?? null;
      response = await doFetch(base + path, {
        method,
        headers: {
          Accept: "application/json",
          ...(opts.raw ? { "Content-Type": opts.contentType ?? "application/octet-stream" } : opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...opts.headers,
        },
        body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
        credentials: "omit",
        signal: controller.signal,
      });
    } catch {
      if (timedOut) {
        throw new ApiError(`La API no respondió en ${timeoutMs / 1000} s.`, "TIMEOUT");
      }
      if (signal?.aborted) {
        throw new ApiError("Solicitud cancelada.", "RED");
      }
      throw new ApiError(
        `No se pudo conectar con la API (${new URL(base).host}). El backend no está respondiendo: en una terminal, desde la carpeta api, ejecuta "npm run dev" y deja esa ventana abierta.`,
        "RED",
      );
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        `La API devolvió una respuesta que no es JSON (HTTP ${response.status}).`,
        "RESPUESTA",
        response.status,
      );
    }

    const envelope = body as Partial<ApiEnvelope<T>> | null;

    if (!response.ok || !envelope || envelope.ok !== true) {
      const detail =
        envelope && envelope.ok === false && typeof envelope.error === "string"
          ? envelope.error
          : `HTTP ${response.status}`;
      if (response.status === 401 && options.getToken?.()) options.onUnauthorized?.();
      throw new ApiError(detail, "HTTP", response.status);
    }

    // /api/health responde {ok,service} sin `data`: se devuelve el resto de campos.
    if ("data" in envelope) {
      return envelope.data as T;
    }

    const { ok: _ok, ...rest } = envelope as Record<string, unknown>;
    void _ok;
    return rest as T;
  }

  return {
    /** null si la configuración es válida. */
    configError: configError || null,
    baseUrl: base || null,
    get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, { signal }),
    post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>("POST", path, { body: body ?? {}, headers }),
    patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, { body }),
    /** Sube un archivo como cuerpo binario (sin multipart): el servidor valida el tipo real. */
    upload: <T>(path: string, file: Blob, contentType: string) =>
      request<T>("POST", path, { raw: file, contentType }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
