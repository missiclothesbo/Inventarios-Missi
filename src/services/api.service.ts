import { api } from "../lib/api";

export interface ApiHealth {
  service: string;
}

/** Sucursal tal como la devuelve la API (D1). */
export interface ApiSucursal {
  id: number;
  codigo: string;
  nombre: string;
  es_central: boolean;
}

export interface ApiConnectionReport {
  configured: boolean;
  baseUrl: string | null;
  health: { ok: boolean; ms: number; detail: string };
  sucursales: { ok: boolean; ms: number; detail: string; rows: ApiSucursal[] };
}

async function timed<T>(fn: () => Promise<T>) {
  const start = performance.now();

  try {
    const value = await fn();
    return { ok: true as const, ms: Math.round(performance.now() - start), value };
  } catch (err) {
    return {
      ok: false as const,
      ms: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : "Error desconocido",
    };
  }
}

/**
 * Prueba NO destructiva (solo GET /api/health y GET /api/sucursales).
 * No modifica nada ni afecta otros flujos.
 */
export async function testApiConnection(): Promise<ApiConnectionReport> {
  if (api.configError) {
    const detail = api.configError;
    return {
      configured: false,
      baseUrl: null,
      health: { ok: false, ms: 0, detail },
      sucursales: { ok: false, ms: 0, detail, rows: [] },
    };
  }

  const [health, branches] = await Promise.all([
    timed(() => api.get<ApiHealth>("/api/health")),
    timed(() => api.get<ApiSucursal[]>("/api/sucursales")),
  ]);

  return {
    configured: true,
    baseUrl: api.baseUrl,
    health: health.ok
      ? { ok: true, ms: health.ms, detail: health.value.service ?? "OK" }
      : { ok: false, ms: health.ms, detail: health.error },
    sucursales:
      branches.ok && Array.isArray(branches.value)
        ? { ok: true, ms: branches.ms, detail: `${branches.value.length} sucursales`, rows: branches.value }
        : {
            ok: false,
            ms: branches.ms,
            detail: branches.ok ? "Formato de respuesta inesperado" : branches.error,
            rows: [],
          },
  };
}
