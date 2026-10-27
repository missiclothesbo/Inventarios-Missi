import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, LoaderCircle, Plus, Trash2 } from "lucide-react";

import { useSucursal } from "../../context/useSucursal";
import { getInventory, type InventoryItem } from "../../services/inventory.service";
import {
  getColors,
  getProducts,
  getSizes,
  selectableSizes,
  type CatalogItem,
  type Product,
} from "../../services/product.service";
import {
  cancelTransfer,
  createTransfer,
  dispatchTransfer,
  receiveTransfer,
  type TransferItemInput,
} from "../../services/transfers.service";
import TraspasosHistorial from "./TraspasosHistorial";

const INPUT_CLASS =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-black";

function Traspasos() {
  const { branches } = useSucursal();

  const [originId, setOriginId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [responsible, setResponsible] = useState("");
  const [notes, setNotes] = useState("");

  const [productId, setProductId] = useState("");
  const [sizeId, setSizeId] = useState("");
  const [colorId, setColorId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [items, setItems] = useState<TransferItemInput[]>([]);

  const [products, setProducts] = useState<Product[]>([]);
  const [sizes, setSizes] = useState<CatalogItem[]>([]);
  const [colors, setColors] = useState<CatalogItem[]>([]);
  const [originStock, setOriginStock] = useState<InventoryItem[]>([]);
  const [refresh, setRefresh] = useState(0);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const idempotencyKey = useRef(crypto.randomUUID());

  useEffect(() => {
    // Carga inicial desde la API.
    Promise.all([getProducts(), getSizes(), getColors()])
      .then(([p, s, c]) => {
        setProducts(p);
        setSizes(s);
        setColors(c);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Error al cargar."),
      )
      .finally(() => setLoading(false));
  }, []);

  // Valores por defecto: central → la otra sucursal.
  useEffect(() => {
    if (branches.length >= 2 && !originId) {
      const central = branches.find((b) => b.es_central) ?? branches[0];
      const other = branches.find((b) => b.id !== central.id);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOriginId(String(central.id));
      setDestinationId(String(other?.id ?? ""));
    }
  }, [branches, originId]);

  // Stock disponible en el origen elegido.
  useEffect(() => {
    if (!originId) return;
    let cancelled = false;
    getInventory(Number(originId))
      .then((data) => {
        if (!cancelled) setOriginStock(data);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Error al cargar stock."),
      );
    return () => {
      cancelled = true;
    };
  }, [originId]);

  const available = useMemo(() => {
    const row = originStock.find(
      (item) =>
        item.producto.id === Number(productId) &&
        item.talla.id === Number(sizeId) &&
        item.color.id === Number(colorId),
    );
    return row?.cantidad ?? 0;
  }, [originStock, productId, sizeId, colorId]);

  const nameOf = (list: { id: number; nombre: string }[], id: number) =>
    list.find((item) => item.id === id)?.nombre ?? "—";
  const branchName = (id: number) =>
    branches.find((b) => b.id === id)?.nombre ?? "—";

  function addItem() {
    setError("");
    const qty = Number(quantity);

    if (!productId || !sizeId || !colorId) {
      setError("Selecciona modelo, talla y color.");
      return;
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      setError("La cantidad debe ser un entero mayor a 0.");
      return;
    }

    const already = items
      .filter(
        (i) =>
          i.producto_id === Number(productId) &&
          i.talla_id === Number(sizeId) &&
          i.color_id === Number(colorId),
      )
      .reduce((sum, i) => sum + i.cantidad, 0);

    if (already + qty > available) {
      setError(`Stock insuficiente en el origen. Disponible: ${available}.`);
      return;
    }

    setItems((current) => [
      ...current.filter(
        (i) =>
          !(
            i.producto_id === Number(productId) &&
            i.talla_id === Number(sizeId) &&
            i.color_id === Number(colorId)
          ),
      ),
      {
        producto_id: Number(productId),
        talla_id: Number(sizeId),
        color_id: Number(colorId),
        cantidad: already + qty,
      },
    ]);
    setProductId("");
    setSizeId("");
    setColorId("");
    setQuantity("1");
  }

  async function run(action: () => Promise<unknown>, okMessage: string) {
    try {
      setBusy(true);
      setError("");
      setSuccess("");
      await action();
      setSuccess(okMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operación fallida.");
      setBusy(false);
      return;
    }

    // La operación ya se aplicó: un fallo al refrescar no debe presentarse como fallo de la operación.
    try {
      setRefresh((n) => n + 1);
      if (originId) setOriginStock(await getInventory(Number(originId)));
    } catch (err) {
      setError(
        `La operación se realizó, pero no se pudo actualizar la lista: ${
          err instanceof Error ? err.message : "error desconocido"
        }`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    await run(async () => {
      await createTransfer({
        origen_id: Number(originId),
        destino_id: Number(destinationId),
        responsable: responsible,
        notas: notes,
        items,
        idempotency_key: idempotencyKey.current,
      });
      idempotencyKey.current = crypto.randomUUID();
      setItems([]);
      setNotes("");
    }, "Traspaso creado en estado pendiente. El stock se descuenta al despacharlo.");
  }

  if (loading) {
    return (
      <div className="flex min-h-[300px] items-center justify-center gap-3 text-gray-500">
        <LoaderCircle size={22} className="animate-spin" /> Cargando...
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-black sm:text-2xl">Traspasos</h1>
        <p className="mt-1 text-sm text-gray-500">
          Movimientos de stock entre sucursales. Un traspaso nunca cuenta como
          venta ni como ingreso.
        </p>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {success && (
        <p className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {success}
        </p>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold text-black">Nuevo traspaso</h2>

        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="tr-origin" className="mb-1 block text-sm font-medium text-gray-700">Origen</label>
            <select
              id="tr-origin"
              value={originId}
              onChange={(event) => {
                const newOrigin = event.target.value;
                setOriginId(newOrigin);
                // El destino nunca puede ser igual al origen.
                if (destinationId === newOrigin) {
                  setDestinationId(
                    String(branches.find((b) => String(b.id) !== newOrigin)?.id ?? ""),
                  );
                }
                setItems([]);
              }}
              className={INPUT_CLASS}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.nombre}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="tr-dest" className="mb-1 block text-sm font-medium text-gray-700">Destino</label>
            <select
              id="tr-dest"
              value={destinationId}
              onChange={(event) => setDestinationId(event.target.value)}
              className={INPUT_CLASS}
            >
              {branches
                .filter((b) => String(b.id) !== originId)
                .map((b) => (
                  <option key={b.id} value={b.id}>{b.nombre}</option>
                ))}
            </select>
          </div>

          <div>
            <label htmlFor="tr-resp" className="mb-1 block text-sm font-medium text-gray-700">Entrega físicamente (opcional)</label>
            <input id="tr-resp" value={responsible} onChange={(event) => setResponsible(event.target.value)} className={INPUT_CLASS} />
          </div>

          <div>
            <label htmlFor="tr-notes" className="mb-1 block text-sm font-medium text-gray-700">Notas (opcional)</label>
            <input id="tr-notes" value={notes} onChange={(event) => setNotes(event.target.value)} className={INPUT_CLASS} />
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5 lg:gap-4">
          <select aria-label="Modelo" value={productId} onChange={(event) => setProductId(event.target.value)} className={`${INPUT_CLASS} col-span-2 lg:col-span-1`}>
            <option value="">Modelo</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
          <select aria-label="Talla" value={sizeId} onChange={(event) => setSizeId(event.target.value)} className={INPUT_CLASS}>
            <option value="">Talla</option>
            {selectableSizes(sizes).map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
          </select>
          <select aria-label="Color" value={colorId} onChange={(event) => setColorId(event.target.value)} className={INPUT_CLASS}>
            <option value="">Color</option>
            {colors.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
          <input aria-label="Cantidad" type="number" inputMode="numeric" min="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} className={INPUT_CLASS} />
          <button type="button" onClick={addItem} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-black px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-800">
            <Plus size={16} /> Agregar
          </button>
        </div>

        {productId && sizeId && colorId && (
          <p className="mt-2 text-xs text-gray-500">
            Disponible en {branchName(Number(originId))}: {available}
          </p>
        )}

        {items.length > 0 && (
          <ul className="mt-4 divide-y divide-gray-100 rounded-lg border border-gray-200">
            {items.map((item) => (
              <li key={`${item.producto_id}-${item.talla_id}-${item.color_id}`} className="flex items-center justify-between gap-3 py-1 pl-4 pr-1 text-sm">
                <span className="min-w-0">
                  {nameOf(products, item.producto_id)} · {nameOf(sizes, item.talla_id)} · {nameOf(colors, item.color_id)} · <b>{item.cantidad}</b>
                </span>
                <button
                  type="button"
                  aria-label={`Quitar ${nameOf(products, item.producto_id)} de la lista`}
                  onClick={() => setItems((current) => current.filter((i) => i !== item))}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          disabled={busy || items.length === 0 || !originId || !destinationId}
          onClick={() => void handleCreate()}
          className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-black px-5 py-3 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300 sm:w-auto"
        >
          <ArrowLeftRight size={17} /> Crear traspaso
        </button>
      </section>

      <TraspasosHistorial
        branches={branches}
        products={products}
        sizes={sizes}
        colors={colors}
        refreshToken={refresh}
        busy={busy}
        onAction={run}
        actions={{ dispatch: dispatchTransfer, receive: receiveTransfer, cancel: cancelTransfer }}
      />
    </div>
  );
}

export default Traspasos;
