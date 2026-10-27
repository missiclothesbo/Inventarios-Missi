import { useState } from "react";
import { ImageOff } from "lucide-react";

import { api } from "../lib/api";

interface ProductThumbProps {
  /** Modelo con foto opcional (foto_url relativa a la API). */
  product: { nombre: string; foto_url?: string | null } | undefined;
  size: number;
}

/** Foto del modelo, o un recuadro de respaldo cuando no tiene foto o la imagen no carga. */
function ProductThumb({ product, size }: ProductThumbProps) {
  const [failed, setFailed] = useState(false);
  const src = product?.foto_url && api.baseUrl ? `${api.baseUrl}${product.foto_url}` : null;

  if (!src || failed) {
    return (
      <div
        className="flex shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-100 text-gray-400"
        style={{ width: size, height: size }}
        role="img"
        aria-label="Sin foto"
      >
        <ImageOff size={size / 2} />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={product?.nombre ?? "Modelo"}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="shrink-0 rounded-lg border border-gray-200 object-cover"
      style={{ width: size, height: size }}
    />
  );
}

export default ProductThumb;
