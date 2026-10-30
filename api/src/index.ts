import { authenticate, createUser, listUsers, login, logout, requireAdmin, updateUser, type AuthUser } from "./auth";
import { corsHeaders, HttpError, json, notFound, ok, type Env } from "./http";
import * as catalog from "./routes/catalog";
import * as reports from "./routes/reports";
import * as sales from "./routes/sales";
import * as operations from "./routes/operations";
import * as reportesDetalle from "./routes/reportes-detalle";
import * as transfers from "./routes/transfers";
import * as movements from "./routes/movements";
import * as analytics from "./routes/analytics";
import * as national from "./routes/national";
import * as lots from "./routes/lots";
import * as colors from "./routes/colors";

type Handler = (ctx: { request: Request; env: Env; url: URL; user: AuthUser; params: string[] }) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const route = (method: string, path: string, handler: Handler): Route => ({
  method,
  pattern: new RegExp(`^${path.replace(/:id/g, "(\\d{1,9})")}$`),
  handler,
});

const admin = (h: Handler): Handler => async (ctx) => {
  requireAdmin(ctx.user);
  return h(ctx);
};

const routes: Route[] = [
  route("GET", "/api/auth/me", async ({ user }) => ok(user)),

  route("GET", "/api/sucursales", ({ env, user }) => catalog.sucursales(env, user)),
  route("GET", "/api/departamentos", ({ env }) => catalog.departamentos(env)),
  route("GET", "/api/productos", ({ env }) => catalog.productos(env)),
  route("GET", "/api/tallas", ({ env }) => catalog.tallas(env)),
  route("GET", "/api/colores", ({ env, url, user }) => colors.listColors(url, env, user)),
  route("POST", "/api/colores", admin(({ request, env, user }) => colors.createColor(request, env, user))),
  route("PATCH", "/api/colores/:id", admin(({ request, env, user, params }) => colors.updateColor(request, env, user, Number(params[0])))),
  route("POST", "/api/productos", admin(({ request, env, user }) => catalog.createProduct(request, env, user))),
  route("PATCH", "/api/productos/:id", admin(({ request, env, params }) => catalog.updateProductPrice(request, env, Number(params[0])))),
  route("POST", "/api/productos/:id/foto", admin(({ request, env, user, params }) => catalog.uploadPhoto(request, env, user, Number(params[0])))),

  route("GET", "/api/inventario", ({ env, url, user }) => catalog.inventory(url, env, user)),
  route("POST", "/api/inventario/agregar", ({ request, env, user }) => catalog.addStock(request, env, user)),
  route("GET", "/api/inventario/nacional", ({ env, user }) => national.nationalInventory(env, user)),
  route("POST", "/api/inventario/salida", ({ request, env, user }) => catalog.removeStock(request, env, user)),
  route("POST", "/api/inventario/ajuste", ({ request, env, user }) => catalog.adjustStock(request, env, user)),
  route("GET", "/api/movimientos", ({ env, url, user }) => movements.list(url, env, user)),
  route("GET", "/api/recepciones", ({ env, url, user }) => lots.listReceipts(url, env, user)),
  route("POST", "/api/recepciones", admin(({ request, env, user }) => lots.createReceipt(request, env, user))),
  route("GET", "/api/lotes", ({ env, url, user }) => lots.listLots(url, env, user)),
  route("GET", "/api/lotes/:id", ({ env, user, params }) => lots.lotDetail(env, user, Number(params[0]))),
  route("GET", "/api/dashboard", ({ env, url, user }) => catalog.dashboard(url, env, user)),

  route("GET", "/api/ventas", ({ env, url, user }) => sales.listSales(url, env, user)),
  route("POST", "/api/ventas", ({ request, env, user }) => sales.createSale(request, env, user)),
  route("GET", "/api/ventas/:id/detalle", ({ env, user, params }) => sales.saleDetails(env, user, Number(params[0]))),
  route("POST", "/api/ventas/:id/cancelar", ({ request, env, user, params }) => operations.anularVenta(request, env, user, Number(params[0]))),
  route("GET", "/api/ventas/historial", ({ env, url, user }) => sales.salesHistory(url, env, user)),
  route("GET", "/api/ventas/buscar", ({ env, url, user }) => operations.searchSales(url, env, user)),
  route("GET", "/api/ventas/:id/detalle-completo", ({ env, user, params }) => operations.saleDetail(env, user, Number(params[0]))),
  route("GET", "/api/operaciones/historial", ({ env, url, user }) => operations.history(url, env, user)),
  route("GET", "/api/operaciones", ({ env, url, user }) => operations.listOperations(url, env, user)),
  route("POST", "/api/operaciones/devolucion", ({ request, env, user }) => operations.devolucion(request, env, user)),
  route("POST", "/api/operaciones/cambio", ({ request, env, user }) => operations.cambio(request, env, user)),

  route("GET", "/api/traspasos", ({ env, user }) => transfers.listTransfers(env, user)),
  route("GET", "/api/traspasos/historial", ({ env, url, user }) => transfers.history(url, env, user)),
  route("GET", "/api/traspasos/:id", ({ env, user, params }) => transfers.detail(env, user, Number(params[0]))),
  route("GET", "/api/traspasos/items", ({ env, user }) => transfers.listTransferItems(env, user)),
  route("POST", "/api/traspasos", ({ request, env, user }) => transfers.createTransfer(request, env, user)),
  route("POST", "/api/traspasos/:id/despachar", ({ env, user, params }) => transfers.transition(env, user, Number(params[0]), "despachar")),
  route("POST", "/api/traspasos/:id/recibir", ({ env, user, params }) => transfers.transition(env, user, Number(params[0]), "recibir")),
  route("POST", "/api/traspasos/:id/cancelar", ({ env, user, params }) => transfers.transition(env, user, Number(params[0]), "cancelar")),

  route("GET", "/api/reportes/balance", ({ env, url, user }) => reports.balance(url, env, user)),
  route("GET", "/api/reportes/modelos", ({ env, url, user }) => analytics.modelos(url, env, user)),
  route("GET", "/api/reportes/envios", ({ env, url, user }) => analytics.envios(url, env, user)),
  route("GET", "/api/reportes/resumen", ({ env, url, user }) => analytics.resumen(url, env, user)),
  route("GET", "/api/reportes/movimientos", ({ env, url, user }) => reportesDetalle.movimientos(url, env, user)),
  route("GET", "/api/reportes/stock", ({ env, url, user }) => reportesDetalle.stock(url, env, user)),

  route("GET", "/api/usuarios", admin(({ env, user }) => listUsers(env, user))),
  route("POST", "/api/usuarios", admin(({ request, env, user }) => createUser(request, env, user))),
  route("PATCH", "/api/usuarios/:id", admin(({ request, env, user, params }) => updateUser(request, env, user, Number(params[0])))),
];

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/api/health" && request.method === "GET") {
    return json({ ok: true, service: "MISSI API" }, 200);
  }

  // Foto de producto: lectura pública (las etiquetas img no envían sesión). No expone nada sensible.
  const photo = /^\/api\/productos\/(\d{1,9})\/foto$/.exec(path);
  if (photo && request.method === "GET") return catalog.getPhoto(env, Number(photo[1]));

  if (path === "/api/auth/login" && request.method === "POST") return login(request, env);
  if (path === "/api/auth/logout" && request.method === "POST") return logout(request, env);

  const matches = routes.filter((r) => r.pattern.test(path));
  if (matches.length === 0) throw notFound("Ruta no encontrada");

  const found = matches.find((r) => r.method === request.method);
  if (!found) throw new HttpError(405, "Método no permitido");

  // Todo lo demás exige sesión válida.
  const user = await authenticate(request, env);
  const params = found.pattern.exec(path)!.slice(1);
  return found.handler({ request, env, url, user, params });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    let response: Response;
    try {
      response = await handle(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        response = json({ ok: false, error: err.message }, err.status);
      } else {
        // Detalle solo en el log del Worker; el cliente no recibe mensajes internos.
        console.error("Error no controlado:", err instanceof Error ? err.message : err);
        response = json({ ok: false, error: "Error interno del servidor." }, 500);
      }
    }

    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
