// Pruebas de colores administrables y su asignación por modelo.
// Base D1 LOCAL aislada (Miniflare) en .wrangler/test-colores-state, puerto 8797. No toca la base de desarrollo
// ni Cloudflare. Ejecutar:  npm test   (dentro de /api)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { hashPassword, sqlQuote } from "../scripts/hash.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = ".wrangler/test-colores-state";
const stateAbs = path.join(root, STATE);
const wranglerJs = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;

const pw = { admin: randomBytes(12).toString("base64url"), cb: randomBytes(12).toString("base64url"), sc: randomBytes(12).toString("base64url") };
let server;
const tokens = {};

function wrangler(args) {
  const r = spawnSync(process.execPath, [wranglerJs, ...args], { cwd: root, encoding: "utf8" });
  const confirmed = /"success":\s*true/.test(r.stdout) && !/"success":\s*false/.test(r.stdout);
  if (r.status !== 0 && !confirmed) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} falló:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
function sql(query) {
  const out = wrangler(["d1", "execute", "DB", "--local", "--persist-to", STATE, "--json", "--command", query]);
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}
async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Connection: "close", ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* sin cuerpo */ }
  return { status: res.status, json };
}
const get = (p, token) => api("GET", p, { token });
const post = (p, token, body, headers) => api("POST", p, { token, body, headers });
const must = (r) => { assert.ok(r.status === 200, JSON.stringify(r.json)); return r.json.data; };
async function login(email, password) {
  const r = await post("/api/auth/login", undefined, { email, password });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.json)}`);
  return r.json.data.token;
}
const stock = (suc, p, t, c) =>
  sql(`SELECT COALESCE(SUM(cantidad),0) AS n FROM inventario WHERE sucursal_id=${suc} AND producto_id=${p} AND talla_id=${t} AND color_id=${c}`)[0].n;

before(async () => {
  rmSync(stateAbs, { recursive: true, force: true });
  const r = spawnSync(process.execPath, [path.join(root, "scripts/reset-local-db.mjs")], {
    cwd: root, encoding: "utf8", env: { ...process.env, MISSI_LOCAL_STATE: STATE },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const seed = [
    `INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id) VALUES (${sqlQuote("admin@colores.test")},'Admin Lotes',${sqlQuote(hashPassword(pw.admin))},'admin',NULL);`,
    `INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id) VALUES (${sqlQuote("cb@colores.test")},'Vend CB',${sqlQuote(hashPassword(pw.cb))},'vendedor',1);`,
    `INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id) VALUES (${sqlQuote("sc@colores.test")},'Vend SC',${sqlQuote(hashPassword(pw.sc))},'vendedor',2);`,
    "UPDATE productos SET precio_venta = 135 WHERE id = 1;",
  ].join("\n");
  const dir = mkdtempSync(path.join(tmpdir(), "missi-colores-seed-"));
  const file = path.join(dir, "seed.sql");
  writeFileSync(file, seed);
  wrangler(["d1", "execute", "DB", "--local", "--persist-to", STATE, "--file", file]);
  rmSync(dir, { recursive: true, force: true });

  const logFd = openSync(path.join(tmpdir(), "missi-wrangler-colores.log"), "w");
  server = spawn(process.execPath, [wranglerJs, "dev", "--local", "--port", String(PORT), "--inspector-port", "9236", "--persist-to", STATE], { cwd: root, stdio: ["ignore", logFd, logFd] });
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* aún arrancando */ }
    if (Date.now() - t0 > 90_000) throw new Error("wrangler dev no arrancó");
    await new Promise((res) => setTimeout(res, 500));
  }
  tokens.admin = await login("admin@colores.test", pw.admin);
  tokens.cb = await login("cb@colores.test", pw.cb);
  tokens.sc = await login("sc@colores.test", pw.sc);
});

after(() => {
  if (server?.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  try { rmSync(stateAbs, { recursive: true, force: true }); } catch { /* se limpia en la próxima ejecución */ }
});


const patch = (p, token, body) => api("PATCH", p, { token, body });
const count = (q) => sql(q)[0].n;
const modelo = (nombre) => sql(`SELECT id FROM productos WHERE nombre = '${nombre}'`)[0].id;
const colorId = (nombre) => sql(`SELECT id FROM colores WHERE nombre = '${nombre}'`)[0]?.id;
const asignados = (cid) => sql(`SELECT producto_id FROM producto_colores WHERE color_id = ${cid} ORDER BY producto_id`).map((r) => r.producto_id);
const recibir = (token, p, t, c, n) =>
  post("/api/recepciones", token, { idempotency_key: randomUUID(), sucursal_id: 1, items: [{ producto_id: p, talla_id: t, color_id: c, cantidad: n }] });
const ctx = {};
before(() => {
  ctx.hebilla = modelo("Palazzo con hebilla");
  ctx.sastrero = modelo("Palazzo sastrero");
  ctx.ejecutivo = modelo("Palazzo ejecutivo");
  ctx.M = sql("SELECT id FROM tallas WHERE nombre = 'M'")[0].id;
});

describe("migración: colores existentes conservados y asignados a los modelos existentes", () => {
  it("cada color existente quedó asignado a cada modelo existente (nada se pierde) y los nombres no cambiaron", () => {
    const modelos = count("SELECT COUNT(*) AS n FROM productos"), colores = count("SELECT COUNT(*) AS n FROM colores");
    assert.equal(count("SELECT COUNT(*) AS n FROM producto_colores"), modelos * colores);
    assert.equal(count("SELECT COUNT(*) AS n FROM colores WHERE nombre_norm IS NULL"), 0);
    assert.ok(colorId("Negro") && colorId("Cappuccino"), "los nombres originales siguen igual");
  });
});

describe("administrar colores", () => {
  it("1-2) crea 'Verde oliva' para Palazzo con hebilla; queda guardado en D1 con fecha", async () => {
    const antes = count("SELECT COUNT(*) AS n FROM colores");
    const r = must(await post("/api/colores", tokens.admin, { nombre: "  Verde   oliva ", producto_ids: [ctx.hebilla] }));
    assert.equal(r.nombre, "Verde oliva", "se guarda con espacios normalizados y el nombre elegido");
    assert.deepEqual(r.producto_ids, [ctx.hebilla]);
    assert.equal(count("SELECT COUNT(*) AS n FROM colores"), antes + 1);
    const row = sql(`SELECT nombre, nombre_norm, estado, created_at FROM colores WHERE id = ${r.id}`)[0];
    assert.deepEqual([row.nombre, row.nombre_norm, row.estado], ["Verde oliva", "verde oliva", 1]);
    assert.ok(row.created_at);
    assert.deepEqual(asignados(r.id), [ctx.hebilla]);
    ctx.oliva = r.id;
  });

  it("un color nuevo asignado a VARIOS modelos a la vez queda asignado a todos (sin ids equivocados)", async () => {
    const r = must(await post("/api/colores", tokens.admin, { nombre: "Mostaza", producto_ids: [ctx.hebilla, ctx.sastrero, ctx.ejecutivo] }));
    assert.deepEqual([...asignados(r.id)].sort(), [ctx.hebilla, ctx.sastrero, ctx.ejecutivo].sort());
    assert.equal(count(`SELECT COUNT(*) AS n FROM producto_colores WHERE color_id NOT IN (SELECT id FROM colores) OR producto_id NOT IN (SELECT id FROM productos)`), 0);
  });

  it("3-4) aparece para Palazzo con hebilla y NO para otros modelos; el servidor rechaza stock nuevo en un modelo sin asignar", async () => {
    const lista = must(await get("/api/colores", tokens.cb)).find((c) => c.id === ctx.oliva);
    assert.deepEqual(lista.producto_ids, [ctx.hebilla]);
    assert.equal(lista.en_uso, false);
    must(await recibir(tokens.admin, ctx.hebilla, ctx.M, ctx.oliva, 6));
    const bad = await recibir(tokens.admin, ctx.sastrero, ctx.M, ctx.oliva, 1);
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /no está asignado al modelo «Palazzo sastrero»/);
    const manual = await post("/api/inventario/agregar", tokens.admin, { sucursal_id: 1, producto_id: ctx.sastrero, talla_id: ctx.M, color_id: ctx.oliva, cantidad: 1 }, { "Idempotency-Key": randomUUID() });
    assert.equal(manual.status, 400);
    assert.equal(count(`SELECT COALESCE(SUM(cantidad),0) AS n FROM inventario WHERE producto_id = ${ctx.sastrero} AND color_id = ${ctx.oliva}`), 0);
  });

  it("5) asignar el mismo color a otro modelo no crea un color duplicado; repetir la asignación avisa", async () => {
    const colores = count("SELECT COUNT(*) AS n FROM colores");
    const r = must(await patch(`/api/colores/${ctx.oliva}`, tokens.admin, { asignar: [ctx.sastrero, ctx.ejecutivo] }));
    assert.deepEqual([...r.producto_ids].sort(), [ctx.hebilla, ctx.sastrero, ctx.ejecutivo].sort());
    assert.equal(count("SELECT COUNT(*) AS n FROM colores"), colores, "sigue habiendo un solo registro del color");
    assert.equal(count(`SELECT COUNT(*) AS n FROM producto_colores WHERE color_id = ${ctx.oliva}`), 3);
    const again = await patch(`/api/colores/${ctx.oliva}`, tokens.admin, { asignar: [ctx.sastrero] });
    assert.equal(again.status, 409);
    assert.match(again.json.error, /ya está asignado/);
    must(await recibir(tokens.admin, ctx.sastrero, ctx.M, ctx.oliva, 2));
  });

  it("6) un nombre repetido con otras mayúsculas o espacios se rechaza (también si llegan a la vez)", async () => {
    const colores = count("SELECT COUNT(*) AS n FROM colores");
    for (const nombre of ["VERDE OLIVA", "verde  oliva", " Verde Oliva "]) {
      const r = await post("/api/colores", tokens.admin, { nombre });
      assert.equal(r.status, 409, nombre);
      assert.match(r.json.error, /Ya existe el color «Verde oliva»/);
    }
    assert.equal(count("SELECT COUNT(*) AS n FROM colores"), colores);
    const race = await Promise.all(Array.from({ length: 4 }, () => post("/api/colores", tokens.admin, { nombre: "Terracota" })));
    assert.equal(race.filter((r) => r.status === 200).length, 1, race.map((r) => r.status).join(","));
    assert.ok(race.filter((r) => r.status !== 200).every((r) => r.status === 409));
    assert.equal(count("SELECT COUNT(*) AS n FROM colores WHERE nombre_norm = 'terracota'"), 1);
    assert.equal((await patch(`/api/colores/${ctx.oliva}`, tokens.admin, { nombre: "NEGRO" })).status, 409, "renombrar a uno existente");
  });

  it("validaciones: vacío, símbolos, demasiado largo, modelo inexistente y lista inválida", async () => {
    for (const body of [{ nombre: "" }, { nombre: "   " }, { nombre: "<b>x</b>" }, { nombre: "a".repeat(41) }, { nombre: 5 }, {}, { nombre: "Azul claro 2", producto_ids: [99999] }, { nombre: "Azul claro 3", producto_ids: "x" }]) {
      assert.equal((await post("/api/colores", tokens.admin, body)).status, 400, JSON.stringify(body).slice(0, 50));
    }
    assert.equal(count("SELECT COUNT(*) AS n FROM colores WHERE nombre LIKE 'Azul claro%'"), 0, "una petición inválida no guarda nada");
  });

  it("7) un vendedor no puede crear ni modificar colores por la API; sin sesión tampoco", async () => {
    const colores = count("SELECT COUNT(*) AS n FROM colores");
    assert.equal((await post("/api/colores", tokens.cb, { nombre: "Intruso", producto_ids: [ctx.hebilla] })).status, 403);
    assert.equal((await patch(`/api/colores/${ctx.oliva}`, tokens.cb, { nombre: "Hackeado" })).status, 403);
    assert.equal((await patch(`/api/colores/${ctx.oliva}`, tokens.cb, { quitar: [ctx.hebilla] })).status, 403);
    assert.equal((await patch(`/api/colores/${ctx.oliva}`, tokens.cb, { activo: false })).status, 403);
    assert.equal((await post("/api/colores", undefined, { nombre: "Anónimo" })).status, 401);
    assert.equal(count("SELECT COUNT(*) AS n FROM colores"), colores);
    assert.equal(sql(`SELECT nombre FROM colores WHERE id = ${ctx.oliva}`)[0].nombre, "Verde oliva");
    assert.ok(must(await get("/api/colores?todos=1", tokens.cb)).every((c) => c.estado), "el vendedor no puede pedir los inactivos");
  });

  it("8) editar, quitar asignación y desactivar no rompen stock, ventas ni historial", async () => {
    const venta = must(await post("/api/ventas", tokens.cb, { idempotency_key: randomUUID(), sucursal_id: 1, metodo_pago: "efectivo", modalidad: "entrega_directa", items: [{ producto_id: ctx.hebilla, talla_id: ctx.M, color_id: ctx.oliva, cantidad: 2, precio_unitario: 120 }] }));
    const stock = () => count(`SELECT COALESCE(SUM(cantidad),0) AS n FROM inventario WHERE color_id = ${ctx.oliva}`);
    const snap = () => ({ stock: stock(), detalle: count("SELECT COUNT(*) AS n FROM detalle_venta"), movs: count("SELECT COUNT(*) AS n FROM movimientos_inventario"), lotes: count("SELECT COUNT(*) AS n FROM lotes") });
    const antes = snap();
    const r = must(await patch(`/api/colores/${ctx.oliva}`, tokens.admin, { nombre: "Verde Oliva Oscuro", quitar: [ctx.hebilla], activo: false }));
    assert.equal(r.id, ctx.oliva, "mismo registro");
    assert.equal(r.nombre, "Verde Oliva Oscuro");
    assert.equal(r.estado, false);
    assert.equal(r.en_uso, true);
    assert.deepEqual([...r.producto_ids].sort(), [ctx.sastrero, ctx.ejecutivo].sort());
    assert.deepEqual(snap(), antes, "historial intacto");
    assert.equal(sql(`SELECT color_id FROM detalle_venta WHERE venta_id = ${venta.id}`)[0].color_id, ctx.oliva, "la venta histórica sigue apuntando al mismo color");
    // el stock que ya existía sigue vendiéndose y moviéndose aunque el color esté desactivado
    must(await post("/api/ventas", tokens.cb, { idempotency_key: randomUUID(), sucursal_id: 1, metodo_pago: "QR", modalidad: "entrega_directa", items: [{ producto_id: ctx.hebilla, talla_id: ctx.M, color_id: ctx.oliva, cantidad: 1, precio_unitario: 120 }] }));
    const t = must(await post("/api/traspasos", tokens.admin, { idempotency_key: randomUUID(), origen_id: 1, destino_id: 2, items: [{ producto_id: ctx.hebilla, talla_id: ctx.M, color_id: ctx.oliva, cantidad: 1 }] }));
    must(await post(`/api/traspasos/${t.id}/despachar`, tokens.admin, {}));
    // pero no se ofrece ni se acepta para mercadería nueva
    assert.ok(!must(await get("/api/colores", tokens.cb)).some((c) => c.id === ctx.oliva));
    assert.ok(must(await get("/api/colores?todos=1", tokens.admin)).some((c) => c.id === ctx.oliva && !c.estado));
    assert.equal((await recibir(tokens.admin, ctx.sastrero, ctx.M, ctx.oliva, 1)).status, 400);
    // reactivar y reasignar
    const back = must(await patch(`/api/colores/${ctx.oliva}`, tokens.admin, { activo: true, asignar: [ctx.hebilla] }));
    assert.equal(back.estado, true);
    must(await recibir(tokens.admin, ctx.hebilla, ctx.M, ctx.oliva, 1));
  });

  it("productos nuevos: reciben los colores indicados (o todos los activos si no se indica, como antes)", async () => {
    const negro = colorId("Negro"), blanco = colorId("Blanco");
    const a = must(await post("/api/productos", tokens.admin, { nombre: "Modelo con 2 colores", colores: [negro, blanco] }));
    assert.deepEqual(sql(`SELECT color_id FROM producto_colores WHERE producto_id = ${a.id} ORDER BY color_id`).map((r) => r.color_id), [negro, blanco].sort((x, y) => x - y));
    const b = must(await post("/api/productos", tokens.admin, { nombre: "Modelo con todos" }));
    assert.equal(count(`SELECT COUNT(*) AS n FROM producto_colores WHERE producto_id = ${b.id}`), count("SELECT COUNT(*) AS n FROM colores WHERE estado = 1"));
    const c = must(await post("/api/productos", tokens.admin, { nombre: "Modelo sin colores", colores: [] }));
    assert.equal(count(`SELECT COUNT(*) AS n FROM producto_colores WHERE producto_id = ${c.id}`), 0);
    assert.equal((await post("/api/productos", tokens.admin, { nombre: "Modelo malo", colores: "x" })).status, 400);
  });
});
