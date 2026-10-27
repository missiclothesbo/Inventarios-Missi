import { api } from "../lib/api";

export interface Product {
  id: number;
  nombre: string;
  estado: boolean;
  /** Ruta relativa a la API (p. ej. /api/productos/3/foto?v=…). null = sin foto. */
  foto_url?: string | null;
  /** Precio de venta por defecto (0 = sin precio definido) */
  precio_venta: number;
  created_at: string;
}

export interface CatalogItem {
  id: number;
  nombre: string;
  estado: boolean;
  /** Solo tallas: true = talla oficial de pantalón (seleccionable para inventario nuevo). */
  oficial_pantalon?: boolean;
  /** Rótulo anterior de la talla, si alguna vez cambió (auditoría). */
  etiqueta_historica?: string | null;
}

/** Tallas que se pueden elegir para inventario o transacciones NUEVAS (las históricas solo se leen). */
export const selectableSizes = (sizes: CatalogItem[]) => sizes.filter((s) => s.oficial_pantalon !== false);

export interface InventoryVariantInput {
  sucursal_id: number;
  producto_id: number;
  talla_id: number;
  color_id: number;
  cantidad: number;
}

export const getProducts = () => api.get<Product[]>("/api/productos");

export const getSizes = () => api.get<CatalogItem[]>("/api/tallas");

export const getColors = () => api.get<CatalogItem[]>("/api/colores");

export { MAX_PHOTO_BYTES, PHOTO_TYPES, photoFileError } from "../lib/validation";
import { photoFileError } from "../lib/validation";

/** Sube (o reemplaza) la foto de un modelo. Solo administrador. */
export async function uploadProductPhoto(productId: number, file: File): Promise<Product> {
  const error = photoFileError(file);
  if (error) throw new Error(error);
  const result = await api.upload<{ id: number; foto_url: string }>(`/api/productos/${productId}/foto`, file, file.type);
  return { id: productId, foto_url: result.foto_url } as Product;
}

export async function createProduct(
  nombre: string,
  precioVenta = 0,
): Promise<Product> {
  const productName = nombre.trim();

  if (!productName) {
    throw new Error("El nombre del producto es obligatorio.");
  }

  return api.post<Product>("/api/productos", {
    nombre: productName,
    precio_venta: precioVenta,
  });
}

/** Cada ingreso lleva su propia clave de idempotencia: un reintento no suma dos veces. */
async function postStock(variant: InventoryVariantInput) {
  await api.post(
    "/api/inventario/agregar",
    {
      sucursal_id: variant.sucursal_id,
      producto_id: variant.producto_id,
      talla_id: variant.talla_id,
      color_id: variant.color_id,
      cantidad: variant.cantidad,
    },
    { "Idempotency-Key": crypto.randomUUID() },
  );
}

/**
 * Stock inicial de un modelo nuevo: UNA recepción (atómica) con un lote por talla/color, fechada ahora.
 * Si algo falla no queda nada a medias; un reintento con la misma clave no suma dos veces. Solo administrador.
 */
export async function createInventoryVariants(
  variants: InventoryVariantInput[],
  idempotencyKey: string = crypto.randomUUID(),
): Promise<void> {
  const validVariants = variants.filter((variant) => variant.cantidad > 0);

  if (validVariants.length === 0) {
    throw new Error("Debes ingresar una cantidad mayor a 0.");
  }

  await api.post("/api/recepciones", {
    idempotency_key: idempotencyKey,
    sucursal_id: validVariants[0].sucursal_id,
    fecha_recepcion: new Date().toISOString(),
    items: validVariants.map((v) => ({ producto_id: v.producto_id, talla_id: v.talla_id, color_id: v.color_id, cantidad: v.cantidad })),
  });
}

export async function addInventoryVariant(
  variant: InventoryVariantInput,
): Promise<void> {
  if (variant.cantidad <= 0) {
    throw new Error("La cantidad debe ser mayor a 0.");
  }

  await postStock(variant);
}

export async function addStock(
  variant: InventoryVariantInput,
): Promise<void> {
  if (variant.cantidad <= 0) {
    throw new Error("La cantidad a agregar debe ser mayor a 0.");
  }

  await postStock(variant);
}
