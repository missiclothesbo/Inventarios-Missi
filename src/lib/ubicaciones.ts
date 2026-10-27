/**
 * Ubicaciones operativas: Almacén Central, MISSI Santa Cruz y MISSI Cochabamba (cada una con su propio stock).
 * El nombre "MISSI BOLIVIA" ya no se muestra como ubicación.
 */
export const TODAS_LAS_UBICACIONES = "Todas las ubicaciones";

export function branchLabel(b: { nombre: string; es_almacen?: boolean }): string {
  return b.nombre;
}
