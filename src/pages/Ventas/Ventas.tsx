import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { LoaderCircle, Minus, Plus, Search, ShoppingCart, Trash2 } from "lucide-react";

import { getColors, getProducts, getSizes, type CatalogItem, type Product } from "../../services/product.service";
import { getInventory } from "../../services/inventory.service";
import { createVentaReceipt, DEPARTAMENTOS_BOLIVIA } from "../../services/sales.service";
import { api } from "../../lib/api";
import { PHONE_DIGITS, hasNonDigits, phoneError } from "../../lib/validation";
import {
  EMPTY_VENTA,
  NAME_MAX,
  NOTES_MAX,
  buildSalePayload,
  cartUnits,
  changeDelivery,
  flowReducer,
  fromCents,
  initialFlow,
  inCart,
  lineCents,
  lineKey,
  subtotalOf,
  totalOf,
  validateVenta,
  type CartLine,
  type FormField,
  type VentaForm,
} from "../../lib/ventaFlow";
import { money } from "../../lib/receipt";
import { ReciboPanel } from "../../components/ventas/Recibo";
import { RevisionPanel, type RevisionLine } from "../../components/ventas/Revision";
import ProductThumb from "../../components/ProductThumb";
import { useSucursal } from "../../context/useSucursal";
import SalesHistory from "../../components/ventas/SalesHistory";
import { MQ, useMediaQuery } from "../../lib/useMediaQuery";

interface InventoryOption {
  id: number;
  producto_id: number;
  talla_id: number;
  color_id: number;
  cantidad: number;
}

const INPUT_CLASS =
  "w-full min-h-11 rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-black disabled:bg-gray-100";

/** Mensaje de error junto al campo (data-field-error: para llevar la vista al primer error). */
function FieldError({ text }: { text?: string }) {
  return text ? (
    <p data-field-error className="mt-1 text-xs text-red-600">
      {text}
    </p>
  ) : null;
}

/** Opción táctil: un radio real (teclado y lectores de pantalla) con aspecto de botón. */
function Choice({
  name,
  value,
  checked,
  disabled,
  onChange,
  children,
  className = "",
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`relative block ${disabled ? "cursor-not-allowed" : "cursor-pointer"} ${className}`}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onChange} className="peer sr-only" />
      <span className="flex h-full min-h-11 flex-col items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-center text-sm text-black transition peer-checked:border-black peer-checked:bg-black peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-black peer-focus-visible:ring-offset-2 peer-disabled:border-gray-200 peer-disabled:bg-gray-50 peer-disabled:text-gray-400">
        {children}
      </span>
    </label>
  );
}

function Ventas() {
  const { selectedId, selected, branches } = useSucursal();

  const [products, setProducts] = useState<Product[]>([]);
  const [sizes, setSizes] = useState<CatalogItem[]>([]);
  const [colors, setColors] = useState<CatalogItem[]>([]);
  const [inventory, setInventory] = useState<InventoryOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [historyToken, setHistoryToken] = useState(0);
  const [printing, setPrinting] = useState(false);
  const [phoneMessage, setPhoneMessage] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [flow, dispatch] = useReducer(flowReducer, EMPTY_VENTA, initialFlow);
  const submitting = useRef(false);

  const form = flow.form;
  const editing = flow.step === "editando";
  const errors = flow.step === "editando" ? flow.errors : {};
  const serverError = flow.step === "editando" ? flow.serverError : "";

  const loadCatalog = useCallback(async () => {
    try {
      setLoadError("");
      const [inv, prods, szs, cls] = await Promise.all([
        selectedId === null ? Promise.resolve([]) : getInventory(selectedId),
        getProducts(),
        getSizes(),
        getColors(),
      ]);
      setInventory(
        inv.map((item) => ({
          id: item.id,
          producto_id: item.producto.id,
          talla_id: item.talla.id,
          color_id: item.color.id,
          cantidad: item.cantidad,
        })),
      );
      setProducts(prods);
      setSizes(szs);
      setColors(cls);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudieron cargar los datos.");
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    // Carga inicial y al cambiar de sucursal (el inventario depende de ella).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCatalog();
  }, [loadCatalog]);

  const product = useMemo(() => products.find((p) => p.id === Number(form.productId)), [products, form.productId]);

  // Tallas y colores solo de combinaciones que existen en esta sucursal.
  const availableSizes = useMemo(
    () => sizes.filter((s) => inventory.some((i) => i.producto_id === Number(form.productId) && i.talla_id === s.id)),
    [sizes, inventory, form.productId],
  );
  const availableColors = useMemo(
    () =>
      colors.filter((c) =>
        inventory.some(
          (i) => i.producto_id === Number(form.productId) && i.talla_id === Number(form.sizeId) && i.color_id === c.id && i.cantidad > 0,
        ),
      ),
    [colors, inventory, form.productId, form.sizeId],
  );

  const availableStock = useMemo(() => {
    const row = inventory.find(
      (i) => i.producto_id === Number(form.productId) && i.talla_id === Number(form.sizeId) && i.color_id === Number(form.colorId),
    );
    return row?.cantidad ?? 0;
  }, [inventory, form.productId, form.sizeId, form.colorId]);

  const subtotal = subtotalOf(form);
  const total = totalOf(form);
  const units = cartUnits(form.cart);

  const stockOfVariant = useCallback(
    (v: Pick<CartLine, "productId" | "sizeId" | "colorId">) =>
      inventory.find((i) => i.producto_id === v.productId && i.talla_id === v.sizeId && i.color_id === v.colorId)?.cantidad ?? 0,
    [inventory],
  );
  const describeLine = useCallback(
    (l: CartLine) => {
      const p = products.find((x) => x.id === l.productId)?.nombre ?? "Producto";
      const sz = sizes.find((x) => x.id === l.sizeId)?.nombre ?? "—";
      const cl = colors.find((x) => x.id === l.colorId)?.nombre ?? "—";
      return { product: p, size: sz, color: cl };
    },
    [products, sizes, colors],
  );
  // Disponible para la línea en construcción = stock - lo ya reservado en el carrito.
  const reservedForBuilder = useMemo(
    () =>
      form.productId && form.sizeId && form.colorId
        ? inCart(form.cart, lineKey({ productId: Number(form.productId), sizeId: Number(form.sizeId), colorId: Number(form.colorId) }))
        : 0,
    [form.cart, form.productId, form.sizeId, form.colorId],
  );

  // Stock por modelo en la sucursal: solo se ofrecen modelos que se pueden vender aquí.
  const stockByProduct = useMemo(() => {
    const totals = new Map<number, number>();
    for (const row of inventory) totals.set(row.producto_id, (totals.get(row.producto_id) ?? 0) + row.cantidad);
    return totals;
  }, [inventory]);
  const sellable = useMemo(() => products.filter((p) => (stockByProduct.get(p.id) ?? 0) > 0), [products, stockByProduct]);
  const [productQuery, setProductQuery] = useState("");
  const [changingProduct, setChangingProduct] = useState(false);
  const shownProducts = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    return q ? sellable.filter((p) => p.nombre.toLowerCase().includes(q)) : sellable;
  }, [sellable, productQuery]);
  const showPicker = form.productId === "" || changingProduct;
  const sizeStock = (sizeId: number) =>
    inventory
      .filter((i) => i.producto_id === Number(form.productId) && i.talla_id === sizeId)
      .reduce((sum, i) => sum + i.cantidad, 0);
  const colorStock = (colorId: number) =>
    inventory.find((i) => i.producto_id === Number(form.productId) && i.talla_id === Number(form.sizeId) && i.color_id === colorId)?.cantidad ?? 0;
  const qty = Number(form.quantity) || 0;

  // En pantallas sin columna lateral (<1280 px) la revisión y el recibo quedan debajo del
  // formulario: se lleva la vista hacia ellos (y de vuelta al formulario al editar o empezar otra).
  const wide = useMediaQuery(MQ.xl);
  const formRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const prevStep = useRef(flow.step);
  useEffect(() => {
    const prev = prevStep.current;
    prevStep.current = flow.step;
    if (prev === flow.step || wide) return;
    if (flow.step === "revisando" || flow.step === "confirmada") {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (flow.step === "editando" && prev === "enviando") {
      actionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (flow.step === "editando") {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [flow.step, wide]);

  function patch(p: Partial<VentaForm>) {
    setSubmitError("");
    dispatch({ type: "editar", patch: p });
  }

  function selectProduct(id: string) {
    setChangingProduct(false);
    setProductQuery("");
    const chosen = products.find((p) => p.id === Number(id));
    // Precio por defecto del modelo; sigue siendo editable.
    patch({
      productId: id,
      sizeId: "",
      colorId: "",
      unitPrice: chosen && chosen.precio_venta > 0 ? String(chosen.precio_venta) : "",
    });
  }

  function selectMode(mode: VentaForm["mode"]) {
    // Al cambiar de método, se borra lo que ya no aplica (sin datos obsoletos).
    const cleaned = changeDelivery(form, mode);
    patch({ mode: cleaned.mode, department: cleaned.department, province: cleaned.province });
  }

  function onAddLine() {
    if (selectedId === null) {
      setSubmitError("Elige una sucursal concreta para registrar la venta.");
      return;
    }
    setSubmitError("");
    dispatch({ type: "agregar", availableStock });
    setChangingProduct(false);
  }

  function onClearCart() {
    if (form.cart.length === 0) return;
    if (window.confirm(`¿Vaciar la venta? Se quitarán ${form.cart.length} ${form.cart.length === 1 ? "producto" : "productos"} del carrito.`)) {
      dispatch({ type: "vaciar" });
    }
  }

  function onReview() {
    if (selectedId === null) {
      setSubmitError("Elige una sucursal concreta para registrar la venta.");
      return;
    }
    const found = validateVenta(form, {
      stockOf: stockOfVariant,
      labelOf: (l) => {
        const d = describeLine(l);
        return `${d.product} · talla ${d.size} · ${d.color}`;
      },
    });
    dispatch({ type: "revisar", errors: found as Partial<Record<FormField, string>>, newKey: crypto.randomUUID(), branchId: selectedId });
    // Con errores, se lleva la vista al primero (en el teléfono puede estar muy arriba).
    if (Object.keys(found).length > 0) {
      window.setTimeout(() => document.querySelector("[data-field-error]")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }

  async function onConfirm() {
    if (flow.step !== "revisando" || submitting.current) return;
    submitting.current = true;
    const { key, branchId } = flow;
    const payload = buildSalePayload(flow.form, branchId, key);
    dispatch({ type: "confirmar" });

    try {
      const receipt = await createVentaReceipt(payload);
      dispatch({ type: "exito", receipt });
      setHistoryToken((t) => t + 1);
      // Inventario actualizado; un fallo aquí no invalida la venta ya confirmada.
      void loadCatalog();
    } catch (err) {
      // Nunca se muestra éxito: el formulario vuelve a ser editable con todos los datos.
      dispatch({ type: "fallo", message: err instanceof Error ? err.message : "No se pudo registrar la venta." });
    } finally {
      submitting.current = false;
    }
  }

  const branchName = selected?.nombre ?? "—";

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="flex items-center gap-3 text-gray-500">
          <LoaderCircle size={22} className="animate-spin" />
          <span>Cargando información...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-black sm:text-2xl">Ventas</h1>
        <p className="mt-1 text-sm text-gray-500">
          Arma la venta con uno o varios productos. Se guarda como una sola venta y descuenta el stock de {branchName} solo al confirmar.
        </p>
      </div>

      {(loadError || submitError) && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError || submitError}
        </p>
      )}

      {selectedId === null && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          Elige una ubicación en el menú para registrar una venta.
        </div>
      )}

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-[1fr_420px]">
        {/* FORMULARIO ÚNICO */}
        <section ref={formRef} className="scroll-mt-20 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
          <fieldset disabled={!editing} className="min-w-0 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
              <span>
                Sucursal: <b className="text-black">{branchName}</b>
              </span>
              {!editing && <span className="text-xs text-gray-500">Para cambiar algo, pulsa VOLVER A EDITAR</span>}
            </div>

            {/* MODELO: tarjetas táctiles con foto, precio y stock de esta sucursal */}
            <div role="radiogroup" aria-labelledby="sale-product-label">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p id="sale-product-label" className="text-sm font-medium text-gray-700">
                  Modelo
                </p>
                {!showPicker && (
                  <button
                    type="button"
                    onClick={() => setChangingProduct(true)}
                    className="min-h-11 rounded-lg px-3 text-sm font-medium text-black underline underline-offset-4"
                  >
                    Cambiar modelo
                  </button>
                )}
              </div>

              {showPicker ? (
                <>
                  {sellable.length > 6 && (
                    <div className="mb-3 flex items-center gap-2 rounded-lg border border-gray-300 px-3 focus-within:border-black">
                      <Search size={17} className="shrink-0 text-gray-400" />
                      <input
                        type="search"
                        aria-label="Buscar modelo"
                        enterKeyHint="search"
                        autoComplete="off"
                        value={productQuery}
                        onChange={(e) => setProductQuery(e.target.value)}
                        placeholder="Buscar modelo"
                        className="h-11 w-full min-w-0 bg-transparent text-sm outline-none"
                      />
                    </div>
                  )}
                  {sellable.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">
                      {selectedId === null ? "Elige una sucursal para ver sus modelos." : "No hay modelos con stock en esta sucursal."}
                    </p>
                  ) : (
                    <div id="sale-products" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">
                      {shownProducts.map((p) => {
                        const checked = form.productId === String(p.id);
                        return (
                          <label key={p.id} className="relative block cursor-pointer">
                            <input
                              type="radio"
                              name="sale-product"
                              value={p.id}
                              checked={checked}
                              onChange={() => selectProduct(String(p.id))}
                              className="peer sr-only"
                            />
                            <span className="flex min-h-16 items-center gap-3 rounded-xl border border-gray-200 bg-white p-2.5 transition peer-checked:border-black peer-checked:ring-1 peer-checked:ring-black peer-focus-visible:ring-2 peer-focus-visible:ring-black hover:border-gray-400">
                              <ProductThumb product={p} size={44} />
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium leading-snug text-black">{p.nombre}</span>
                                <span className="block text-xs text-gray-500">
                                  {p.precio_venta > 0 ? money(p.precio_venta) : "Precio a definir"} · {stockByProduct.get(p.id)} en stock
                                </span>
                              </span>
                            </span>
                          </label>
                        );
                      })}
                      {shownProducts.length === 0 && <p className="text-sm text-gray-500">Ningún modelo coincide con «{productQuery.trim()}».</p>}
                    </div>
                  )}
                  {products.length > sellable.length && selectedId !== null && (
                    <p className="mt-2 text-xs text-gray-500">
                      {products.length - sellable.length} {products.length - sellable.length === 1 ? "modelo sin stock" : "modelos sin stock"} en {branchName} no se muestran.
                    </p>
                  )}
                </>
              ) : (
                <div className="flex items-center gap-3 rounded-xl border border-black p-2.5">
                  <ProductThumb product={product} size={56} />
                  <div className="min-w-0">
                    <p className="font-medium text-black">{product?.nombre}</p>
                    <p className="text-xs text-gray-500">
                      {product && product.precio_venta > 0 ? money(product.precio_venta) : "Precio a definir"} · {stockByProduct.get(Number(form.productId)) ?? 0} en stock
                    </p>
                  </div>
                </div>
              )}
              <FieldError text={errors.productId} />
            </div>

            {form.productId !== "" && !showPicker && (
              <>
                {/* TALLA con stock por talla */}
                <div role="radiogroup" aria-labelledby="sale-size-label">
                  <p id="sale-size-label" className="mb-2 text-sm font-medium text-gray-700">
                    Talla
                  </p>
                  <div id="sale-sizes" className="grid grid-cols-4 gap-2 min-[400px]:grid-cols-5 sm:flex sm:flex-wrap">
                    {availableSizes.map((s) => {
                      const n = sizeStock(s.id);
                      return (
                        <Choice
                          key={s.id}
                          name="sale-size"
                          value={String(s.id)}
                          checked={form.sizeId === String(s.id)}
                          disabled={n === 0}
                          onChange={() => patch({ sizeId: String(s.id), colorId: "" })}
                          className="sm:min-w-16"
                        >
                          <span className="font-semibold">{s.nombre}</span>
                          <span className="text-[11px] opacity-75">{n} u.</span>
                        </Choice>
                      );
                    })}
                  </div>
                  <FieldError text={errors.sizeId} />
                </div>

                {/* COLOR con stock de esa talla */}
                <div role="radiogroup" aria-labelledby="sale-color-label">
                  <p id="sale-color-label" className="mb-2 text-sm font-medium text-gray-700">
                    Color
                  </p>
                  {form.sizeId === "" ? (
                    <p className="text-sm text-gray-500">Elige primero la talla.</p>
                  ) : (
                    <div id="sale-colors" className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                      {availableColors.map((c) => (
                        <Choice
                          key={c.id}
                          name="sale-color"
                          value={String(c.id)}
                          checked={form.colorId === String(c.id)}
                          onChange={() => patch({ colorId: String(c.id) })}
                        >
                          <span className="font-medium">{c.nombre}</span>
                          <span className="text-[11px] opacity-75">{colorStock(c.id)} u.</span>
                        </Choice>
                      ))}
                    </div>
                  )}
                  <FieldError text={errors.colorId} />
                </div>
              </>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="sale-qty" className="mb-2 block text-sm font-medium text-gray-700">
                  Cantidad <span className="font-normal text-gray-500">(disponible: {Math.max(0, availableStock - reservedForBuilder)})</span>
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Restar una unidad"
                    onClick={() => patch({ quantity: String(Math.max(1, qty - 1)) })}
                    disabled={qty <= 1}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-gray-300 text-black hover:border-black disabled:opacity-40"
                  >
                    <Minus size={18} />
                  </button>
                  <input
                    id="sale-qty"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    value={form.quantity}
                    onChange={(e) => patch({ quantity: e.target.value })}
                    className={`${INPUT_CLASS} text-center`}
                  />
                  <button
                    type="button"
                    aria-label="Sumar una unidad"
                    onClick={() => patch({ quantity: String(qty + 1) })}
                    disabled={qty >= Math.max(0, availableStock - reservedForBuilder)}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-gray-300 text-black hover:border-black disabled:opacity-40"
                  >
                    <Plus size={18} />
                  </button>
                </div>
                <FieldError text={errors.quantity} />
              </div>

              <div>
                <label htmlFor="sale-price" className="mb-2 block text-sm font-medium text-gray-700">
                  Precio unitario (Bs)
                </label>
                <input
                  id="sale-price"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={form.unitPrice}
                  onChange={(e) => patch({ unitPrice: e.target.value })}
                  placeholder="0.00"
                  className={INPUT_CLASS}
                />
                <FieldError text={errors.unitPrice} />
              </div>

              <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3 sm:col-span-2">
                <span className="text-sm text-gray-600">Subtotal de esta línea</span>
                <span className="text-lg font-semibold text-black">{money(subtotal)}</span>
              </div>

              <button
                type="button"
                onClick={onAddLine}
                disabled={!editing || selectedId === null}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-black px-4 py-3 text-sm font-semibold tracking-wide text-black transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:border-gray-300 disabled:text-gray-300 sm:col-span-2"
              >
                <Plus size={18} />
                AGREGAR A LA VENTA
              </button>
            </div>

            {/* CARRITO: todas las líneas de esta venta */}
            <div aria-labelledby="sale-cart-title" role="group" className="space-y-3 border-t border-gray-200 pt-6">
              <div className="flex items-center justify-between gap-2">
                <h3 id="sale-cart-title" className="text-base font-semibold text-black">
                  Productos en la venta <span className="font-normal text-gray-500">({units} {units === 1 ? "unidad" : "unidades"})</span>
                </h3>
                {form.cart.length > 0 && (
                  <button
                    type="button"
                    onClick={onClearCart}
                    className="min-h-11 rounded-lg px-3 text-sm font-medium text-red-600 underline underline-offset-4"
                  >
                    Vaciar
                  </button>
                )}
              </div>

              {form.cart.length === 0 ? (
                <p className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">
                  Aún no hay productos. Elige un modelo, talla y color y pulsa AGREGAR A LA VENTA. Puedes agregar varios productos distintos.
                </p>
              ) : (
                <ul id="sale-cart" className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                  {form.cart.map((line) => {
                    const d = describeLine(line);
                    const max = stockOfVariant(line);
                    const listPrice = products.find((x) => x.id === line.productId)?.precio_venta ?? 0;
                    const key = lineKey(line);
                    return (
                      <li key={key} className="space-y-2 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="break-words font-medium text-black">{d.product}</p>
                            <p className="text-xs text-gray-500">
                              Talla {d.size} · {d.color} · {money(fromCents(line.unitCents))} c/u
                            </p>
                            {listPrice > 0 && Math.round(listPrice * 100) !== line.unitCents && (
                              <p className="text-xs text-yellow-700">Precio distinto al de lista ({money(listPrice)}).</p>
                            )}
                          </div>
                          <button
                            type="button"
                            aria-label={`Quitar ${d.product} de la venta`}
                            onClick={() => dispatch({ type: "quitar", key })}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-red-600 hover:border-red-600"
                          >
                            <Trash2 size={17} />
                          </button>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              aria-label={`Restar una unidad de ${d.product}`}
                              onClick={() => dispatch({ type: "cantidad", key, quantity: line.quantity - 1 })}
                              disabled={line.quantity <= 1}
                              className="flex h-11 w-11 items-center justify-center rounded-lg border border-gray-300 hover:border-black disabled:opacity-40"
                            >
                              <Minus size={16} />
                            </button>
                            <span className="min-w-8 text-center text-sm font-semibold" aria-label={`Cantidad de ${d.product}`}>
                              {line.quantity}
                            </span>
                            <button
                              type="button"
                              aria-label={`Sumar una unidad de ${d.product}`}
                              onClick={() => dispatch({ type: "cantidad", key, quantity: line.quantity + 1 })}
                              disabled={line.quantity >= max}
                              className="flex h-11 w-11 items-center justify-center rounded-lg border border-gray-300 hover:border-black disabled:opacity-40"
                            >
                              <Plus size={16} />
                            </button>
                          </div>
                          <p className="font-semibold text-black">{money(fromCents(lineCents(line)))}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <FieldError text={errors.cart} />
            </div>

            <div className="grid gap-5 border-t border-gray-200 pt-6 sm:grid-cols-2">
              <h3 className="text-base font-semibold text-black sm:col-span-2">Pago, entrega y cliente</h3>

              <div role="radiogroup" aria-labelledby="sale-payment-label">
                <p id="sale-payment-label" className="mb-2 text-sm font-medium text-gray-700">
                  Método de pago
                </p>
                <div id="sale-payment" className="grid grid-cols-2 gap-2">
                  <Choice name="sale-payment" value="efectivo" checked={form.payment === "efectivo"} onChange={() => patch({ payment: "efectivo" })}>
                    <span className="font-medium">Efectivo</span>
                  </Choice>
                  <Choice name="sale-payment" value="QR" checked={form.payment === "QR"} onChange={() => patch({ payment: "QR" })}>
                    <span className="font-medium">QR</span>
                  </Choice>
                </div>
              </div>

              <div>
                <label htmlFor="sale-mode" className="mb-2 block text-sm font-medium text-gray-700">
                  Entrega
                </label>
                <select
                  id="sale-mode"
                  value={form.mode}
                  onChange={(e) => selectMode(e.target.value as VentaForm["mode"])}
                  className={INPUT_CLASS}
                >
                  <option value="entrega_directa">Entrega directa</option>
                  <option value="envio">Envío a departamento</option>
                  <option value="envio_interprovincial">Envío interprovincial</option>
                </select>
              </div>

              {form.mode === "envio" && (
                <div className="sm:col-span-2">
                  <label htmlFor="sale-dept" className="mb-2 block text-sm font-medium text-gray-700">
                    Departamento
                  </label>
                  <select
                    id="sale-dept"
                    value={form.department}
                    onChange={(e) => patch({ department: e.target.value })}
                    className={INPUT_CLASS}
                  >
                    <option value="">Seleccionar departamento</option>
                    {DEPARTAMENTOS_BOLIVIA.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <FieldError text={errors.department} />
                </div>
              )}

              {form.mode === "envio_interprovincial" && (
                <div className="sm:col-span-2">
                  <label htmlFor="sale-prov" className="mb-2 block text-sm font-medium text-gray-700">
                    Provincia o localidad
                  </label>
                  <input
                    id="sale-prov"
                    type="text"
                    autoComplete="off"
                    maxLength={100}
                    value={form.province}
                    onChange={(e) => patch({ province: e.target.value })}
                    placeholder="Escribe la provincia"
                    className={INPUT_CLASS}
                  />
                  <FieldError text={errors.province} />
                </div>
              )}

              <div>
                <label htmlFor="sale-cname" className="mb-2 block text-sm font-medium text-gray-700">
                  Cliente (opcional)
                </label>
                <input
                  id="sale-cname"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="words"
                  maxLength={NAME_MAX}
                  value={form.customerName}
                  onChange={(e) => patch({ customerName: e.target.value })}
                  className={INPUT_CLASS}
                />
                <FieldError text={errors.customerName} />
              </div>

              <div>
                <label htmlFor="sale-cphone" className="mb-2 block text-sm font-medium text-gray-700">
                  Teléfono (opcional, 8 dígitos)
                </label>
                <input
                  id="sale-cphone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  maxLength={PHONE_DIGITS}
                  value={form.customerPhone}
                  placeholder="71234567"
                  onKeyDown={(event) => {
                    if (event.key.length === 1 && !/\d/.test(event.key) && !event.ctrlKey && !event.metaKey) {
                      event.preventDefault();
                      setPhoneMessage("Solo se permiten números.");
                    }
                  }}
                  onPaste={(event) => {
                    const pasted = event.clipboardData.getData("text").trim();
                    event.preventDefault();
                    if (!/^\d{1,8}$/.test(pasted)) {
                      setPhoneMessage(
                        hasNonDigits(pasted)
                          ? "Solo se permiten números: pega 8 dígitos sin espacios ni símbolos."
                          : "El teléfono tiene como máximo 8 dígitos.",
                      );
                      return;
                    }
                    setPhoneMessage("");
                    patch({ customerPhone: pasted });
                  }}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (hasNonDigits(value)) {
                      setPhoneMessage("Solo se permiten números.");
                      return;
                    }
                    setPhoneMessage("");
                    patch({ customerPhone: value.slice(0, PHONE_DIGITS) });
                  }}
                  aria-invalid={form.customerPhone !== "" && phoneError(form.customerPhone) !== null}
                  className={INPUT_CLASS}
                />
                <FieldError text={phoneMessage || errors.customerPhone || (form.customerPhone !== "" ? phoneError(form.customerPhone) ?? undefined : undefined)} />
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="sale-notes" className="mb-2 block text-sm font-medium text-gray-700">
                  Descripción o notas (opcional)
                </label>
                <textarea
                  id="sale-notes"
                  rows={2}
                  maxLength={NOTES_MAX}
                  value={form.notes}
                  onChange={(e) => patch({ notes: e.target.value })}
                  className={INPUT_CLASS}
                />
                <FieldError text={errors.notes} />
              </div>
            </div>
          </fieldset>

          <div ref={actionRef} className="mt-6 scroll-mt-20 border-t border-gray-200 pt-4 sm:mt-8">
            <div className="mb-3 flex items-center justify-between xl:hidden">
              <span className="text-sm font-medium text-gray-600">Total · {units} u.</span>
              <span className="text-xl font-semibold text-black">{money(total)}</span>
            </div>
            <button
              type="button"
              onClick={onReview}
              disabled={!editing || selectedId === null || form.cart.length === 0}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-black px-4 py-3.5 text-sm font-semibold tracking-wide text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              <ShoppingCart size={18} />
              REALIZAR VENTA
            </button>
            {serverError && (
              <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {serverError} Los datos siguen en el formulario; puedes corregirlos y volver a intentar.
              </p>
            )}
          </div>
        </section>

        {/* PANEL DERECHO: resumen, revisión o recibo confirmado */}
        <section
          ref={panelRef}
          className={`scroll-mt-20 flex-col rounded-xl border bg-white shadow-sm ${
            flow.step === "editando" ? "hidden border-gray-200 xl:flex" : "flex border-black xl:border-gray-200"
          }`}
        >
          {flow.step === "editando" && (
            <>
              <div className="border-b border-gray-200 p-6">
                <h2 className="text-lg font-semibold text-black">Resumen</h2>
                <p className="mt-1 text-sm text-gray-500">Pulsa REALIZAR VENTA para revisarla antes de guardar.</p>
              </div>
              <div className="flex-1 space-y-2 p-6 text-sm">
                {form.cart.length === 0 ? (
                  <p className="text-gray-500">Sin productos todavía.</p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {form.cart.map((line) => {
                      const d = describeLine(line);
                      return (
                        <li key={lineKey(line)} className="flex justify-between gap-3 py-1.5">
                          <span className="min-w-0">
                            {d.product} · {d.size} · {d.color} · {line.quantity} × {money(fromCents(line.unitCents))}
                          </span>
                          <span className="shrink-0 font-medium">{money(fromCents(lineCents(line)))}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="pt-2 text-gray-600">Unidades: {units}</p>
              </div>
              <div className="flex items-center justify-between border-t border-gray-200 p-6">
                <span className="text-sm font-medium text-gray-600">Total</span>
                <span className="text-2xl font-semibold text-black">{money(total)}</span>
              </div>
            </>
          )}

          {(flow.step === "revisando" || flow.step === "enviando") && (
            <RevisionPanel
              form={flow.form}
              info={{
                branch: branches.find((b) => b.id === flow.branchId)?.nombre ?? branchName,
                lines: flow.form.cart.map((line): RevisionLine => {
                  const d = describeLine(line);
                  const prod = products.find((x) => x.id === line.productId);
                  return { line, ...d, photoSrc: prod?.foto_url && api.baseUrl ? `${api.baseUrl}${prod.foto_url}` : null };
                }),
              }}
              sending={flow.step === "enviando"}
              serverError={""}
              onBack={() => dispatch({ type: "volver" })}
              onConfirm={() => void onConfirm()}
            />
          )}

          {flow.step === "confirmada" && (
            <ReciboPanel
              receipt={flow.receipt}
              printing={printing}
              onPrint={() => setPrinting(true)}
              onPrinted={() => setPrinting(false)}
              onNewSale={() => {
                setPrinting(false);
                setSubmitError("");
                setPhoneMessage("");
                dispatch({ type: "nueva" });
              }}
            />
          )}
        </section>
      </div>

      <SalesHistory
        branches={branches}
        sucursalId={selectedId}
        refreshToken={historyToken}
        products={products}
        sizes={sizes}
        colors={colors}
        onChanged={() => {
          setHistoryToken((t) => t + 1);
          void loadCatalog();
        }}
      />
    </div>
  );
}

export default Ventas;
