import AjustesInventario from "./AjustesInventario";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  Plus,
  X,
  PackagePlus,
  Camera,
  Search,
  Layers,
  Trash2,
  LoaderCircle,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { useAuth } from "../../context/useAuth";
import { useSucursal } from "../../context/useSucursal";

import {
  getInventory,
  type InventoryItem,
} from "../../services/inventory.service";

import {
  addStock,
  createInventoryVariants,
  createProduct,
  getColors,
  getProducts,
  getSizes,
  selectableSizes,
  type CatalogItem,
  type Product,
  photoFileError,
  uploadProductPhoto,
} from "../../services/product.service";
import ProductThumb from "../../components/ProductThumb";
import { branchLabel } from "../../lib/ubicaciones";
import { colorsForProduct } from "../../lib/colores";
import {
  LOT_STATE_CLASS,
  LOT_STATE_TEXT,
  daysText,
  entryText,
  emptyLine,
  emptyReceipt,
  receiptPayload,
  totalUnits,
  validateReceipt,
  type ReceiptErrors,
  type ReceiptForm,
} from "../../lib/recepcion";
import { createReceipt, listLots, type LotRow } from "../../services/lots.service";
import { formatBoliviaDateTime } from "../../lib/receipt";

interface NewVariantRow {
  tallaId: number;
  colorId: number;
  cantidad: number;
}

function Inventario() {
  const { selectedId, selected } = useSucursal();
  const { user } = useAuth();
  // Solo el administrador agrega productos/stock (el servidor también lo exige).
  const isConsolidated = selectedId === null || user?.rol !== "admin";

  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sizes, setSizes] = useState<CatalogItem[]>([]);
  const [colors, setColors] = useState<CatalogItem[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [searchParams, setSearchParams] = useSearchParams();
  const buscarParam = searchParams.get("buscar") ?? "";
  const [query, setQuery] = useState(buscarParam);
  const [lastBuscar, setLastBuscar] = useState(buscarParam);
  // Si el buscador global vuelve a navegar aquí con otro texto, se aplica (ajuste durante el render).
  if (buscarParam !== lastBuscar) {
    setLastBuscar(buscarParam);
    setQuery(buscarParam);
  }

  const [selectedModel, setSelectedModel] = useState("");
  const [selectedSize, setSelectedSize] = useState("");
  const [selectedColor, setSelectedColor] = useState("");

  const [showNewProduct, setShowNewProduct] = useState(false);
  const [showNewVariant, setShowNewVariant] = useState(false);
  const [showAddStock, setShowAddStock] = useState(false);

  const [productName, setProductName] = useState("");
  const [newPhoto, setNewPhoto] = useState<File | null>(null);
  const [newPhotoError, setNewPhotoError] = useState("");
  const [photoMessage, setPhotoMessage] = useState("");
  const photoInput = useRef<HTMLInputElement>(null);
  const photoTarget = useRef<number | null>(null);
  const [selectedNewSizes, setSelectedNewSizes] = useState<number[]>([]);
  const [selectedNewColors, setSelectedNewColors] = useState<number[]>([]);
  const [variantQuantities, setVariantQuantities] = useState<
    Record<string, number>
  >({});

  // Recepción de mercadería (una o varias prendas, con fecha y hora real de llegada).
  const [receipt, setReceipt] = useState<ReceiptForm>(() => emptyReceipt());
  const [receiptErrors, setReceiptErrors] = useState<ReceiptErrors>({});
  const receiptKey = useRef<string>(crypto.randomUUID());

  // Lotes de una talla/color en esta ubicación.
  const [lotsFor, setLotsFor] = useState<InventoryItem | null>(null);
  const [lots, setLots] = useState<LotRow[]>([]);
  const [lotsLoading, setLotsLoading] = useState(false);
  const [lotsError, setLotsError] = useState("");
  const lotsRef = useRef<HTMLElement>(null);

  const [selectedInventoryItem, setSelectedInventoryItem] =
    useState<InventoryItem | null>(null);

  const [stockToAdd, setStockToAdd] = useState("");

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  // Los paneles se abren arriba de la lista: se desplazan a la vista (en el móvil la fila tocada
  // puede estar muy abajo).
  const newProductRef = useRef<HTMLElement>(null);
  const newVariantRef = useRef<HTMLElement>(null);
  const addStockRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (showNewProduct) newProductRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [showNewProduct]);
  useEffect(() => {
    if (showNewVariant) newVariantRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [showNewVariant]);
  useEffect(() => {
    if (showAddStock) addStockRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [showAddStock, selectedInventoryItem]);
  useEffect(() => {
    if (lotsFor) lotsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [lotsFor]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const [
        inventoryData,
        productsData,
        sizesData,
        colorsData,
      ] = await Promise.all([
        getInventory(selectedId),
        getProducts(),
        getSizes(),
        getColors(),
      ]);

      setInventory(inventoryData);
      setProducts(productsData);
      setSizes(sizesData);
      setColors(colorsData);
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : "No se pudo cargar el inventario.";

      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
  // La carga inicial consulta la API y actualiza el estado cuando termina.
  // Esta llamada es intencional al montar la pantalla.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  void loadData();
  }, [loadData]);

  const filteredInventory = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return inventory.filter((item) => {
      const text = `${item.producto.nombre} ${item.talla.nombre} ${item.color.nombre}`.toLowerCase();
      if (!tokens.every((t) => text.includes(t))) return false;

      const matchesModel =
        selectedModel === "" ||
        item.producto.nombre === selectedModel;

      const matchesSize =
        selectedSize === "" ||
        item.talla.nombre === selectedSize;

      const matchesColor =
        selectedColor === "" ||
        item.color.nombre === selectedColor;

      return matchesModel && matchesSize && matchesColor;
    });
  }, [inventory, query, selectedModel, selectedSize, selectedColor]);

  // Vista móvil: variantes agrupadas por modelo.
  const groupedInventory = useMemo(() => {
    const groups = new Map<number, { producto: InventoryItem["producto"]; items: InventoryItem[]; total: number }>();
    for (const item of filteredInventory) {
      const g = groups.get(item.producto.id) ?? { producto: item.producto, items: [], total: 0 };
      g.items.push(item);
      g.total += item.cantidad;
      groups.set(item.producto.id, g);
    }
    return [...groups.values()];
  }, [filteredInventory]);

  const totalStock = inventory.reduce(
    (total, item) => total + item.cantidad,
    0,
  );

  const totalProducts = new Set(
    inventory.map((item) => item.producto.id),
  ).size;

  const hasFilters =
    query.trim() !== "" ||
    selectedModel !== "" ||
    selectedSize !== "" ||
    selectedColor !== "";

  function clearFilters() {
    setQuery("");
    if (buscarParam) setSearchParams({}, { replace: true });
    setSelectedModel("");
    setSelectedSize("");
    setSelectedColor("");
  }

  function resetMessages() {
    setMessage("");
    setError("");
  }

  function openNewProduct() {
    if (isConsolidated) return;
    resetMessages();

    setProductName("");
    setNewPhoto(null);
    setNewPhotoError("");
    setSelectedNewSizes([]);
    setSelectedNewColors([]);
    setVariantQuantities({});

    setShowNewProduct(true);
  }

  function closeNewProduct() {
    if (saving) {
      return;
    }

    setShowNewProduct(false);
    setMessage("");
  }

  function toggleNewSize(sizeId: number) {
    setSelectedNewSizes((current) => {
      if (current.includes(sizeId)) {
        return current.filter((id) => id !== sizeId);
      }

      return [...current, sizeId];
    });
  }

  function toggleNewColor(colorId: number) {
    setSelectedNewColors((current) => {
      if (current.includes(colorId)) {
        return current.filter((id) => id !== colorId);
      }

      return [...current, colorId];
    });
  }

  function getVariantKey(
    sizeId: number,
    colorId: number,
  ) {
    return `${sizeId}-${colorId}`;
  }

  function getVariantQuantity(
    sizeId: number,
    colorId: number,
  ) {
    const key = getVariantKey(sizeId, colorId);

    return variantQuantities[key] ?? 0;
  }

  function setVariantQuantityValue(
    sizeId: number,
    colorId: number,
    quantity: number,
  ) {
    const key = getVariantKey(sizeId, colorId);

    setVariantQuantities((current) => ({
      ...current,
      [key]: Math.max(0, quantity),
    }));
  }

  async function handleCreateProduct() {
    if (!productName.trim()) {
      setMessage(
        "Escribe el nombre o modelo del producto.",
      );
      return;
    }

    if (selectedNewSizes.length === 0) {
      setMessage(
        "Selecciona al menos una talla.",
      );
      return;
    }

    if (selectedNewColors.length === 0) {
      setMessage(
        "Selecciona al menos un color.",
      );
      return;
    }

    const variants: NewVariantRow[] = [];

    for (const sizeId of selectedNewSizes) {
      for (const colorId of selectedNewColors) {
        variants.push({
          tallaId: sizeId,
          colorId,
          cantidad: getVariantQuantity(
            sizeId,
            colorId,
          ),
        });
      }
    }

    const variantsWithStock = variants.filter(
      (variant) => variant.cantidad > 0,
    );

    if (variantsWithStock.length === 0) {
      setMessage(
        "Escribe cuántas unidades tienes de al menos una talla y color.",
      );
      return;
    }

    try {
      setSaving(true);
      setMessage("");
      setError("");

      const product = await createProduct(
        productName,
        0,
        selectedNewColors,
      );

      await createInventoryVariants(
        variantsWithStock.map((variant) => ({
          sucursal_id: selectedId as number,
          producto_id: product.id,
          talla_id: variant.tallaId,
          color_id: variant.colorId,
          cantidad: variant.cantidad,
        })),
      );

      if (newPhoto) {
        try {
          await uploadProductPhoto(product.id, newPhoto);
        } catch (photoErr) {
          setMessage(
            `El producto se guardó, pero la foto no se subió: ${photoErr instanceof Error ? photoErr.message : "error desconocido"}`,
          );
          await loadData();
          return;
        }
      }

      setMessage(
        "Listo: producto guardado con su stock.",
      );

      await loadData();

      setTimeout(() => {
        setShowNewProduct(false);
        setMessage("");
      }, 1200);
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : "No se pudo crear el producto.";

      setMessage(errorMessage);
    } finally {
      setSaving(false);
    }
  }

  function openNewVariant() {
    if (isConsolidated) return;
    resetMessages();
    setReceipt(emptyReceipt());
    setReceiptErrors({});
    receiptKey.current = crypto.randomUUID();
    setShowNewVariant(true);
  }

  function closeNewVariant() {
    if (saving) {
      return;
    }

    setShowNewVariant(false);
    setMessage("");
  }

  function editReceipt(patch: Partial<ReceiptForm>) {
    setReceipt((r) => ({ ...r, ...patch }));
    setReceiptErrors({});
    setMessage("");
  }

  function editLine(key: string, patch: Partial<ReceiptForm["lineas"][number]>) {
    setReceipt((r) => ({ ...r, lineas: r.lineas.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
    setReceiptErrors({});
    setMessage("");
  }

  /** Guarda la recepción: una sola operación atómica; un lote por talla/color. */
  async function handleCreateVariant() {
    if (selectedId === null || saving) return;
    const found = validateReceipt(receipt);
    setReceiptErrors(found);
    if (Object.keys(found).length > 0) {
      setMessage("Revisa los datos marcados.");
      return;
    }

    try {
      setSaving(true);
      setMessage("");
      setError("");

      const r = await createReceipt(receiptKey.current, receiptPayload(receipt, selectedId));
      setMessage(
        `Listo: recepción ${r.referencia_recepcion} guardada (${r.total_unidades} ${r.total_unidades === 1 ? "unidad" : "unidades"} en ${r.lotes.length} ${r.lotes.length === 1 ? "lote" : "lotes"}).`,
      );
      receiptKey.current = crypto.randomUUID();
      await loadData();

      setTimeout(() => {
        setShowNewVariant(false);
        setMessage("");
      }, 1500);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo agregar el stock.");
    } finally {
      setSaving(false);
    }
  }

  /** Abre los lotes de una talla/color en esta ubicación (más recientes primero). */
  async function openLots(item: InventoryItem) {
    if (item.sucursal_id === null) return;
    setLotsFor(item);
    setLots([]);
    setLotsError("");
    setLotsLoading(true);
    try {
      const r = await listLots({ sucursal_id: item.sucursal_id, producto_id: item.producto.id, talla_id: item.talla.id, color_id: item.color.id });
      setLots(r.filas);
    } catch (err) {
      setLotsError(err instanceof Error ? err.message : "No se pudieron cargar los lotes.");
    } finally {
      setLotsLoading(false);
    }
  }

  function openAddStock(item: InventoryItem) {
    if (item.sucursal_id === null) return;
    resetMessages();

    setSelectedInventoryItem(item);
    setStockToAdd("");

    setShowAddStock(true);
  }

  function closeAddStock() {
    if (saving) {
      return;
    }

    setShowAddStock(false);
    setSelectedInventoryItem(null);
    setStockToAdd("");
    setMessage("");
  }

  async function handleAddStock() {
    if (!selectedInventoryItem) {
      return;
    }

    const quantity = Number(stockToAdd);

    if (!Number.isInteger(quantity) || quantity <= 0) {
      setMessage(
        "Escribe cuántas unidades llegaron (un número mayor a 0).",
      );
      return;
    }

    try {
      setSaving(true);
      setMessage("");
      setError("");

      await addStock({
        sucursal_id: selectedInventoryItem.sucursal_id as number,
        producto_id: selectedInventoryItem.producto.id,
        talla_id: selectedInventoryItem.talla.id,
        color_id: selectedInventoryItem.color.id,
        cantidad: quantity,
      });

      setMessage(
        "Listo: se sumaron las unidades.",
      );

      await loadData();

      setTimeout(() => {
        setShowAddStock(false);
        setSelectedInventoryItem(null);
        setStockToAdd("");
        setMessage("");
      }, 1000);
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : "No se pudo actualizar el stock.";

      setMessage(errorMessage);
    } finally {
      setSaving(false);
    }
  }

  function getStockStatus(quantity: number) {
    if (quantity === 0) {
      return {
        label: "Agotado",
        className: "bg-red-50 text-red-700",
      };
    }

    if (quantity <= 2) {
      return {
        label: "Stock bajo",
        className: "bg-yellow-50 text-yellow-700",
      };
    }

    return {
      label: "Disponible",
      className: "bg-green-50 text-green-700",
    };
  }

  return (
    <div className="space-y-5 sm:space-y-8">
      {/* ENCABEZADO */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">
            Tus productos
          </p>

          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-black sm:text-3xl">
            Inventario
          </h1>

          <p className="mt-2 text-sm text-gray-500">
            Mira cuántas prendas tienes. Cuando llegue mercadería, usa «Agregar stock».
          </p>

          <p className="mt-2 inline-flex rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
            {selectedId === null
              ? "Elige una ubicación"
              : user?.rol !== "admin"
                ? `${selected?.nombre ?? ""} · solo lectura`
                : selected ? branchLabel(selected) : ""}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
          <button
            type="button"
            onClick={openNewVariant}
            disabled={isConsolidated}
            className="disabled:cursor-not-allowed disabled:opacity-50 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-black transition hover:border-black sm:px-4"
          >
            <PackagePlus size={18} />
            Agregar stock
          </button>

          <button
            type="button"
            onClick={openNewProduct}
            disabled={isConsolidated}
            className="disabled:cursor-not-allowed disabled:opacity-50 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-black px-3 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 sm:px-4"
          >
            <Plus size={18} />
            Nuevo producto
          </button>
        </div>
      </div>

      {/* NUEVO PRODUCTO */}
      {showNewProduct && (
        <section ref={newProductRef} className="scroll-mt-20 rounded-xl border border-gray-200 bg-white p-4 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-black">
                Nuevo producto
              </h2>

              <p className="mt-1 text-sm text-gray-500">
                Escribe el nombre, marca sus tallas y colores, y cuántas unidades tienes de cada uno.
              </p>
            </div>

            <button
              type="button"
              onClick={closeNewProduct}
              disabled={saving}
              aria-label="Cerrar"
              className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-black disabled:opacity-50"
            >
              <X size={20} />
            </button>
          </div>

          <div className="mt-6 space-y-7">
            {/* NOMBRE */}
            <div>
              <label
                htmlFor="new-product-name"
                className="mb-2 block text-sm font-medium text-gray-700"
              >
                Nombre del modelo
              </label>

              <input
                id="new-product-name"
                type="text"
                value={productName}
                onChange={(event) =>
                  setProductName(event.target.value)
                }
                placeholder="Ej. Pantalón palazzo de lino"
                disabled={saving}
                className="w-full max-w-xl rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-black outline-none transition focus:border-black focus:bg-white"
              />
            </div>

            {/* FOTO (opcional) */}
            <div>
              <label htmlFor="new-product-photo" className="mb-2 block text-sm font-medium text-gray-700">
                Foto del modelo (opcional, JPG, PNG o WebP, máx. 2 MB)
              </label>
              <div className="flex flex-wrap items-center gap-4">
                <ProductThumb product={newPhoto ? { nombre: productName || "Nuevo modelo", foto_url: URL.createObjectURL(newPhoto) } : undefined} size={64} />
                <input
                  id="new-product-photo"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={saving}
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    const problem = file ? photoFileError(file) : null;
                    setNewPhotoError(problem ?? "");
                    setNewPhoto(problem ? null : file);
                  }}
                  className="min-w-0 max-w-full text-sm text-gray-600 file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-gray-200 file:bg-white file:px-3 file:text-sm file:font-medium"
                />
              </div>
              {newPhotoError && <p className="mt-1 text-xs text-red-600">{newPhotoError}</p>}
            </div>

            {/* TALLAS */}
            <div>
              <p className="mb-3 text-sm font-medium text-gray-700">
                ¿Qué tallas tiene?
              </p>

              <div className="flex flex-wrap gap-2 sm:gap-3">
                {selectableSizes(sizes).map((size) => {
                  const selected =
                    selectedNewSizes.includes(size.id);

                  return (
                    <button
                      key={size.id}
                      type="button"
                      onClick={() =>
                        toggleNewSize(size.id)
                      }
                      disabled={saving}
                      aria-pressed={selected}
                      className={`min-h-11 min-w-11 rounded-lg border px-4 py-2.5 text-sm font-medium transition sm:px-5 ${
                        selected
                          ? "border-black bg-black text-white"
                          : "border-gray-200 bg-white text-gray-700 hover:border-black"
                      }`}
                    >
                      {size.nombre}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* COLORES */}
            <div>
              <p className="mb-3 text-sm font-medium text-gray-700">
                ¿Qué colores tiene?
              </p>

              <div className="flex flex-wrap gap-2 sm:gap-3">
                {colors.map((color) => {
                  const selected =
                    selectedNewColors.includes(color.id);

                  return (
                    <button
                      key={color.id}
                      type="button"
                      onClick={() =>
                        toggleNewColor(color.id)
                      }
                      disabled={saving}
                      aria-pressed={selected}
                      className={`min-h-11 rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
                        selected
                          ? "border-black bg-black text-white"
                          : "border-gray-200 bg-white text-gray-700 hover:border-black"
                      }`}
                    >
                      {color.nombre}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* STOCK INICIAL */}
            {selectedNewSizes.length > 0 &&
              selectedNewColors.length > 0 && (
                <div>
                  <div className="mb-3">
                    <p className="text-sm font-medium text-gray-700">
                      ¿Cuántas unidades tienes?
                    </p>

                    <p className="mt-1 text-xs text-gray-500">
                      Escribe la cantidad de cada talla y color. Las que
                      dejes en 0 no se guardan.
                    </p>
                  </div>

                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="w-full text-sm">
                      <thead className="border-b border-gray-200 bg-gray-50">
                        <tr>
                          <th className="px-3 py-3 text-left font-medium text-gray-500 sm:px-4">
                            Talla
                          </th>

                          <th className="px-3 py-3 text-left font-medium text-gray-500 sm:px-4">
                            Color
                          </th>

                          <th className="px-3 py-3 text-left font-medium text-gray-500 sm:px-4">
                            Cantidad
                          </th>
                        </tr>
                      </thead>

                      <tbody>
                        {selectedNewSizes.flatMap((sizeId) =>
                          selectedNewColors.map((colorId) => {
                            const size = sizes.find(
                              (item) =>
                                item.id === sizeId,
                            );

                            const color = colors.find(
                              (item) =>
                                item.id === colorId,
                            );

                            return (
                              <tr
                                key={getVariantKey(
                                  sizeId,
                                  colorId,
                                )}
                                className="border-b border-gray-100 last:border-0"
                              >
                                <td className="px-3 py-2 font-medium text-black sm:px-4">
                                  {size?.nombre}
                                </td>

                                <td className="px-3 py-2 text-gray-600 sm:px-4">
                                  {color?.nombre}
                                </td>

                                <td className="px-3 py-2 sm:px-4">
                                  <input
                                    type="number"
                                    inputMode="numeric"
                                    aria-label={`Cantidad ${size?.nombre ?? ""} ${color?.nombre ?? ""}`}
                                    min="0"
                                    step="1"
                                    value={getVariantQuantity(
                                      sizeId,
                                      colorId,
                                    )}
                                    onChange={(event) =>
                                      setVariantQuantityValue(
                                        sizeId,
                                        colorId,
                                        Number(
                                          event.target.value,
                                        ),
                                      )
                                    }
                                    disabled={saving}
                                    className="h-11 w-20 rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-black outline-none focus:border-black sm:w-28"
                                  />
                                </td>
                              </tr>
                            );
                          }),
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

            {message && (
              <p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
                {message}
              </p>
            )}

            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={closeNewProduct}
                disabled={saving}
                className="min-h-11 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:border-black hover:text-black disabled:opacity-50"
              >
                Cancelar
              </button>

              <button
                type="button"
                onClick={() => void handleCreateProduct()}
                disabled={saving}
                className="min-h-11 rounded-lg bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {saving
                  ? "Guardando..."
                  : "Guardar producto"}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* AGREGAR STOCK: recepción de una o varias prendas */}
      {showNewVariant && (
        <section ref={newVariantRef} className="scroll-mt-20 rounded-xl border border-gray-200 bg-white p-4 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-black">
                Agregar stock
              </h2>

              <p className="mt-1 text-sm text-gray-500">
                Anota la mercadería que llegó: una o varias prendas a la vez, con la fecha y hora real de llegada. Cada talla y color queda
                guardada como un lote. Se guarda en: <b className="text-black">{selected ? branchLabel(selected) : "—"}</b>.
              </p>
            </div>

            <button
              type="button"
              onClick={closeNewVariant}
              disabled={saving}
              aria-label="Cerrar"
              className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-black disabled:opacity-50"
            >
              <X size={20} />
            </button>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label htmlFor="rec-fecha" className="mb-2 block text-sm font-medium text-gray-700">¿Cuándo llegó?</label>
              <input
                id="rec-fecha"
                type="datetime-local"
                value={receipt.fecha}
                max={emptyReceipt().fecha}
                onChange={(e) => editReceipt({ fecha: e.target.value })}
                disabled={saving}
                className="min-h-11 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-black outline-none focus:border-black"
              />
              {receiptErrors.fecha && <p data-field-error className="mt-1 text-xs text-red-600">{receiptErrors.fecha}</p>}
            </div>
            <div>
              <label htmlFor="rec-proveedor" className="mb-2 block text-sm font-medium text-gray-700">Proveedor (opcional)</label>
              <input
                id="rec-proveedor"
                maxLength={120}
                value={receipt.proveedor}
                onChange={(e) => editReceipt({ proveedor: e.target.value })}
                disabled={saving}
                className="min-h-11 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-black outline-none focus:border-black"
              />
            </div>
            <div>
              <label htmlFor="rec-ref" className="mb-2 block text-sm font-medium text-gray-700">N.º de factura o guía (opcional)</label>
              <input
                id="rec-ref"
                maxLength={80}
                value={receipt.referencia}
                onChange={(e) => editReceipt({ referencia: e.target.value })}
                disabled={saving}
                className="min-h-11 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-black outline-none focus:border-black"
              />
            </div>
            <div>
              <label htmlFor="rec-notas" className="mb-2 block text-sm font-medium text-gray-700">Notas (opcional)</label>
              <input
                id="rec-notas"
                maxLength={300}
                value={receipt.notas}
                onChange={(e) => editReceipt({ notas: e.target.value })}
                disabled={saving}
                className="min-h-11 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-black outline-none focus:border-black"
              />
            </div>
          </div>

          <p className="mt-6 text-sm font-medium text-gray-700">Prendas que llegaron</p>
          <ul className="mt-2 space-y-3">
            {receipt.lineas.map((l, i) => (
              <li key={l.key} className="rounded-lg border border-gray-200 p-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-[2fr_1fr_1.4fr_1fr_auto] sm:items-end">
                  <label className="col-span-2 text-xs font-medium text-gray-600 sm:col-span-1">
                    Modelo
                    <select
                      value={l.productoId}
                      onChange={(e) => editLine(l.key, { productoId: e.target.value, colorId: "" })}
                      disabled={saving}
                      className="mt-1 min-h-11 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-black outline-none focus:border-black"
                    >
                      <option value="">Elige el modelo</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>{product.nombre}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-medium text-gray-600">
                    Talla
                    <select
                      value={l.tallaId}
                      onChange={(e) => editLine(l.key, { tallaId: e.target.value })}
                      disabled={saving}
                      className="mt-1 min-h-11 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-black outline-none focus:border-black"
                    >
                      <option value="">Talla</option>
                      {selectableSizes(sizes).map((size) => (
                        <option key={size.id} value={size.id}>{size.nombre}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-medium text-gray-600">
                    Color
                    <select
                      value={l.colorId}
                      onChange={(e) => editLine(l.key, { colorId: e.target.value })}
                      disabled={saving}
                      className="mt-1 min-h-11 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-black outline-none focus:border-black"
                    >
                      <option value="">Color</option>
                      {colorsForProduct(colors, l.productoId).map((color) => (
                        <option key={color.id} value={color.id}>{color.nombre}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-medium text-gray-600">
                    ¿Cuántas?
                    <input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      step="1"
                      value={l.cantidad}
                      onChange={(e) => editLine(l.key, { cantidad: e.target.value })}
                      disabled={saving}
                      placeholder="Ej. 5"
                      className="mt-1 min-h-11 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm text-black outline-none focus:border-black"
                    />
                  </label>
                  {receipt.lineas.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => editReceipt({ lineas: receipt.lineas.filter((x) => x.key !== l.key) })}
                      disabled={saving}
                      aria-label={`Quitar la prenda ${i + 1}`}
                      className="flex h-11 w-11 items-center justify-center justify-self-end rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600 sm:justify-self-auto"
                    >
                      <Trash2 size={18} />
                    </button>
                  ) : (
                    <span className="hidden sm:block sm:w-11" />
                  )}
                </div>
                {receiptErrors[l.key] && <p data-field-error className="mt-2 text-xs text-red-600">{receiptErrors[l.key]}</p>}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => editReceipt({ lineas: [...receipt.lineas, emptyLine()] })}
            disabled={saving || receipt.lineas.length >= 200}
            className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-dashed border-gray-300 px-4 text-sm font-medium text-gray-700 hover:border-black hover:text-black disabled:opacity-50"
          >
            <Plus size={16} /> Agregar otra prenda
          </button>

          <p className="mt-4 text-sm text-gray-600">
            Total: <b className="text-black">{totalUnits(receipt)} unidades</b> en {receipt.lineas.length} {receipt.lineas.length === 1 ? "lote" : "lotes"}
          </p>

          {message && (
            <p role="status" className="mt-4 rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
              {message}
            </p>
          )}

          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={closeNewVariant}
              disabled={saving}
              className="min-h-11 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:border-black hover:text-black disabled:opacity-50"
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={() => void handleCreateVariant()}
              disabled={saving}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {saving && <LoaderCircle size={16} className="animate-spin" />}
              {saving ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </section>
      )}

      {/* AGREGAR STOCK */}
      {showAddStock && selectedInventoryItem && (
        <section ref={addStockRef} className="scroll-mt-20 rounded-xl border border-black bg-white p-4 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-black">
                Agregar stock
              </h2>

              <p className="mt-1 text-sm text-gray-500">
                Suma las unidades que llegaron de esta talla y color.
              </p>
            </div>

            <button
              type="button"
              onClick={closeAddStock}
              disabled={saving}
              aria-label="Cerrar"
              className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-black disabled:opacity-50"
            >
              <X size={20} />
            </button>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 sm:mt-6 sm:grid-cols-3 sm:gap-4">
            <div className="col-span-2 rounded-lg bg-gray-50 p-3 sm:col-span-1 sm:p-4">
              <p className="text-xs text-gray-500">
                Producto
              </p>

              <p className="mt-1 font-medium text-black">
                {selectedInventoryItem.producto.nombre}
              </p>
            </div>

            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-xs text-gray-500">
                Talla / Color
              </p>

              <p className="mt-1 font-medium text-black">
                {selectedInventoryItem.talla.nombre} /{" "}
                {selectedInventoryItem.color.nombre}
              </p>
            </div>

            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-xs text-gray-500">
                Stock actual
              </p>

              <p className="mt-1 text-xl font-semibold text-black">
                {selectedInventoryItem.cantidad}
              </p>
            </div>
          </div>

          <div className="mt-5 sm:mt-6 sm:max-w-sm">
            <label htmlFor="stock-add-qty" className="mb-2 block text-sm font-medium text-gray-700">
              ¿Cuántas llegaron?
            </label>

            <input
              id="stock-add-qty"
              type="number"
              inputMode="numeric"
              autoFocus
              min="1"
              step="1"
              value={stockToAdd}
              onChange={(event) =>
                setStockToAdd(event.target.value)
              }
              disabled={saving}
              placeholder="Ej. 10"
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-black outline-none focus:border-black"
            />

            <p className="mt-2 text-sm text-gray-500">
              Nuevo stock:{" "}
              <span className="font-semibold text-black">
                {selectedInventoryItem.cantidad +
                  (Number(stockToAdd) || 0)}
              </span>
            </p>
          </div>

          {message && (
            <p className="mt-5 rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
              {message}
            </p>
          )}

          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={closeAddStock}
              disabled={saving}
              className="min-h-11 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:border-black hover:text-black disabled:opacity-50"
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={() => void handleAddStock()}
              disabled={saving}
              className="min-h-11 rounded-lg bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {saving
                ? "Actualizando..."
                : "Agregar stock"}
            </button>
          </div>
        </section>
      )}

      {/* LOTES de una talla/color */}
      {lotsFor && (
        <section ref={lotsRef} className="scroll-mt-20 rounded-xl border border-black bg-white p-4 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-black">Lotes</h2>
              <p className="mt-1 text-sm text-gray-500">
                {lotsFor.producto.nombre} · Talla {lotsFor.talla.nombre} · {lotsFor.color.nombre} · {selected ? branchLabel(selected) : ""}
              </p>
              <p className="mt-1 text-xs text-gray-500">Cada lote es mercadería que llegó junta. Se vende primero la más antigua.</p>
            </div>
            <button
              type="button"
              onClick={() => setLotsFor(null)}
              aria-label="Cerrar lotes"
              className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-black"
            >
              <X size={20} />
            </button>
          </div>

          {lotsLoading && (
            <p className="mt-4 flex items-center gap-2 text-sm text-gray-500">
              <LoaderCircle size={16} className="animate-spin" /> Cargando lotes...
            </p>
          )}
          {lotsError && <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{lotsError}</p>}
          {!lotsLoading && !lotsError && lots.length === 0 && <p className="mt-4 text-sm text-gray-500">Esta talla y color todavía no tiene lotes.</p>}

          <ul className="mt-4 space-y-3">
            {lots.map((lot) => (
              <li key={lot.id} className={`rounded-lg border p-3 text-sm ${lot.cantidad_restante > 0 ? "border-gray-200" : "border-gray-100 bg-gray-50 text-gray-500"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-black">{lot.codigo}</p>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${LOT_STATE_CLASS[lot.estado]}`}>{LOT_STATE_TEXT[lot.estado]}</span>
                </div>
                <p className="mt-1">
                  {lot.fecha_recepcion ? (
                    <>
                      Llegó a la empresa: <b>{formatBoliviaDateTime(lot.fecha_recepcion)}</b> · hace {daysText(lot.dias_en_inventario)}
                    </>
                  ) : (
                    <span className="text-gray-500">Fecha de llegada desconocida ({lot.origen_texto.toLowerCase()})</span>
                  )}
                </p>
                {lot.traspaso && lot.fecha_llegada && (
                  <p className="text-gray-600">Llegó aquí por {lot.traspaso.codigo}: {formatBoliviaDateTime(lot.fecha_llegada)}</p>
                )}
                <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-gray-50 p-2">
                    <dt className="text-[11px] text-gray-500">Llegaron</dt>
                    <dd className="font-semibold text-black">{lot.cantidad_inicial}</dd>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-2">
                    <dt className="text-[11px] text-gray-500">Vendidas</dt>
                    <dd className="font-semibold text-black">{lot.vendidas}</dd>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-2">
                    <dt className="text-[11px] text-gray-500">Quedan</dt>
                    <dd className="font-semibold text-black">{lot.cantidad_restante}</dd>
                  </div>
                </dl>
                <p className="mt-2 text-xs text-gray-600">
                  {lot.primera_venta
                    ? lot.dias_hasta_primera_venta !== null
                      ? `Primera venta ${lot.dias_hasta_primera_venta === 0 ? "el mismo día que llegó" : `${daysText(lot.dias_hasta_primera_venta)} después de llegar`}.`
                      : `Primera venta: ${formatBoliviaDateTime(lot.primera_venta)}.`
                    : "Aún no se vendió ninguna prenda de este lote."}
                  {lot.promedio_diario !== null && ` Se vende ${String(lot.promedio_diario).replace(".", ",")} por día en promedio.`}
                  {lot.traspasadas > 0 && ` ${lot.traspasadas} enviadas a otra sucursal.`}
                  {lot.en_transito > 0 && ` ${lot.en_transito} en camino.`}
                  {lot.otras_salidas > 0 && ` ${lot.otras_salidas} sacadas (no venta).`}
                </p>
                {(lot.proveedor || lot.referencia || lot.recepcion) && (
                  <p className="mt-1 text-xs text-gray-500">
                    {[lot.recepcion?.codigo, lot.proveedor && `Proveedor: ${lot.proveedor}`, lot.referencia && `Guía: ${lot.referencia}`].filter(Boolean).join(" · ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* RESUMEN */}
      <section className="grid grid-cols-3 gap-2 sm:gap-4">
        <article className="rounded-xl border border-gray-200 bg-white p-3 sm:p-5">
          <p className="text-xs text-gray-500 sm:text-sm">
            Unidades en stock
          </p>

          <p className="mt-1 text-xl font-semibold text-black sm:mt-2 sm:text-2xl">
            {totalStock}
          </p>
        </article>

        <article className="rounded-xl border border-gray-200 bg-white p-3 sm:p-5">
          <p className="text-xs text-gray-500 sm:text-sm">
            Modelos
          </p>

          <p className="mt-1 text-xl font-semibold text-black sm:mt-2 sm:text-2xl">
            {totalProducts}
          </p>
        </article>

        <article className="rounded-xl border border-gray-200 bg-white p-3 sm:p-5">
          <p className="text-xs text-gray-500 sm:text-sm">
            Tallas y colores
          </p>

          <p className="mt-1 text-xl font-semibold text-black sm:mt-2 sm:text-2xl">
            {inventory.length}
          </p>
        </article>
      </section>

      {/* CARGANDO */}
      {loading && (
        <section className="rounded-xl border border-gray-200 bg-white p-8">
          <p className="text-sm text-gray-500">
            Cargando inventario...
          </p>
        </section>
      )}

      {/* ERROR */}
      {error && (
        <section className="rounded-xl border border-red-200 bg-red-50 p-6">
          <p className="text-sm font-medium text-red-700">
            {error}
          </p>
        </section>
      )}

      {photoMessage && (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">{photoMessage}</p>
      )}

      <input
        ref={photoInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          const productId = photoTarget.current;
          if (!file || productId === null) return;
          const problem = photoFileError(file);
          if (problem) {
            setPhotoMessage(problem);
            return;
          }
          try {
            setPhotoMessage("Subiendo foto...");
            await uploadProductPhoto(productId, file);
            setPhotoMessage("Foto actualizada.");
            await loadData();
          } catch (err) {
            setPhotoMessage(err instanceof Error ? err.message : "No se pudo subir la foto.");
          }
        }}
      />

      {/* TABLA */}
      {!loading && !error && (
        <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-200 p-4 sm:p-5">
            <label htmlFor="inv-search" className="sr-only">Buscar en el inventario</label>
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 focus-within:border-black focus-within:bg-white">
              <Search size={18} className="shrink-0 text-gray-400" />
              <input
                id="inv-search"
                type="search"
                enterKeyHint="search"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar modelo, talla o color"
                className="h-11 w-full min-w-0 bg-transparent text-sm text-black outline-none placeholder:text-gray-400"
              />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:flex lg:flex-row">
              <select
                aria-label="Filtrar por modelo"
                value={selectedModel}
                onChange={(event) =>
                  setSelectedModel(event.target.value)
                }
                className="col-span-2 min-h-11 min-w-0 flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-black outline-none focus:border-black sm:px-4"
              >
                <option value="">Todos los modelos</option>

                {products.map((product) => (
                  <option key={product.id} value={product.nombre}>
                    {product.nombre}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filtrar por talla"
                value={selectedSize}
                onChange={(event) =>
                  setSelectedSize(event.target.value)
                }
                className="min-h-11 min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-black outline-none focus:border-black sm:px-4"
              >
                <option value="">
                  Talla: todas
                </option>

                {sizes.map((size) => (
                  <option
                    key={size.id}
                    value={size.nombre}
                  >
                    Talla {size.nombre}
                  </option>
                ))}
              </select>

              <select
                aria-label="Filtrar por color"
                value={selectedColor}
                onChange={(event) =>
                  setSelectedColor(event.target.value)
                }
                className="min-h-11 min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-black outline-none focus:border-black sm:px-4"
              >
                <option value="">
                  Color: todos
                </option>

                {colors.map((color) => (
                  <option
                    key={color.id}
                    value={color.nombre}
                  >
                    {color.nombre}
                  </option>
                ))}
              </select>

              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="col-span-2 flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:border-black hover:text-black"
                >
                  <X size={16} />
                  Limpiar
                </button>
              )}
            </div>
          </div>

          {/* Móvil y tablet: tarjetas por modelo con sus variantes. */}
          <ul className="divide-y divide-gray-100 lg:hidden">
            {groupedInventory.map((group) => (
              <li key={group.producto.id} className="p-4">
                <div className="flex items-start gap-3">
                  <ProductThumb product={products.find((p) => p.id === group.producto.id)} size={48} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-black">{group.producto.nombre}</p>
                    <p className="text-xs text-gray-500">
                      {group.total} {group.total === 1 ? "unidad" : "unidades"} en total
                    </p>
                  </div>
                  {user?.rol === "admin" && (
                    <button
                      type="button"
                      onClick={() => {
                        photoTarget.current = group.producto.id;
                        photoInput.current?.click();
                      }}
                      aria-label={`Cambiar foto de ${group.producto.nombre}`}
                      className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-black"
                    >
                      <Camera size={18} />
                    </button>
                  )}
                </div>
                <ul className="mt-3 space-y-2">
                  {group.items.map((item) => {
                    const status = getStockStatus(item.cantidad);
                    return (
                      <li key={item.id} className="flex items-center gap-3 rounded-lg bg-gray-50 py-1 pl-3 pr-1">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-black">
                            Talla {item.talla.nombre} · {item.color.nombre}
                          </p>
                          <span className={`mt-0.5 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${status.className}`}>
                            {status.label}
                          </span>
                          {item.ingreso && <p className="mt-1 text-[11px] text-gray-500">{entryText(item.ingreso, formatBoliviaDateTime)}</p>}
                        </div>
                        <p className="shrink-0 text-right">
                          <span className="block text-lg font-semibold leading-none text-black">{item.cantidad}</span>
                          <span className="text-[11px] text-gray-500">en stock</span>
                        </p>
                        <button
                          type="button"
                          onClick={() => void openLots(item)}
                          aria-label={`Ver lotes de ${item.producto.nombre} talla ${item.talla.nombre} ${item.color.nombre}`}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-700 hover:border-black hover:text-black"
                        >
                          <Layers size={18} />
                        </button>
                        {!isConsolidated && (
                          <button
                            type="button"
                            onClick={() => openAddStock(item)}
                            aria-label={`Agregar stock a ${item.producto.nombre} talla ${item.talla.nombre} ${item.color.nombre}`}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-700 hover:border-black hover:text-black"
                          >
                            <Plus size={18} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-5 py-4 font-medium text-gray-500">
                    Producto
                  </th>

                  <th className="px-5 py-4 font-medium text-gray-500">
                    Talla
                  </th>

                  <th className="px-5 py-4 font-medium text-gray-500">
                    Color
                  </th>

                  <th className="px-5 py-4 text-center font-medium text-gray-500">
                    Stock
                  </th>

                  <th className="px-5 py-4 text-center font-medium text-gray-500">
                    Estado
                  </th>

                  <th className="px-5 py-4 font-medium text-gray-500">
                    Fecha y hora de ingreso
                  </th>

                  <th className="px-5 py-4 text-center font-medium text-gray-500">
                    Acción
                  </th>
                </tr>
              </thead>

              <tbody>
                {filteredInventory.map((item) => {
                  const status =
                    getStockStatus(item.cantidad);

                  return (
                    <tr
                      key={item.id}
                      className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                    >
                      <td className="px-5 py-4 font-medium text-black">
                        <div className="flex items-center gap-3">
                          <ProductThumb
                            product={products.find((p) => p.id === item.producto.id)}
                            size={40}
                          />
                          <div className="min-w-0">
                            <p>{item.producto.nombre}</p>
                            {user?.rol === "admin" && (
                              <button
                                type="button"
                                onClick={() => {
                                  photoTarget.current = item.producto.id;
                                  photoInput.current?.click();
                                }}
                                className="mt-1 inline-flex items-center gap-1 text-xs font-normal text-gray-500 hover:text-black"
                              >
                                <Camera size={13} /> Cambiar foto
                              </button>
                            )}
                          </div>
                        </div>
                      </td>

                      <td className="px-5 py-4 text-gray-600">
                        {item.talla.nombre}
                      </td>

                      <td className="px-5 py-4 text-gray-600">
                        {item.color.nombre}
                      </td>

                      <td className="px-5 py-4 text-center font-semibold text-black">
                        {item.cantidad}
                      </td>

                      <td className="px-5 py-4 text-center">
                        <span
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${status.className}`}
                        >
                          {status.label}
                        </span>
                      </td>

                      <td className="px-5 py-4 text-xs text-gray-600">
                        {entryText(item.ingreso, formatBoliviaDateTime) || "—"}
                      </td>

                      <td className="px-5 py-4 text-center">
                        <div className="flex items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => void openLots(item)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 transition hover:border-black hover:text-black"
                        >
                          <Layers size={15} />
                          Lotes
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            openAddStock(item)
                          }
                          disabled={isConsolidated}
                          title={isConsolidated ? "Elige una sucursal para agregar stock" : undefined}
                          className="disabled:cursor-not-allowed disabled:opacity-40 inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 transition hover:border-black hover:text-black"
                        >
                          <Plus size={15} />
                          Agregar stock
                        </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {filteredInventory.length === 0 && (
            <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
              <div className="rounded-xl bg-gray-100 p-4">
                <Boxes
                  size={28}
                  className="text-gray-500"
                />
              </div>

              <h2 className="mt-4 font-semibold text-black">
                No encontramos resultados
              </h2>

              <p className="mt-2 text-sm text-gray-500">
                Prueba con otro producto, talla o color.
              </p>
            </div>
          )}

          <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 sm:px-5 sm:py-4">
            <p className="text-sm text-gray-500">
              Mostrando{" "}
              <span className="font-medium text-black">
                {filteredInventory.length}
              </span>{" "}
              de{" "}
              <span className="font-medium text-black">
                {inventory.length}
              </span>
            </p>
          </div>
        </section>
      )}

      {!isConsolidated && selectedId !== null && (
        <AjustesInventario
          branchId={selectedId}
          branchName={selected?.nombre ?? ""}
          products={products}
          sizes={sizes}
          colors={colors}
          onDone={() => void loadData()}
        />
      )}
    </div>
  );
}

export default Inventario;