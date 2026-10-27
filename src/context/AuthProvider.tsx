
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { api } from "../lib/api";
import { ApiError } from "../lib/apiClient";
import {
  clearSession,
  getStoredUser,
  getToken,
  onSessionChange,
  setSession,
  type SessionUser,
} from "../lib/session";
import { AuthContext } from "./auth";

interface LoginResponse {
  token: string;
  expires_at: string | null;
  user: SessionUser;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(() =>
    getToken() ? getStoredUser() : null,
  );

  const [loading, setLoading] = useState<boolean>(
    () => getToken() !== null,
  );

  useEffect(
    () =>
      onSessionChange(() =>
        setUser(getToken() ? getStoredUser() : null),
      ),
    [],
  );

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    api
      .get<SessionUser>("/api/auth/me")
      // El servidor manda: rol, sucursal y nombre vigentes reemplazan a los guardados.
      .then((me) => setSession(token, me))
      .catch((err) => {
        // Un 401 ya cerró la sesión (onUnauthorized). Si solo falló la conexión, se conserva la
        // sesión guardada: la app mostrará el error de conexión y bastará con reintentar.
        if (!(err instanceof ApiError && (err.code === "RED" || err.code === "TIMEOUT")) || !getStoredUser()) {
          clearSession();
        }
      })
      .finally(() => setLoading(false));
  }, []);

  // Acepta correo electrónico o nombre de usuario.
  const login = useCallback(
    async (identifier: string, password: string) => {
      const result = await api.post<LoginResponse>(
        "/api/auth/login",
        {
          identifier: identifier.trim(),
          password,
        },
      );

      setSession(result.token, result.user);
      setUser(result.user);
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/api/auth/logout");
    } catch {
      // Se cierra la sesión local aunque falle la conexión.
    }

    clearSession();
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, logout }),
    [user, loading, login, logout],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
