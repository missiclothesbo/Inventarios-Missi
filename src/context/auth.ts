
import { createContext } from "react";

import type { SessionUser } from "../lib/session";

export interface AuthContextValue {
  user: SessionUser | null;

  /** true mientras se valida una sesión guardada al abrir la app */
  loading: boolean;

  /** Inicia sesión con correo electrónico o nombre de usuario y contraseña */
  login: (identifier: string, password: string) => Promise<void>;

  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  login: async () => undefined,
  logout: async () => undefined,
});
