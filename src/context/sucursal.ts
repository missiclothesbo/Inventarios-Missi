import { createContext } from "react";

import type { Branch } from "../services/branches.service";

export interface SucursalContextValue {
  branches: Branch[];
  /** null = vista consolidada (todas las sucursales) */
  selectedId: number | null;
  selected: Branch | null;
  setSelectedId: (id: number | null) => void;
  loading: boolean;
  error: string;
  reload: () => void;
}

export const SucursalContext = createContext<SucursalContextValue>({
  branches: [],
  selectedId: null,
  selected: null,
  setSelectedId: () => undefined,
  loading: true,
  error: "",
  reload: () => undefined,
});
