import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { getBranches, type Branch } from "../services/branches.service";
import { SucursalContext } from "./sucursal";

const STORAGE_KEY = "missi.sucursal";

/** undefined = el usuario aún no eligió; número = una ubicación. (Antes existía la opción «todas»; ya no.) */
type Choice = number | null | undefined;

function readStored(): Choice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "all") return undefined;
    return raw && Number.isInteger(Number(raw)) ? Number(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function SucursalProvider({ children }: { children: ReactNode }) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [choice, setChoice] = useState<Choice>(readStored);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchBranches = useCallback(() => {
    getBranches()
      .then((data) => {
        setBranches(data);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Error al cargar sucursales."),
      )
      .finally(() => setLoading(false));
  }, []);

  // El estado inicial ya es loading=true, así que la carga inicial no necesita setState previo.
  useEffect(() => {
    fetchBranches();
  }, [fetchBranches]);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    fetchBranches();
  }, [fetchBranches]);

  // Selección efectiva: la elegida si sigue siendo válida; si no, la ubicación principal (Almacén Central).
  const selectedId = useMemo<number | null>(() => {
    if (branches.length === 0) return choice ?? null;
    if (choice !== undefined && branches.some((b) => b.id === choice)) return choice;
    return branches.find((b) => b.es_central)?.id ?? branches[0].id;
  }, [branches, choice]);

  const value = useMemo(
    () => ({
      branches,
      selectedId,
      selected: branches.find((b) => b.id === selectedId) ?? null,
      setSelectedId: (id: number | null) => {
        if (id === null) return;
        setChoice(id);
        try {
          localStorage.setItem(STORAGE_KEY, String(id));
        } catch {
          /* almacenamiento no disponible: se ignora */
        }
      },
      loading,
      error,
      reload: load,
    }),
    [branches, selectedId, loading, error, load],
  );

  return (
    <SucursalContext.Provider value={value}>
      {children}
    </SucursalContext.Provider>
  );
}
