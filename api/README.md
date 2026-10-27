# MISSI API (Cloudflare Workers + D1)

Estado: **solo desarrollo local**. Nada de esto está desplegado ni aplicado a la base remota.
El Worker de producción (`fancy-firefly-9028`) sigue con solo `GET /api/health` y `GET /api/sucursales`.
Su código original está respaldado en `backups/<marca>/worker/`.

## Local (no toca Cloudflare ni Supabase)
```bash
cd api
npm install
npm run db:reset:local          # SOLO base de PRUEBAS (.wrangler/test-state): esquema real de produccion (local/baseline-from-remote.sql) + migraciones 0001-0003
npm test                        # 28 pruebas de integracion (wrangler dev --local + D1 local)
npm run typecheck
node scripts/import-supabase.mjs ../backups/<marca> --apply-local   # importa y reconcilia el respaldo de Supabase
# crear un administrador local (contraseña por variable de entorno, nunca en argumentos):
#   $env:MISSI_ADMIN_PASSWORD = "<12+ caracteres>"; node scripts/create-admin.mjs --email a@b.c --nombre "Nombre" --local
npm run dev                     # API en http://127.0.0.1:8790 (base local de desarrollo .wrangler/state)
```
Integracion de la capa de servicios de React contra esa API: `node scripts/run-e2e-local.mjs backups/<marca>` (desde la raiz).

## Migraciones (orden)
`migrations/0001_sucursales_catalogo.sql` → `0002_ventas_destinos_traspasos.sql` → `0003_auth.sql`.
Son aditivas (ADD COLUMN, índices, triggers, tablas nuevas); no reconstruyen ni borran tablas. Ya probadas **en D1 local**.
`local/baseline-from-remote.sql` es el export remoto del 18-oct-2026 y solo sirve para recrear la base local.

## Seguridad (diseño)
- **Contraseñas**: PBKDF2-SHA256, 100 000 iteraciones (máximo que admite Workers), sal de 16 bytes, formato versionado.
  Mínimo 12 caracteres. Comparación en tiempo constante; si el correo no existe se calcula igual un hash (sin enumeración por tiempo).
- **Sesión**: token opaco aleatorio de 256 bits; en la base solo se guarda su SHA-256 (un volcado de la base no sirve para suplantar).
  Vence a las 12 h (`SESSION_TTL_HOURS`), se revoca al cerrar sesión, al desactivar al usuario o al cambiar su contraseña.
  Se envía como `Authorization: Bearer`, **sin cookies** (no hay superficie CSRF). El frontend lo guarda en `sessionStorage`
  (se pierde al cerrar la pestaña). Riesgo residual: un XSS podría leerlo; por eso la app no inyecta HTML y se recomienda CSP.
  Alternativa mejor si el API y la app comparten dominio (p. ej. `app.dominio.bo` y `app.dominio.bo/api/*`): cookie `HttpOnly; Secure; SameSite=Strict`.
- **Fuerza bruta**: 5 intentos fallidos por correo en 15 min → 429. (Complementar con una regla de Rate Limiting de Cloudflare por IP.)
- **Autorización en el servidor** (no en la interfaz): `admin` todo; `vendedor` solo su sucursal (ventas, inventario, traspasos
  donde es origen/destino, reportes). Solo admin: cancelar ventas, ingresar stock, crear/editar modelos, gestionar usuarios.
- **CORS** por lista blanca (`ALLOWED_ORIGINS`); cuerpos JSON de máx. 64 KB; validación estricta de todos los campos; errores internos no se exponen.
- **Sin secretos en el repo**: no hay claves en el Worker. Las contraseñas de prueba son aleatorias por ejecución.

## Integridad de datos
- Todo movimiento de stock ocurre en `env.DB.batch([...])` (una transacción). El `CHECK (cantidad >= 0)` de `inventario` hace fallar el lote
  completo si el stock no alcanza, incluso con peticiones simultáneas (probado: 5 ventas simultáneas sobre 1 unidad → 1 éxito).
- Transiciones de traspaso/cancelación de venta con *token de operación*: solo la llamada que gana el cambio de estado mueve stock.
- Idempotencia: `ventas.idempotency_key`, `traspasos.idempotency_key` (índices únicos) y `Idempotency-Key` + tabla `idempotencia` para ingreso de stock.
- `movimientos_inventario` registra cada movimiento. Las anulaciones usan tipo `ajuste` con `referencia_tipo` `venta_cancelada` / `traspaso_cancelado`
  (el CHECK existente de la tabla no admite otros tipos y no se reconstruye).
- El precio real de cada línea se guarda en `detalle_venta.precio_unitario`; `productos.precio_venta` solo es el valor por defecto.

## Pendiente antes de producción (requiere aprobación explícita)
1. Respaldo fresco + bookmark de Time Travel.
2. `wrangler d1 migrations apply DB --remote` (0001-0003).
3. Crear el primer administrador (`create-admin.mjs` imprime SQL con el hash; ejecutarlo en remoto).
4. Importar los datos de Supabase (`local/import-supabase.sql`, generado y reconciliado en local) y volver a reconciliar en remoto.
5. Renombrar el Worker a `fancy-firefly-9028` (o publicar con otro nombre), fijar `ALLOWED_ORIGINS` al dominio real y desplegar.
6. Desplegar el frontend en Pages con `VITE_API_BASE_URL` apuntando al Worker.
