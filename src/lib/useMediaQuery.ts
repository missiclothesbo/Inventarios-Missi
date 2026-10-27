import { useCallback, useSyncExternalStore } from "react";

/** Puntos de quiebre de Tailwind usados en la app (móvil primero). */
export const MQ = {
  md: "(min-width: 768px)",
  xl: "(min-width: 1280px)",
} as const;

/** true si la consulta CSS coincide; se actualiza al rotar o cambiar el tamaño de la ventana. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
