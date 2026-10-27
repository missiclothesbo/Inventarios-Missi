// Prueba del cliente de API sin navegador ni red: node scripts/test-api-client.mjs
// (Node 24 ejecuta .ts directamente). Opcional: LIVE=1 para probar contra el Worker real (solo GET).
import { createApiClient, parseBaseUrl, ApiError } from "../src/lib/apiClient.ts";

let ok = 0, bad = 0;
const t = (c, m) => (c ? ok++ : bad++, console.log(c ? "  ok  " : "  FAIL", m));
const json = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
const rejects = async (p, code, m) => { try { await p; t(false, m); } catch (e) { t(e instanceof ApiError && e.code === code, `${m} -> ${e.code}`); } };

console.log("Configuración");
t(parseBaseUrl("").error.includes("Falta"), "vacío rechazado");
t(parseBaseUrl("no-url").error !== "", "URL inválida rechazada");
t(parseBaseUrl("http://evil.com").error !== "", "http fuera de localhost rechazado");
t(parseBaseUrl("http://localhost:8787").url === "http://localhost:8787", "http en localhost permitido");
t(parseBaseUrl("https://u:p@x.workers.dev").error !== "", "credenciales en URL rechazadas");
t(parseBaseUrl("https://x.workers.dev/api").error !== "", "ruta en la base rechazada");
t(parseBaseUrl("https://x.workers.dev/").url === "https://x.workers.dev", "barra final normalizada");

console.log("GET");
const base = "https://x.workers.dev";
let c = createApiClient({ baseUrl: base, fetchImpl: json({ ok: true, service: "MISSI API" }) });
t((await c.get("/api/health")).service === "MISSI API", "health sin data devuelve campos");
c = createApiClient({ baseUrl: base, fetchImpl: json({ ok: true, data: [{ id: 1 }] }) });
t((await c.get("/api/sucursales"))[0].id === 1, "sucursales devuelve data");
let seen;
c = createApiClient({ baseUrl: base, fetchImpl: async (u, i) => (seen = { u, i }, new Response('{"ok":true,"data":[]}')) });
await c.get("/api/sucursales");
t(seen.i.method === "GET" && seen.i.credentials === "omit" && seen.u === base + "/api/sucursales", "solo GET, sin credenciales");
t(!("put" in c) && !("delete" in c), "no expone PUT ni DELETE");

console.log("Escrituras y autenticación");
let tokenNow = null, unauth = 0, seen2;
const c2 = createApiClient({
  baseUrl: base, getToken: () => tokenNow, onUnauthorized: () => { unauth++; },
  fetchImpl: async (u, i) => (seen2 = { u, i }, new Response('{"ok":true,"data":{"id":7}}')),
});
await c2.post("/api/ventas", { a: 1 }, { "Idempotency-Key": "k" });
t(seen2.i.method === "POST" && seen2.i.headers["Content-Type"] === "application/json" && seen2.i.headers["Idempotency-Key"] === "k", "POST con JSON e Idempotency-Key");
t(seen2.i.headers.Authorization === undefined, "sin token no envía Authorization");
tokenNow = "tok-abcdefghijklmnopqrstuvwxyz";
await c2.get("/api/inventario?sucursal_id=1&x=La+Paz");
t(seen2.i.headers.Authorization === "Bearer " + tokenNow, "con token envía Bearer");
t(seen2.i.credentials === "omit", "nunca envía cookies");
await c2.patch("/api/productos/1", { precio_venta: 5 });
t(seen2.i.method === "PATCH", "PATCH");
const c3 = createApiClient({ baseUrl: base, getToken: () => "tok-abcdefghijklmnopqrstuvwxyz", onUnauthorized: () => { unauth++; }, fetchImpl: json({ ok: false, error: "Sesión inválida o vencida." }, 401) });
await rejects(c3.get("/api/auth/me"), "HTTP", "401 -> ApiError con el mensaje del servidor");
t(unauth === 1, "401 autenticado dispara onUnauthorized");
try { await c3.get("/api/auth/me"); } catch (e) { t(e.message === "Sesión inválida o vencida.", "el mensaje es el del servidor, sin prefijos"); }

console.log("Errores");
await rejects(createApiClient({ baseUrl: "", fetchImpl: json({}) }).get("/api/health"), "CONFIG", "sin configurar");
await rejects(c.get("https://evil.com/x"), "CONFIG", "ruta externa bloqueada");
await rejects(c.get("/otra/ruta"), "CONFIG", "ruta fuera de /api bloqueada");
await rejects(createApiClient({ baseUrl: base, fetchImpl: json({ ok: false, error: "Ruta no encontrada" }, 404) }).get("/api/x"), "HTTP", "404 de la API");
await rejects(createApiClient({ baseUrl: base, fetchImpl: async () => new Response("<html>", { status: 200 }) }).get("/api/x"), "RESPUESTA", "respuesta no JSON");
await rejects(createApiClient({ baseUrl: base, fetchImpl: async () => { throw new TypeError("fail"); } }).get("/api/x"), "RED", "fallo de red");
await rejects(createApiClient({ baseUrl: base, timeoutMs: 30, fetchImpl: (u, i) => new Promise((_, rej) => i.signal.addEventListener("abort", () => rej(new Error("abort")))) }).get("/api/x"), "TIMEOUT", "timeout");

if (process.env.LIVE) {
  console.log("Worker real (solo GET)");
  const live = createApiClient({ baseUrl: process.env.LIVE });
  const h = await live.get("/api/health");
  t(h.service === "MISSI API", "GET /api/health -> " + JSON.stringify(h));
  const s = await live.get("/api/sucursales");
  t(Array.isArray(s) && s.length > 0, "GET /api/sucursales -> " + JSON.stringify(s));
}
console.log(`\n${ok} ok, ${bad} fallos`);
process.exit(bad ? 1 : 0);
