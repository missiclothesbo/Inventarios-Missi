import { createApiClient } from "./apiClient";
import { clearSession, getToken } from "./session";

/**
 * Cliente del Worker de Cloudflare (D1), configurado con VITE_API_BASE_URL.
 * Envía el token de sesión y, si el servidor responde 401, cierra la sesión local.
 */
export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL,
  getToken,
  onUnauthorized: clearSession,
});
