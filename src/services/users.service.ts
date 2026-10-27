import { api } from "../lib/api";
import type { Rol } from "../lib/usuarios";

export interface UserRow {
  id: number;
  email: string;
  username: string | null;
  nombre: string;
  rol: Rol;
  sucursal_id: number | null;
  activo: number;
  created_at: string;
  ultimo_login: string | null;
}

export const listUsers = () => api.get<UserRow[]>("/api/usuarios");

export const createUser = (payload: {
  nombre: string;
  email: string;
  username?: string;
  rol: Rol;
  sucursal_id: number | null;
  password: string;
}) => api.post<{ id: number }>("/api/usuarios", payload);

export const updateUser = (
  id: number,
  patch: Partial<{ nombre: string; username: string | null; rol: Rol; sucursal_id: number | null; activo: boolean; password: string }>,
) => api.patch<{ id: number }>(`/api/usuarios/${id}`, patch);
