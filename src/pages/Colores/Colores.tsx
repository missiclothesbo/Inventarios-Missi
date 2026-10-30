import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Palette, Pencil, Plus, Search, X } from "lucide-react";

import { useAuth } from "../../context/useAuth";
import { colorNameError, cleanColorName, unassignedProducts, type ColorItem } from "../../lib/colores";
import { createColor, listAllColors, updateColor } from "../../services/colors.service";
import { getProducts, type Product } from "../../services/product.service";

const INPUT = "min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-black";
const BTN = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-60";

/** Casillas de modelos (una o varias). */
function ModelPicker({ products, selected, onChange, disabled }: { products: Product[]; selected: number[]; onChange: (ids: number[]) => void; disabled?: boolean }) {
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {products.map((p) => {
        const on = selected.includes(p.id);
        return (
          <label key={p.id} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${on ? "border-black bg-black text-white" : "border-gray-300 bg-white text-black hover:border-black"} ${disabled ? "opacity-60" : ""}`}>
            <input type="checkbox" className="sr-only" checked={on} disabled={disabled} onChange={() => toggle(p.id)} />
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${on ? "border-white" : "border-gray-400"}`}>{on ? "✓" : ""}</span>
            <span className="min-w-0 break-words">{p.nombre}</span>
          </label>
        );
      })}
    </div>
  );
}

/** Administración de colores y de los modelos a los que se ofrece cada uno (solo administrador). */
function Colores() {
  const { user } = useAuth();
  const isAdmin = user?.rol === "admin";

  const [colors, setColors] = useState<ColorItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [nameError, setNameError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<{ id: number; kind: "asignar" | "editar" } | null>(null);
  const [addIds, setAddIds] = useState<number[]>([]);
  const [renaming, setRenaming] = useState("");
  const formRef = useRef<HTMLInputElement>(null);

  const productName = useMemo(() => new Map(products.map((p) => [p.id, p.nombre])), [products]);

  const reload = useCallback(
    () =>
      Promise.all([listAllColors(), getProducts()]).then(([c, p]) => {
        setColors(c);
        setProducts(p.filter((x) => x.estado));
      }),
    [],
  );

  useEffect(() => {
    if (!isAdmin) return;
    reload()
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : "No se pudieron cargar los colores."))
      .finally(() => setLoading(false));
  }, [isAdmin, reload]);

  if (!isAdmin) {
    return <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">Solo un administrador puede gestionar colores.</div>;
  }

  /** Aplica un cambio, actualiza la lista sin recargar la página y muestra el resultado. */
  async function run(action: () => Promise<unknown>, success: string) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await action();
      await reload();
      setNotice(success);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el cambio.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submitNew(e: React.FormEvent) {
    e.preventDefault();
    const clean = cleanColorName(name);
    const problem = colorNameError(name, colors);
    setNameError(problem ?? "");
    if (problem) return;
    const ok = await run(() => createColor(clean, picked), `Color «${clean}» guardado${picked.length ? ` y asignado a ${picked.length} ${picked.length === 1 ? "modelo" : "modelos"}` : " (todavía sin modelos: asígnalo abajo)"}.`);
    if (ok) {
      setName("");
      setPicked([]);
      formRef.current?.focus();
    }
  }

  const visible = colors.filter((c) => !filter.trim() || c.nombre.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <section className="space-y-4 sm:space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-black sm:text-2xl">
          <Palette size={22} /> Colores
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Crea colores y elige para qué modelos se ofrecen. Al registrar mercadería de un modelo solo aparecen los colores asignados a él. Cambiar o desactivar un color nunca borra stock ni ventas.
        </p>
      </div>

      <div aria-live="polite" className="space-y-2 empty:hidden">
        {notice && <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{notice}</p>}
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      </div>

      <form onSubmit={submitNew} noValidate className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-gray-500">
          <Plus size={16} /> Nuevo color
        </h2>
        <div>
          <label htmlFor="color-nombre" className="mb-1 block text-xs font-medium text-gray-600">Nombre del color</label>
          <input
            id="color-nombre"
            ref={formRef}
            value={name}
            maxLength={60}
            autoComplete="off"
            placeholder="Ej. Verde oliva"
            aria-invalid={!!nameError}
            onChange={(e) => { setName(e.target.value); setNameError(""); setNotice(""); }}
            className={INPUT}
          />
          {nameError && <p data-field-error className="mt-1 text-xs text-red-600">{nameError}</p>}
        </div>
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-gray-600">¿Para qué modelos se ofrece? (uno o varios)</p>
            {products.length > 0 && (
              <button type="button" className="min-h-11 text-xs font-medium text-black underline underline-offset-4" onClick={() => setPicked(picked.length === products.length ? [] : products.map((p) => p.id))}>
                {picked.length === products.length ? "Quitar todos" : "Elegir todos"}
              </button>
            )}
          </div>
          {loading ? <p className="text-sm text-gray-500">Cargando modelos…</p> : <ModelPicker products={products} selected={picked} onChange={setPicked} disabled={saving} />}
        </div>
        <button type="submit" disabled={saving || loading} className={`${BTN} w-full bg-black text-white hover:bg-gray-800 sm:w-auto`}>
          {saving && <LoaderCircle size={16} className="animate-spin" />} GUARDAR COLOR
        </button>
      </form>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-gray-200 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <h2 className="text-lg font-semibold text-black">Colores y sus modelos <span className="text-sm font-normal text-gray-500">({colors.length})</span></h2>
          <label className="flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-3 focus-within:border-black sm:w-64">
            <Search size={16} className="shrink-0 text-gray-400" />
            <input type="search" aria-label="Buscar color" placeholder="Buscar color" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-11 w-full min-w-0 bg-transparent text-sm outline-none" />
          </label>
        </div>

        {loading ? (
          <p className="flex items-center gap-2 p-6 text-sm text-gray-500"><LoaderCircle size={16} className="animate-spin" /> Cargando colores…</p>
        ) : loadError ? (
          <div className="p-6 text-sm text-red-700">
            <p>{loadError}</p>
            <button type="button" onClick={() => { setLoading(true); setLoadError(""); reload().catch((e: unknown) => setLoadError(e instanceof Error ? e.message : "Error")).finally(() => setLoading(false)); }} className={`${BTN} mt-3 bg-black text-white`}>Reintentar</button>
          </div>
        ) : visible.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">{colors.length === 0 ? "Todavía no hay colores. Crea el primero arriba." : `Ningún color coincide con «${filter.trim()}».`}</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {visible.map((c) => {
              const assigned = c.producto_ids ?? [];
              const free = unassignedProducts(c, products);
              const isOpen = open?.id === c.id;
              return (
                <li key={c.id} className={`space-y-3 p-4 sm:p-5 ${c.estado ? "" : "bg-gray-50"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-black">
                        {c.nombre}
                        {!c.estado && <span className="ml-2 rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">Desactivado</span>}
                        {c.en_uso && <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">Con historial</span>}
                      </p>
                      <p className="text-xs text-gray-500">{assigned.length === 0 ? "Sin modelos asignados" : `${assigned.length} ${assigned.length === 1 ? "modelo" : "modelos"}`}</p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <button type="button" disabled={saving || free.length === 0} onClick={() => { setOpen(isOpen && open?.kind === "asignar" ? null : { id: c.id, kind: "asignar" }); setAddIds([]); }} className="min-h-11 rounded-lg border border-gray-300 px-3 hover:border-black disabled:opacity-50">
                        {free.length === 0 ? "En todos los modelos" : "Asignar a otro modelo"}
                      </button>
                      <button type="button" disabled={saving} onClick={() => { setOpen(isOpen && open?.kind === "editar" ? null : { id: c.id, kind: "editar" }); setRenaming(c.nombre); }} className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-gray-300 px-3 hover:border-black">
                        <Pencil size={13} /> Editar
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => {
                          if (c.estado && !window.confirm(`¿Desactivar «${c.nombre}»? Dejará de ofrecerse para mercadería nueva; el stock y las ventas existentes no cambian.`)) return;
                          void run(() => updateColor(c.id, { activo: !c.estado }), c.estado ? `«${c.nombre}» desactivado.` : `«${c.nombre}» activado.`);
                        }}
                        className={`min-h-11 rounded-lg border px-3 ${c.estado ? "border-red-200 text-red-700 hover:border-red-500" : "border-green-200 text-green-700 hover:border-green-500"}`}
                      >
                        {c.estado ? "Desactivar" : "Activar"}
                      </button>
                    </div>
                  </div>

                  <ul className="flex flex-wrap gap-2" aria-label={`Modelos de ${c.nombre}`}>
                    {assigned.map((pid) => (
                      <li key={pid} className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-white py-1 pl-3 pr-1 text-xs text-black">
                        {productName.get(pid) ?? `Modelo ${pid}`}
                        <button
                          type="button"
                          disabled={saving}
                          aria-label={`Quitar ${c.nombre} de ${productName.get(pid) ?? pid}`}
                          onClick={() => {
                            if (!window.confirm(`¿Quitar «${c.nombre}» de «${productName.get(pid) ?? pid}»? No se borra nada: solo deja de ofrecerse para mercadería nueva de ese modelo.`)) return;
                            void run(() => updateColor(c.id, { quitar: [pid] }), `«${c.nombre}» quitado de ${productName.get(pid) ?? "el modelo"}.`);
                          }}
                          className="-my-1 flex h-10 w-10 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-black"
                        >
                          <X size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>

                  {isOpen && open?.kind === "asignar" && (
                    <div className="space-y-3 rounded-lg border border-black p-3">
                      <p className="text-sm font-medium text-black">Asignar «{c.nombre}» a:</p>
                      <ModelPicker products={free} selected={addIds} onChange={setAddIds} disabled={saving} />
                      <div className="flex flex-col-reverse gap-2 sm:flex-row">
                        <button type="button" onClick={() => setOpen(null)} className={`${BTN} border border-gray-300`}>Cancelar</button>
                        <button type="button" disabled={saving || addIds.length === 0} onClick={async () => { if (await run(() => updateColor(c.id, { asignar: addIds }), `«${c.nombre}» asignado a ${addIds.length} ${addIds.length === 1 ? "modelo" : "modelos"}.`)) setOpen(null); }} className={`${BTN} bg-black text-white hover:bg-gray-800`}>
                          {saving && <LoaderCircle size={16} className="animate-spin" />} ASIGNAR
                        </button>
                      </div>
                    </div>
                  )}

                  {isOpen && open?.kind === "editar" && (
                    <div className="space-y-3 rounded-lg border border-black p-3">
                      <label htmlFor={`rename-${c.id}`} className="block text-sm font-medium text-black">Nombre del color</label>
                      <input id={`rename-${c.id}`} value={renaming} maxLength={60} onChange={(e) => setRenaming(e.target.value)} className={INPUT} />
                      {colorNameError(renaming, colors, c.id) && cleanColorName(renaming) !== c.nombre && <p className="text-xs text-red-600">{colorNameError(renaming, colors, c.id)}</p>}
                      <p className="text-xs text-gray-500">El cambio de nombre se ve también en el stock y las ventas existentes; no se pierde ningún registro.</p>
                      <div className="flex flex-col-reverse gap-2 sm:flex-row">
                        <button type="button" onClick={() => setOpen(null)} className={`${BTN} border border-gray-300`}>Cancelar</button>
                        <button
                          type="button"
                          disabled={saving || cleanColorName(renaming) === c.nombre || !!colorNameError(renaming, colors, c.id)}
                          onClick={async () => { if (await run(() => updateColor(c.id, { nombre: cleanColorName(renaming) }), `Nombre cambiado a «${cleanColorName(renaming)}».`)) setOpen(null); }}
                          className={`${BTN} bg-black text-white hover:bg-gray-800`}
                        >
                          {saving && <LoaderCircle size={16} className="animate-spin" />} GUARDAR NOMBRE
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

export default Colores;
