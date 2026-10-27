# Arquitectura de MISSI

```
React (Vite)  ──HTTPS + Bearer──▶  Cloudflare Worker (api/)  ──D1 binding──▶  Cloudflare D1 (inventarios-missi)
```
Supabase **ya no se usa** en el código. El proyecto y los datos de Supabase siguen existiendo (no se borraron);
su respaldo está en `backups/` y el SQL histórico en `supabase/migrations/` (solo referencia).

## Dónde está cada cosa
| Tema | Ubicación canónica |
|---|---|
| Cliente HTTP único (fetch, token, errores) | `src/lib/apiClient.ts` (lógica) y `src/lib/api.ts` (instancia con `VITE_API_BASE_URL`) |
| Sesión (token en sessionStorage) | `src/lib/session.ts` · contexto `src/context/AuthProvider.tsx` · login `src/pages/Login/Login.tsx` |
| Servicios de datos (uno por dominio) | `src/services/*.service.ts` (sucursales, inventario, productos, ventas, traspasos, reportes, dashboard, usuarios) |
| Gestión de cuentas (solo admin) | Pantalla `src/pages/Usuarios/Usuarios.tsx` (ruta `/usuarios`, protegida con `AdminOnly`) · validación `src/lib/usuarios.ts` |
| Rutas del Worker | `api/src/index.ts` → `api/src/routes/{catalog,sales,transfers,reports}.ts` |
| Autenticación y permisos | `api/src/auth.ts` (sesiones, roles, alcance por sucursal) · `api/src/crypto.ts` (PBKDF2, SHA-256) |
| Validación y HTTP | `api/src/validate.ts`, `api/src/http.ts` |
| Esquema / migraciones D1 | `api/migrations/0001…0011` (aditivas) · base local: `api/local/baseline-from-remote.sql` |
| Pruebas | `api/test/api.test.mjs` (API + D1 local) · `scripts/test-api-client.mjs` · `scripts/run-e2e-local.mjs` (servicios de React contra la API local) |
| Respaldos / cuarentena | `backups/` (ignorado por git) |

## Autenticación
Inicio de sesión con **correo o nombre de usuario** + contraseña (`POST /api/auth/login`, campo `identifier`; se aceptan
también `email`/`username` por compatibilidad). PBKDF2-SHA256, sesión con token opaco (solo su SHA-256 se guarda), 12 h,
bloqueo tras 5 fallos/15 min por cuenta, roles `admin` y `vendedor` (alcance de sucursal validado en el servidor).
Al recargar la página la sesión se valida con `/api/auth/me` (el servidor manda rol, sucursal y nombre); solo un 401 la cierra,
un corte de conexión momentáneo no. Cambiar rol, sucursal o contraseña de una cuenta, o desactivarla, cierra sus sesiones abiertas.

## Variables de entorno
Frontend: solo `VITE_API_BASE_URL` (ver `.env.example`). Worker: `ALLOWED_ORIGINS` y `SESSION_TTL_HOURS` en `api/wrangler.jsonc`
(no hay secretos). Contraseñas y tokens nunca se guardan en el repositorio.

## Comandos (verificados)
```
# Terminal 1 · backend (carpeta api)           npm run dev        → http://127.0.0.1:8790 (base local api/.wrangler/state)
#   predev comprueba el puerto: si ya hay un backend sano lo dice; si quedó uno colgado, indica cómo cerrarlo.
# Terminal 2 · frontend (raíz del proyecto)     npm run dev        → http://localhost:5173 (puerto fijo, --strictPort)
# Pruebas backend (carpeta api)                 npm test           (usa .wrangler/test-state, NO la base de desarrollo)
# Pruebas frontend (raíz)                       npm run test:unit · npm run lint · npm run build
# Integración React↔API (raíz)                  node scripts/run-e2e-local.mjs backups/<marca>   (estado aislado, puerto 8788)
# Cuentas locales (carpeta api)                 node scripts/local-account.mjs list | set-password | create-admin
```
`.env` (raíz) debe tener `VITE_API_BASE_URL=http://127.0.0.1:8790`. No hace falta Cloudflare Tunnel ni ningún servicio remoto.

## Rutas principales del Worker
- Sesión: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` · Salud: `GET /api/health` (`/` responde 404 a propósito).
- Ventas: `GET/POST /api/ventas`, `GET /api/ventas/:id/detalle`, `POST /api/ventas/:id/cancelar` (anulación).
- Cambios y devoluciones: `GET /api/ventas/buscar?q=…` (búsqueda universal), `GET /api/ventas/:id/detalle-completo`,
  `POST /api/operaciones/devolucion`, `POST /api/operaciones/cambio`, `GET /api/operaciones`.
- Reportes: `GET /api/reportes/balance`, `GET /api/reportes/movimientos`, `GET /api/reportes/stock` (periodo `desde`/`hasta` inclusivo, fecha de Bolivia).
- Usuarios (solo admin): `GET/POST /api/usuarios`, `PATCH /api/usuarios/:id` (nombre, usuario, rol + sucursal, activo, contraseña).
  Un vendedor siempre tiene sucursal; un admin no puede quitarse su rol ni desactivarse a sí mismo.

## Venta multiproducto (carrito)
- Una venta = **una** fila en `ventas` (un número, `V-000123` en pantalla y comanda) + **N** filas en `detalle_venta`
  (producto, talla, color, cantidad, precio unitario y subtotal propios). Cliente, pago, entrega y vendedor se guardan una sola vez.
- Frontend: el carrito vive en la máquina de estados `src/lib/ventaFlow.ts` (lógica pura, probada en
  `scripts/venta-flow.test.mjs`). Importes en **centavos enteros**; la misma variante con el mismo precio se fusiona;
  con otro precio se rechaza (no se cambia un precio en silencio). Un fallo del servidor conserva el carrito.
- Backend: `POST /api/ventas` (`api/src/routes/sales.ts`) recibe todas las líneas, ignora cualquier total del cliente,
  valida producto/talla/color/sucursal/stock de **cada** línea y escribe todo en un único `env.DB.batch` (transacción D1:
  si una sentencia falla, se revierte el lote). El descuento es `UPDATE ... cantidad = cantidad - ?` más el `CHECK (cantidad >= 0)`
  de la tabla y una aserción `changes() = 1` por línea, así que ventas simultáneas no pueden dejar stock negativo ni descontar
  una línea sin guardar la venta. La `idempotency_key` (índice único) hace que un reintento devuelva la misma venta.
- Precios: el precio unitario es editable por el vendedor (regla vigente del negocio); el servidor exige > 0 y guarda el precio
  real en `detalle_venta`, por lo que cambiar el precio del modelo después no altera ventas históricas.
- Reportes: los ingresos suman `ventas.total` (una vez por venta); las unidades y el top de productos salen de `detalle_venta`
  en consultas separadas, sin multiplicar totales.

## Tallas oficiales de pantalón
Única fuente de verdad: `shared/catalogo.ts` (la usan el Worker y el frontend; `src/lib/catalogo.ts` solo la re-exporta).
Orden y rótulos exactos (texto literal): **P, M, G, GG, 3G, 4G, 36, 38, 40, 42, 44, 46, 48** ("3G" y "4G" no son 3XL/4XL).
- Migraciones `0008` y `0011`: la talla que se llamaba `GGG` vuelve a `3G` y la que se llamaba `S` pasa a `P`. En ambos casos se conserva el **mismo `id`**, así que inventario, ventas, traspasos, devoluciones y movimientos históricos
  no se tocan; el rótulo anterior queda en `tallas.etiqueta_historica` (auditable). Se agrega `4G`, se reordena y se marca `oficial_pantalon = 1`.
  Cualquier otra talla existente se conserva como histórica (`oficial_pantalon = 0`, al final del orden). Los rótulos oficiales no se pueden renombrar ni borrar sin quitar antes el trigger (triggers).
- Validación en el servidor (`api/src/inventory.ts → validateVariants`): ingresos, ventas, traspasos, reemplazos de cambios y ajustes positivos de **pantalones**
  exigen talla oficial. Otras categorías de producto no tienen esta restricción. Las salidas y devoluciones de stock histórico no se bloquean.
- En la interfaz, los selectores de inventario nuevo solo ofrecen tallas oficiales (`selectableSizes`); los filtros y el historial muestran todas.
- Una variante se identifica por modelo + talla + color + sucursal (`UNIQUE` en `inventario`); el stock nunca se agrega entre tallas o colores distintos.
  La fecha de creación de la variante (`inventario.created_at`) es distinta de la fecha de cada movimiento (`movimientos_inventario.created_at`, hora del servidor, mostrada en hora de Bolivia).

## MISSI BOLIVIA (organización matriz)
- Migración `0010`: tabla `organizaciones` (MISSI BOLIVIA), `sucursales.organizacion_id` y `usuarios.organizacion_id`. Ventas, movimientos, traspasos y devoluciones ya llevan `sucursal_id`; su organización se obtiene por la sucursal
  (no se duplica otra columna que pueda quedar inconsistente). El stock nacional **no se guarda**: se calcula sumando el de las sucursales.
- Autorización en el servidor (`api/src/auth.ts`): cada sesión carga `branch_ids` (administrador = todas las sucursales de su organización; vendedor = solo la suya). `requireBranch`/`scopedBranch` rechazan (403) cualquier otra sucursal y las consultas
  consolidadas añaden `orgBranchesSql(...)`, de modo que "todas" nunca incluye datos de otra organización. La gestión de usuarios, la anulación de ventas y los traspasos también quedan acotados a la organización.
- Una sucursal futura (con `organizacion_id`) entra sola en consolidados, reportes y selectores: no hay lógica fija para dos sucursales.

## Ventas: filtros, pagos y departamentos
- `GET /api/ventas/historial` (paginado en el servidor, con totales de TODOS los resultados): fechas, sucursal u organización, estado, método de pago (QR/efectivo), tipo de entrega, departamento de destino, provincia, municipio, modelo/talla/color (en la misma línea),
  responsable y búsqueda por referencia `V-000123` o cliente. Los filtros se combinan como intersección. El sistema **no registra estado de pago de la venta** (solo el método), por eso no existe filtro de estado de pago.
- Los reportes de modelos y de envíos usan exactamente los mismos filtros (`saleFilters`), así sus totales cuadran con la lista. El departamento se compara sin tildes ni mayúsculas sin reescribir el dato; los envíos sin departamento aparecen como "sin registrar".
- Sin descuentos: el modelo de datos no tiene descuentos ni costos de envío por separado; el valor del pedido es `ventas.total` (suma de líneas).

## Libro de movimientos (`movimientos_inventario`)
Todo cambio de stock pasa por `api/src/inventory.ts → stockChange`, que devuelve el cambio de stock **y** su asiento dentro del mismo lote de D1
(se guardan o se revierten juntos). No hay otra forma de modificar `inventario` desde el Worker.
Categorías de negocio (`categoria`): INGRESO, VENTA, CAMBIO, DEVOLUCION, SALIDA, TRASPASO, AJUSTE. `signo`: +1 entra al stock vendible, −1 sale, 0 no lo cambia
(cuarentena de mercadería dañada). `tipo` queda como valor técnico heredado (su CHECK original no se puede ampliar sin reconstruir la tabla).
Cada asiento guarda: usuario autenticado (`usuario_id`, nunca del cuerpo de la petición), fecha del servidor, sucursal (y origen/destino en traspasos),
variante exacta, cantidad, cantidades anterior y resultante, referencia (venta/traspaso/operación), motivo y notas.
Los registros anteriores se clasificaron con datos que ya existían en otras tablas (operación, vendedor de la venta, "por usuario N", origen/destino del traspaso);
lo que nunca se guardó queda en NULL y la interfaz muestra "No registrado". Nada se inventó.
Inmutabilidad (triggers `0009`): `movimientos_inventario`, `auditoria`, `operacion_items`, `traspaso_detalles` y el detalle/precio de `detalle_venta` no se pueden editar ni borrar;
las correcciones se hacen con un movimiento AJUSTE compensatorio.
Salidas y ajustes: `POST /api/inventario/salida` y `POST /api/inventario/ajuste` (solo administrador, `Idempotency-Key`, motivo obligatorio, nunca stock negativo).

## Traspasos
Ciclo: **pendiente (borrador) → enviado → recibido**; `cancelado` desde pendiente o enviado (si ya salió, el stock vuelve al origen).
El borrador no reserva ni descuenta stock. Despachar descuenta el origen una vez; recibir suma al destino una vez (token de estado + guarda en el mismo lote).
Cada paso guarda el usuario autenticado (`creado_por`, `despachado_por`, `recibido_por`, `cancelado_por`) y la fecha del servidor.
Referencia legible `TR-000123`. Historial: `GET /api/traspasos/historial` (filtros: estado, origen, destino, modelo, talla, color, usuario, fechas, búsqueda; paginado) y
`GET /api/traspasos/:id` (líneas + movimientos generados). Un vendedor solo ve y opera los traspasos de su sucursal.

## Devoluciones y cambios
Motivo estructurado `motivo_codigo` (talla incorrecta, color diferente, modelo diferente, defecto de fábrica, producto dañado, error en el pedido, cliente solicitó cambio, otro)
+ explicación (obligatoria con «Otro»). Un cambio registra por separado lo devuelto (CAMBIO, entra) y el reemplazo (CAMBIO, sale de la sucursal de la venta);
una devolución es DEVOLUCION y no cancela la venta (solo la anulación, exclusiva del administrador, la cancela). Mercadería devuelta dañada no entra al stock vendible.
Historial buscable: `GET /api/operaciones/historial`.

## Reportes analíticos (`/api/reportes/modelos`, `/envios`, `/resumen`; libro en `/api/movimientos`)
- **Fechas**: día calendario de Bolivia (UTC-4), extremos incluidos; sin `desde`/`hasta` = todo el historial. Sucursal: el administrador elige; un vendedor solo la suya (pedir otra = 403).
- **Modelos más vendidos**: unidades = suma de cantidades de las líneas de ventas completadas; ventas = `COUNT(DISTINCT venta)`; ingresos = suma de subtotales de las líneas.
  Orden por unidades. Devueltas/cambiadas se informan aparte (por fecha de la operación); netas = vendidas − devueltas. Los reemplazos de cambios no son ventas.
- **Envíos por departamento**: un pedido = venta completada con destino de envío guardado (cuenta una vez aunque tenga varias líneas); unidades = suma de sus líneas.
  El departamento sale del destino guardado (no de la sucursal que vendió). Se agrupa sin distinguir mayúsculas, tildes ni espacios sin reescribir el dato; lo no reconocido se conserva
  y se muestra "Por revisar". Las ventas de entrega directa no cuentan. Neto = bruto − valor devuelto + valor entregado en cambios.
- **Resumen**: ventas, traspasos (no son ingresos ni cambian el stock total de la empresa), devoluciones/cambios (con motivos y comparación con el periodo anterior) y movimientos por categoría, siempre por separado.

## Comandos de esta fase
```
# pruebas del frontend (raíz)        npm run test:unit        (incluye scripts/catalogo.test.mjs)
# pruebas del backend (carpeta api)  npm test                 (aplica 0008 y 0009 a una base de pruebas aislada)
# aplicar migraciones a la base LOCAL de desarrollo (carpeta api, hace respaldo antes):
#   copiar api/.wrangler/state a backups/<marca>-pre-0008 y luego:  npx wrangler d1 migrations apply DB --local --persist-to .wrangler/state
# NO se aplica nada a Cloudflare remoto sin aprobación explícita.
```
