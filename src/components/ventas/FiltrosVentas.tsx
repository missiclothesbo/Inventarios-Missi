import { useState } from "react";
import { Filter, X } from "lucide-react";

import { FILTRO_INPUT, FiltroPeriodo } from "../filtros/FiltroPeriodo";
import { DEPARTMENTS, sortSizeLabels } from "../../lib/catalogo";
import { filtrosActivos, type VentasFiltrosState } from "../../lib/ventasFiltros";

interface Named {
  id: number;
  nombre: string;
}

interface Props {
  value: VentasFiltrosState;
  onChange: (patch: Partial<VentasFiltrosState>) => void;
  onReset: () => void;
  isAdmin: boolean;
  branches: Named[];
  products: Named[];
  sizes: Named[];
  colors: Named[];
  users: Named[];
  periodError: string | null;
}

/** Filtros del historial de ventas. En el móvil se pliegan detrás del botón «Filtros» para no ocupar la pantalla. */
function FiltrosVentas({ value, onChange, onReset, isAdmin, branches, products, sizes, colors, users, periodError }: Props) {
  const [open, setOpen] = useState(false);
  const active = filtrosActivos(value);
  const orderedSizes = (() => {
    const order = new Map(sortSizeLabels(sizes.map((s) => s.nombre)).map((n, i) => [n, i]));
    return [...sizes].sort((a, b) => (order.get(a.nombre) ?? 0) - (order.get(b.nombre) ?? 0));
  })();

  return (
    <div className="border-b border-gray-200 p-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-gray-200 px-3 focus-within:border-black">
          <input
            type="search"
            aria-label="Buscar venta por referencia o cliente"
            placeholder="V-000123, cliente o teléfono"
            maxLength={80}
            value={value.q}
            onChange={(e) => onChange({ q: e.target.value })}
            className="w-full min-w-0 bg-transparent text-sm outline-none"
          />
        </label>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-4 text-sm font-medium text-gray-700 hover:border-black"
        >
          <Filter size={16} /> Filtros{active > 0 ? ` (${active})` : ""}
        </button>
        {active > 0 && (
          <button type="button" onClick={onReset} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm font-medium text-red-600 underline underline-offset-4">
            <X size={15} /> Limpiar filtros
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FiltroPeriodo preset={value.preset} custom={value.custom} onPreset={(preset) => onChange({ preset })} onCustom={(custom) => onChange({ custom })} error={periodError} />

          {isAdmin && (
            <label className="text-xs font-medium text-gray-600">
              Sucursal
              <select className={`${FILTRO_INPUT} mt-1`} value={value.sucursal} onChange={(e) => onChange({ sucursal: e.target.value })}>
                <option value="MENU">Según el menú lateral</option>
                <option value="TODAS">Todas las ubicaciones</option>
                {branches.map((b) => <option key={b.id} value={String(b.id)}>{b.nombre}</option>)}
              </select>
            </label>
          )}

          <label className="text-xs font-medium text-gray-600">
            Estado de la venta
            <select className={`${FILTRO_INPUT} mt-1`} value={value.estado} onChange={(e) => onChange({ estado: e.target.value as VentasFiltrosState["estado"] })}>
              <option value="">Todas</option>
              <option value="completada">Completadas</option>
              <option value="cancelada">Canceladas</option>
            </select>
          </label>

          <label className="text-xs font-medium text-gray-600">
            Método de pago
            <select className={`${FILTRO_INPUT} mt-1`} value={value.metodo} onChange={(e) => onChange({ metodo: e.target.value as VentasFiltrosState["metodo"] })}>
              <option value="">Todos</option>
              <option value="efectivo">Efectivo</option>
              <option value="QR">QR</option>
            </select>
          </label>

          <label className="text-xs font-medium text-gray-600">
            Tipo de entrega
            <select className={`${FILTRO_INPUT} mt-1`} value={value.modalidad} onChange={(e) => onChange({ modalidad: e.target.value as VentasFiltrosState["modalidad"] })}>
              <option value="">Todos</option>
              <option value="entrega_directa">Entrega directa</option>
              <option value="envio">Envío a departamento</option>
              <option value="envio_interprovincial">Envío interprovincial</option>
            </select>
          </label>

          <label className="text-xs font-medium text-gray-600">
            Departamento de destino
            <select className={`${FILTRO_INPUT} mt-1`} value={value.departamento} onChange={(e) => onChange({ departamento: e.target.value })}>
              <option value="">Todos</option>
              {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
              <option value="SIN_REGISTRAR">Envío sin departamento registrado</option>
            </select>
          </label>

          <label className="text-xs font-medium text-gray-600">
            Provincia
            <input className={`${FILTRO_INPUT} mt-1`} maxLength={100} value={value.provincia} onChange={(e) => onChange({ provincia: e.target.value })} />
          </label>
          <label className="text-xs font-medium text-gray-600">
            Municipio
            <input className={`${FILTRO_INPUT} mt-1`} maxLength={100} value={value.municipio} onChange={(e) => onChange({ municipio: e.target.value })} />
          </label>

          <label className="text-xs font-medium text-gray-600">
            Modelo
            <select className={`${FILTRO_INPUT} mt-1`} value={value.producto} onChange={(e) => onChange({ producto: e.target.value })}>
              <option value="">Todos</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600">
            Talla
            <select className={`${FILTRO_INPUT} mt-1`} value={value.talla} onChange={(e) => onChange({ talla: e.target.value })}>
              <option value="">Todas</option>
              {orderedSizes.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600">
            Color
            <select className={`${FILTRO_INPUT} mt-1`} value={value.color} onChange={(e) => onChange({ color: e.target.value })}>
              <option value="">Todos</option>
              {colors.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </label>

          {isAdmin && (
            <label className="text-xs font-medium text-gray-600">
              Responsable (vendedor)
              <select className={`${FILTRO_INPUT} mt-1`} value={value.usuario} onChange={(e) => onChange({ usuario: e.target.value })}>
                <option value="">Todos</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

export default FiltrosVentas;
