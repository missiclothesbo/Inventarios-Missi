import { useContext } from "react";

import { SucursalContext } from "./sucursal";

export function useSucursal() {
  return useContext(SucursalContext);
}
