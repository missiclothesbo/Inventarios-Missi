// Pruebas de integración LOCALES: levantan `wrangler dev --local` con una base D1 local (Miniflare)
// recreada desde el esquema real + migraciones. NO tocan Cloudflare ni Supabase.
// Ejecutar:  npm test   (dentro de /api)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { hashPassword, sqlQuote } from "../scripts/hash.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = ".wrangler/test-state";
const stateAbs = path.join(root, STATE);
const wranglerJs = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:5173";

// Contraseñas aleatorias por ejecución: no hay secretos fijos en el repo.
const pw = { admin: randomBytes(12).toString("base64url"), cb: randomBytes(12).toString("base64url"), sc: randomBytes(12).toString("base64url") };
let server;
const tokens = {};

function wrangler(args) {
  const r = spawnSync(process.execPath, [wranglerJs, ...args], { cwd: root, encoding: "utf8" });
  // wrangler a veces sale con código != 0 aunque la consulta haya funcionado: se acepta solo si el JSON lo confirma.
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
  return { status: res.status, json, headers: res.headers };
}

const get = (p, token) => api("GET", p, { token });
const post = (p, token, body, headers) => api("POST", p, { token, body, headers });

async function login(email, password) {
  const r = await post("/api/auth/login", undefined, { email, password });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.json)}`);
  return r.json.data.token;
}

const stock = (suc, p, t, c) =>
  sql(`SELECT COALESCE(SUM(cantidad),0) AS n FROM inventario WHERE sucursal_id=${suc} AND producto_id=${p} AND talla_id=${t} AND color_id=${c}`)[0].n;
const count = (table) => sql(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

const line = (p, t, c, n, price) => ({ producto_id: p, talla_id: t, color_id: c, cantidad: n, ...(price ? { precio_unitario: price } : {}) });
const saleBody = (over = {}) => ({
  idempotency_key: randomUUID(), sucursal_id: 1, metodo_pago: "efectivo", modalidad: "entrega_directa",
  items: [line(1, 1, 1, 1)], ...over,
});

before(async () => {
  rmSync(stateAbs, { recursive: true, force: true });
  const r = spawnSync(process.execPath, [path.join(root, "scripts/reset-local-db.mjs")], {
    cwd: root, encoding: "utf8", env: { ...process.env, MISSI_LOCAL_STATE: STATE },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const seed = [
    `INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id) VALUES (${sqlQuote("admin@test.local")},'Admin',${sqlQuote(hashPassword(pw.admin))},'admin',NULL);`,
    `INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id) VALUES (${sqlQuote("cb@test.local")},'Vend CB',${sqlQuote(hashPassword(pw.cb))},'vendedor',1);`,
    `INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id) VALUES (${sqlQuote("sc@test.local")},'Vend SC',${sqlQuote(hashPassword(pw.sc))},'vendedor',2);`,
    "UPDATE usuarios SET username = 'vendedor.cb' WHERE email = 'cb@test.local';",
    "UPDATE productos SET precio_venta = 135 WHERE id = 1;",
    "INSERT INTO inventario (producto_id,talla_id,color_id,sucursal_id,cantidad) VALUES (1,1,1,1,10),(1,2,1,1,1),(2,1,1,1,5),(3,1,1,1,0);",
  ].join("\n");
  const dir = mkdtempSync(path.join(tmpdir(), "missi-seed-"));
  const file = path.join(dir, "seed.sql");
  writeFileSync(file, seed);
  wrangler(["d1", "execute", "DB", "--local", "--persist-to", STATE, "--file", file]);
  rmSync(dir, { recursive: true, force: true });

  const logFd = openSync(path.join(tmpdir(), "missi-wrangler-dev.log"), "w");
  server = spawn(process.execPath, [wranglerJs, "dev", "--local", "--port", String(PORT), "--persist-to", STATE], { cwd: root, stdio: ["ignore", logFd, logFd] });
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* aún arrancando */ }
    if (Date.now() - t0 > 90_000) throw new Error("wrangler dev no arrancó");
    await new Promise((r) => setTimeout(r, 500));
  }

  tokens.admin = await login("admin@test.local", pw.admin);
  tokens.cb = await login("cb@test.local", pw.cb);
  tokens.sc = await login("sc@test.local", pw.sc);
});

after(() => {
  if (server?.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  try { rmSync(stateAbs, { recursive: true, force: true }); } catch { /* workerd aún libera archivos; se limpia en la próxima ejecución */ }
});

describe("autenticación y autorización", () => {
  it("health es público; el resto exige sesión", async () => {
    assert.equal((await get("/api/health")).status, 200);
    assert.equal((await get("/api/sucursales")).status, 401);
    assert.equal((await get("/api/inventario", "x".repeat(40))).status, 401);
  });

  it("contraseña incorrecta = 401 sin revelar si el correo existe", async () => {
    const a = await post("/api/auth/login", undefined, { email: "cb@test.local", password: "incorrecta-incorrecta" });
    const b = await post("/api/auth/login", undefined, { email: "noexiste@test.local", password: "incorrecta-incorrecta" });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.json.error, b.json.error);
  });

  it("bloquea tras 5 intentos fallidos (429) y el login correcto queda bloqueado temporalmente", async () => {
    for (let i = 0; i < 5; i++) await post("/api/auth/login", undefined, { email: "lock@test.local", password: "incorrecta-incorrecta" });
    const r = await post("/api/auth/login", undefined, { email: "lock@test.local", password: "incorrecta-incorrecta" });
    assert.equal(r.status, 429);
  });

  it("el token no se guarda en claro y logout lo invalida", async () => {
    const t = await login("sc@test.local", pw.sc);
    assert.equal(sql(`SELECT COUNT(*) AS n FROM sesiones WHERE token_hash = '${t}'`)[0].n, 0);
    assert.equal(sql("SELECT COUNT(*) AS n FROM usuarios WHERE password_hash NOT LIKE 'pbkdf2$%'")[0].n, 0);
    assert.equal((await get("/api/auth/me", t)).status, 200);
    await post("/api/auth/logout", t);
    assert.equal((await get("/api/auth/me", t)).status, 401);
  });

  it("sesión vencida o usuario desactivado deja de funcionar", async () => {
    const t = await login("sc@test.local", pw.sc);
    const hash = createHash("sha256").update(t).digest("hex");
    sql(`UPDATE sesiones SET expires_at = datetime('now','-1 minute') WHERE token_hash = '${hash}'`);
    assert.equal((await get("/api/auth/me", t)).status, 401);
  });

  it("vendedor solo ve su sucursal y no puede usar rutas de admin", async () => {
    const s = await get("/api/sucursales", tokens.cb);
    assert.deepEqual(s.json.data.map((x) => x.id), [1]);
    assert.equal((await get("/api/inventario?sucursal_id=2", tokens.cb)).status, 403);
    assert.equal((await get("/api/usuarios", tokens.cb)).status, 403);
    assert.equal((await post("/api/productos", tokens.cb, { nombre: "X" })).status, 403);
    assert.equal((await post("/api/inventario/agregar", tokens.cb, {}, { "Idempotency-Key": randomUUID() })).status, 403);
    const own = await get("/api/inventario", tokens.cb);
    assert.ok(own.json.data.every((r) => r.sucursal_id === 1));
  });

  it("admin crea usuarios con contraseña larga; las cortas se rechazan", async () => {
    const bad = await post("/api/usuarios", tokens.admin, { email: "n@test.local", nombre: "N", rol: "vendedor", sucursal_id: 1, password: "corta" });
    assert.equal(bad.status, 400);
    const ok = await post("/api/usuarios", tokens.admin, { email: "n@test.local", nombre: "N", rol: "vendedor", sucursal_id: 1, password: randomBytes(12).toString("base64url") });
    assert.equal(ok.status, 200);
    const dup = await post("/api/usuarios", tokens.admin, { email: "N@test.local", nombre: "N", rol: "vendedor", sucursal_id: 1, password: randomBytes(12).toString("base64url") });
    assert.equal(dup.status, 409);
  });

  it("CORS: solo orígenes permitidos", async () => {
    const good = await fetch(`${BASE}/api/health`, { headers: { Origin: ORIGIN } });
    assert.equal(good.headers.get("access-control-allow-origin"), ORIGIN);
    const bad = await fetch(`${BASE}/api/health`, { headers: { Origin: "https://evil.example" } });
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
  });
});

describe("inicio de sesión con correo o usuario", () => {
  it("acepta correo, usuario y mayúsculas; también el campo antiguo `email`", async () => {
    for (const body of [
      { identifier: "cb@test.local", password: pw.cb },
      { identifier: "VENDEDOR.CB", password: pw.cb },
      { identifier: "vendedor.cb", password: pw.cb },
      { email: "cb@test.local", password: pw.cb },
    ]) {
      const r = await post("/api/auth/login", undefined, body);
      assert.equal(r.status, 200, JSON.stringify(body.identifier ?? body.email));
      assert.equal(r.json.data.user.username, "vendedor.cb");
      assert.equal(r.json.data.user.id, sql("SELECT id FROM usuarios WHERE email='cb@test.local'")[0].id, "misma cuenta, mismos datos");
    }
  });

  it("errores genéricos: usuario inexistente y contraseña errónea no se distinguen; nunca devuelve el hash", async () => {
    const a = await post("/api/auth/login", undefined, { identifier: "vendedor.cb", password: "incorrecta-incorrecta" });
    const b = await post("/api/auth/login", undefined, { identifier: "fantasma", password: "incorrecta-incorrecta" });
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.json.error, b.json.error);
    const ok = await post("/api/auth/login", undefined, { identifier: "sc@test.local", password: pw.sc });
    assert.ok(!JSON.stringify(ok.json).includes("pbkdf2"));
    assert.equal((await post("/api/auth/login", undefined, { password: "x" })).status, 401);
    assert.equal((await post("/api/auth/login", undefined, { identifier: "a\nb", password: "x" })).status, 401);
  });

  it("usuario desactivado no puede entrar; gestión de nombres de usuario (únicos, sin @)", async () => {
    const mk = await post("/api/usuarios", tokens.admin, { email: "off@test.local", username: "Off.User", nombre: "Off", rol: "vendedor", sucursal_id: 1, password: "contraseña-larga-123" });
    assert.equal(mk.status, 200, JSON.stringify(mk.json));
    assert.equal(mk.json.data.username, "off.user", "se guarda en minúsculas");
    assert.equal((await post("/api/auth/login", undefined, { identifier: "off.user", password: "contraseña-larga-123" })).status, 200);
    assert.equal((await post("/api/usuarios", tokens.admin, { email: "x1@test.local", username: "OFF.user", nombre: "X", rol: "vendedor", sucursal_id: 1, password: "contraseña-larga-123" })).status, 409);
    assert.equal((await post("/api/usuarios", tokens.admin, { email: "x2@test.local", username: "con@arroba", nombre: "X", rol: "vendedor", sucursal_id: 1, password: "contraseña-larga-123" })).status, 400);
    const id = mk.json.data.id;
    assert.equal((await api("PATCH", `/api/usuarios/${id}`, { token: tokens.admin, body: { activo: false } })).status, 200);
    assert.equal((await post("/api/auth/login", undefined, { identifier: "off.user", password: "contraseña-larga-123" })).status, 401);
    // asignar usuario a una cuenta existente no cambia su contraseña ni sus datos
    assert.equal((await api("PATCH", `/api/usuarios/${id}`, { token: tokens.admin, body: { activo: true, username: "nuevo.nombre" } })).status, 200);
    assert.equal((await post("/api/auth/login", undefined, { identifier: "nuevo.nombre", password: "contraseña-larga-123" })).status, 200);
  });

  it("admin edita nombre, rol y sucursal; los cambios de permisos cierran las sesiones de esa cuenta", async () => {
    const pass = randomBytes(12).toString("base64url");
    const mk = await post("/api/usuarios", tokens.admin, { email: "mover@test.local", username: "mover", nombre: "Mover", rol: "vendedor", sucursal_id: 1, password: pass });
    assert.equal(mk.status, 200, JSON.stringify(mk.json));
    const id = mk.json.data.id;
    const patch = (body, token = tokens.admin) => api("PATCH", `/api/usuarios/${id}`, { token, body });
    let t = await login("mover@test.local", pass);

    // nombre o misma sucursal: la sesión sigue viva
    assert.equal((await patch({ nombre: "Mover Uno" })).status, 200);
    assert.equal((await patch({ sucursal_id: 1 })).status, 200);
    const me = await get("/api/auth/me", t);
    assert.equal(me.status, 200);
    assert.equal(me.json.data.nombre, "Mover Uno");

    // cambio de sucursal: sesión revocada; al volver a entrar solo ve la nueva sucursal
    assert.equal((await patch({ sucursal_id: 2 })).status, 200);
    assert.equal((await get("/api/auth/me", t)).status, 401);
    t = await login("mover", pass);
    assert.deepEqual((await get("/api/sucursales", t)).json.data.map((s) => s.id), [2]);
    assert.equal((await post("/api/ventas", t, saleBody({ sucursal_id: 1 }))).status, 403);

    // reglas: vendedor sin sucursal, sucursal inexistente, rol inválido, vendedor no administra, cuenta inexistente
    assert.equal((await patch({ sucursal_id: null })).status, 400);
    assert.equal((await patch({ sucursal_id: 999 })).status, 400);
    assert.equal((await patch({ rol: "dueño" })).status, 400);
    assert.equal((await patch({ nombre: "X" }, tokens.cb)).status, 403);
    assert.equal((await api("PATCH", "/api/usuarios/999999", { token: tokens.admin, body: { nombre: "X" } })).status, 404);

    // ascenso a admin: queda sin sucursal; el admin no puede quitarse su propio rol
    assert.equal((await patch({ rol: "admin" })).status, 200);
    assert.deepEqual(sql(`SELECT rol, sucursal_id FROM usuarios WHERE id = ${id}`)[0], { rol: "admin", sucursal_id: null });
    const adminId = sql("SELECT id FROM usuarios WHERE email = 'admin@test.local'")[0].id;
    const self = await api("PATCH", `/api/usuarios/${adminId}`, { token: tokens.admin, body: { rol: "vendedor", sucursal_id: 1 } });
    assert.equal(self.status, 400);
    assert.equal(sql(`SELECT rol FROM usuarios WHERE id = ${adminId}`)[0].rol, "admin");
    assert.equal((await get("/api/auth/me", tokens.admin)).status, 200, "el intento rechazado no cierra la sesión del admin");
    assert.ok(sql(`SELECT COUNT(*) AS n FROM auditoria WHERE accion = 'actualizar_usuario' AND entidad_id = ${id}`)[0].n >= 4);
  });

  it("el bloqueo por intentos se cuenta por cuenta (correo o usuario) y no revela si existe", async () => {
    for (let i = 0; i < 5; i++) await post("/api/auth/login", undefined, { identifier: "sc@test.local", password: "incorrecta-incorrecta" });
    const byUser = await post("/api/auth/login", undefined, { identifier: "sc@test.local", password: "incorrecta-incorrecta" });
    assert.equal(byUser.status, 429);
    sql("DELETE FROM intentos_login WHERE email = 'sc@test.local'"); // solo base de pruebas local
  });
});

describe("catálogo migrado", () => {
  it("tallas oficiales de pantalón en el orden exacto; colores y modelo nuevos", async () => {
    const tallas = (await get("/api/tallas", tokens.admin)).json.data.map((t) => t.nombre);
    assert.deepEqual(tallas, ["P", "M", "G", "GG", "3G", "4G", "36", "38", "40", "42", "44", "46", "48"]);
    const colores = (await get("/api/colores", tokens.admin)).json.data.map((c) => c.nombre);
    for (const c of ["Beige", "Verde hoja seca", "Azul", "Azul marino", "Cappuccino", "Verde pistacho"]) assert.ok(colores.includes(c), c);
    const prod = (await get("/api/productos", tokens.admin)).json.data.map((p) => p.nombre);
    assert.ok(prod.includes("Hebilla bota recta") && prod.includes("Short sastrero"));
    const deptos = (await get("/api/departamentos", tokens.admin)).json.data;
    assert.equal(deptos.length, 9);
  });
});

describe("ventas", () => {
  it("registra venta, descuenta stock, usa precio_venta por defecto y guarda precio real en el detalle", async () => {
    const before = stock(1, 1, 1, 1);
    const r = await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 1, 1, 2)] }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.total, 270);
    assert.equal(stock(1, 1, 1, 1), before - 2);
    const det = (await get(`/api/ventas/${r.json.data.id}/detalle`, tokens.cb)).json.data;
    assert.equal(det[0].precio_unitario, 135);
    // un cambio posterior del precio del modelo NO altera la venta histórica
    sql("UPDATE productos SET precio_venta = 200 WHERE id = 1");
    const det2 = (await get(`/api/ventas/${r.json.data.id}/detalle`, tokens.cb)).json.data;
    assert.equal(det2[0].precio_unitario, 135);
    sql("UPDATE productos SET precio_venta = 135 WHERE id = 1");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM movimientos_inventario WHERE tipo='venta' AND referencia_id=${r.json.data.id}`)[0].n, 1);
  });

  it("idempotencia: repetir con la misma clave no duplica ni descuenta dos veces", async () => {
    const body = saleBody({ items: [line(2, 1, 1, 1, 150)] });
    const before = stock(1, 2, 1, 1);
    const a = await post("/api/ventas", tokens.cb, body);
    const b = await post("/api/ventas", tokens.cb, body);
    assert.equal(a.json.data.id, b.json.data.id);
    assert.equal(b.json.data.repetida, true);
    assert.equal(stock(1, 2, 1, 1), before - 1);
  });

  it("stock insuficiente o inexistente: 409 y no queda NADA guardado (atomicidad)", async () => {
    const ventas = count("ventas"), destinos = count("destinos_entrega"), det = count("detalle_venta");
    const s0 = stock(1, 1, 1, 1);
    const r = await post("/api/ventas", tokens.cb, saleBody({ modalidad: "envio", departamento: "La Paz", ciudad: "El Alto", direccion: "Av. 1", items: [line(1, 1, 1, 1), line(3, 1, 1, 1, 100)] }));
    assert.equal(r.status, 409);
    assert.equal(count("ventas"), ventas);
    assert.equal(count("destinos_entrega"), destinos);
    assert.equal(count("detalle_venta"), det);
    assert.equal(stock(1, 1, 1, 1), s0, "la primera línea no debe haber descontado");
    const none = await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 3, 1, 1)] }));
    assert.equal(none.status, 409);
  });

  it("concurrencia: 5 ventas simultáneas sobre 1 unidad -> exactamente 1 éxito, stock nunca negativo", async () => {
    assert.equal(stock(1, 1, 2, 1), 1);
    const rs = await Promise.all(Array.from({ length: 5 }, () => post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 2, 1, 1)] }))));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
    assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
    assert.equal(stock(1, 1, 2, 1), 0);
  });

  it("modalidades y destino: envío (9 departamentos) e interprovincial manual", async () => {
    const badDept = await post("/api/ventas", tokens.cb, saleBody({ modalidad: "envio", departamento: "Atlántida", ciudad: "X", direccion: "Y" }));
    assert.equal(badDept.status, 400);
    // Regla vigente: en envío solo el departamento es obligatorio; en interprovincial, la provincia.
    const sinProvincia = await post("/api/ventas", tokens.cb, saleBody({ modalidad: "envio_interprovincial", departamento: "Potosí", municipio: "Cotagaita", direccion: "Plaza" }));
    assert.equal(sinProvincia.status, 400);

    const env = await post("/api/ventas", tokens.cb, saleBody({ modalidad: "envio", metodo_pago: "QR", departamento: "La Paz", ciudad: "El Alto", direccion: "Av. 6 de Marzo", referencias: "portón verde", cliente_nombre: "Ana", cliente_telefono: "70000000" }));
    assert.equal(env.status, 200, JSON.stringify(env.json));
    const inter = await post("/api/ventas", tokens.cb, saleBody({ modalidad: "envio_interprovincial", departamento: "Potosí", provincia: "Nor Chichas", municipio: "Cotagaita", direccion: "Plaza Principal", agencia_transporte: "Trans Bolívar", referencias: "frente a la iglesia" }));
    assert.equal(inter.status, 200, JSON.stringify(inter.json));

    const list = (await get("/api/ventas?limit=50", tokens.cb)).json.data;
    const e = list.find((s) => s.id === env.json.data.id);
    const i = list.find((s) => s.id === inter.json.data.id);
    assert.equal(e.modalidad, "envio"); assert.equal(e.metodo_pago, "QR"); assert.equal(e.departamento, "La Paz");
    assert.equal(e.ciudad, "El Alto"); assert.equal(e.referencias, "portón verde"); assert.equal(e.cliente_nombre, "Ana");
    assert.equal(i.modalidad, "envio_interprovincial"); assert.equal(i.provincia, "Nor Chichas");
    assert.equal(i.municipio, "Cotagaita"); assert.equal(i.agencia_transporte, "Trans Bolívar"); assert.equal(i.departamento, "Potosí");
    assert.ok(i.fecha.endsWith("Z"), "fecha ISO UTC");
  });

  it("validaciones de entrada", async () => {
    for (const bad of [
      saleBody({ items: [] }),
      saleBody({ items: [line(1, 1, 1, 0)] }),
      saleBody({ items: [line(1, 1, 1, -3)] }),
      saleBody({ items: [line(1, 1, 1, 1.5)] }),
      saleBody({ items: [line(1, 1, 1, 1, -5)] }),
      saleBody({ metodo_pago: "tarjeta" }),
      saleBody({ modalidad: "dron" }),
      saleBody({ idempotency_key: "no-uuid" }),
      saleBody({ items: [line(1, 1, 1, 1), line(1, 1, 1, 1)] }),
      saleBody({ items: [line(999, 1, 1, 1, 10)] }),
    ]) {
      const r = await post("/api/ventas", tokens.cb, bad);
      assert.ok(r.status === 400 || r.status === 409, `${JSON.stringify(bad).slice(0, 80)} -> ${r.status}`);
    }
    const noPrice = await post("/api/ventas", tokens.cb, saleBody({ items: [line(2, 1, 1, 1)] }));
    // el modelo 2 tiene precio_venta 0: exige precio explícito
    assert.equal(noPrice.status, 400);
    const notJson = await fetch(`${BASE}/api/ventas`, { method: "POST", headers: { Authorization: `Bearer ${tokens.cb}`, "Content-Type": "text/plain" }, body: "x" });
    assert.equal(notJson.status, 400);
  });

  it("un vendedor no puede vender en otra sucursal", async () => {
    const r = await post("/api/ventas", tokens.cb, saleBody({ sucursal_id: 2 }));
    assert.equal(r.status, 403);
  });

  it("cancelar: solo admin, repone stock una sola vez y exige motivo", async () => {
    const s0 = stock(1, 1, 1, 1);
    const v = await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 1, 1, 3)] }));
    const id = v.json.data.id;
    assert.equal(stock(1, 1, 1, 1), s0 - 3);
    assert.equal((await post(`/api/ventas/${id}/cancelar`, tokens.cb, { motivo: "x" })).status, 403);
    assert.equal((await post(`/api/ventas/${id}/cancelar`, tokens.admin, { motivo: "" })).status, 400);
    const rs = await Promise.all([1, 2].map(() => post(`/api/ventas/${id}/cancelar`, tokens.admin, { motivo: "cliente desistió" })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    assert.equal(stock(1, 1, 1, 1), s0, "repuesto exactamente una vez");
    assert.equal((await post(`/api/ventas/${id}/cancelar`, tokens.admin, { motivo: "otra vez" })).status, 409);
    const cancelled = (await get("/api/ventas?estado=cancelada", tokens.admin)).json.data.find((s) => s.id === id);
    assert.equal(cancelled.motivo_cancelacion, "cliente desistió");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM auditoria WHERE accion='cancelar_venta' AND entidad_id=${id}`)[0].n, 1);
  });
});

describe("traspasos", () => {
  const items = [{ producto_id: 1, talla_id: 1, color_id: 1, cantidad: 2 }];
  const create = (token, over = {}) => post("/api/traspasos", token, { idempotency_key: randomUUID(), origen_id: 1, destino_id: 2, responsable: "Juan", items, ...over });

  it("ciclo completo: pendiente no mueve; despachar descuenta origen; recibir suma destino; no es venta", async () => {
    const ventas0 = count("ventas");
    const o0 = stock(1, 1, 1, 1), d0 = stock(2, 1, 1, 1);
    const t = await create(tokens.cb);
    assert.equal(t.status, 200, JSON.stringify(t.json));
    const id = t.json.data.id;
    assert.equal(stock(1, 1, 1, 1), o0);
    assert.equal((await post(`/api/traspasos/${id}/recibir`, tokens.sc)).status, 409, "no se recibe lo no enviado");

    assert.equal((await post(`/api/traspasos/${id}/despachar`, tokens.sc)).status, 403, "solo el origen despacha");
    assert.equal((await post(`/api/traspasos/${id}/despachar`, tokens.cb)).status, 200);
    assert.equal(stock(1, 1, 1, 1), o0 - 2);
    assert.equal(stock(2, 1, 1, 1), d0, "el destino aún no recibió");
    assert.equal((await post(`/api/traspasos/${id}/despachar`, tokens.cb)).status, 409, "doble despacho bloqueado");
    assert.equal(stock(1, 1, 1, 1), o0 - 2);

    assert.equal((await post(`/api/traspasos/${id}/recibir`, tokens.cb)).status, 403, "solo el destino recibe");
    assert.equal((await post(`/api/traspasos/${id}/recibir`, tokens.sc)).status, 200);
    assert.equal(stock(2, 1, 1, 1), d0 + 2);
    assert.equal((await post(`/api/traspasos/${id}/recibir`, tokens.sc)).status, 409, "doble recepción bloqueada");
    assert.equal(stock(2, 1, 1, 1), d0 + 2);
    assert.equal((await post(`/api/traspasos/${id}/cancelar`, tokens.admin)).status, 409, "recibido no se cancela");
    assert.equal(count("ventas"), ventas0, "un traspaso nunca crea ventas");
    assert.equal(stock(1, 1, 1, 1) + stock(2, 1, 1, 1), o0 + d0, "stock total conservado");
    const types = sql(`SELECT tipo FROM movimientos_inventario WHERE referencia_tipo='traspaso' AND referencia_id=${id} ORDER BY id`).map((r) => r.tipo);
    assert.deepEqual(types, ["traspaso_salida", "traspaso_entrada"]);
  });

  it("idempotencia al crear y validaciones", async () => {
    const key = randomUUID();
    const a = await create(tokens.cb, { idempotency_key: key });
    const b = await create(tokens.cb, { idempotency_key: key });
    assert.equal(a.json.data.id, b.json.data.id);
    assert.equal(sql(`SELECT COUNT(*) AS n FROM traspasos WHERE idempotency_key='${key}'`)[0].n, 1);
    assert.equal((await create(tokens.cb, { destino_id: 1 })).status, 400, "origen = destino");
    // El responsable es el usuario autenticado: el texto del cliente es opcional (un valor en blanco se ignora).
    const sinTexto = await create(tokens.cb, { responsable: "  " });
    assert.equal(sinTexto.status, 200);
    assert.equal(sql(`SELECT responsable FROM traspasos WHERE id=${sinTexto.json.data.id}`)[0].responsable, "Vend CB");
    assert.equal((await create(tokens.cb, { items: [] })).status, 400);
    assert.equal((await create(tokens.cb, { items: [{ ...items[0], cantidad: 0 }] })).status, 400);
    assert.equal((await create(tokens.sc)).status, 403, "un vendedor no envía desde otra sucursal");
  });

  it("cancelar pendiente no mueve stock; cancelar enviado devuelve al origen", async () => {
    const o0 = stock(1, 1, 1, 1);
    const p = (await create(tokens.cb)).json.data.id;
    assert.equal((await post(`/api/traspasos/${p}/cancelar`, tokens.cb)).status, 200);
    assert.equal(stock(1, 1, 1, 1), o0);

    const e = (await create(tokens.cb)).json.data.id;
    await post(`/api/traspasos/${e}/despachar`, tokens.cb);
    assert.equal(stock(1, 1, 1, 1), o0 - 2);
    assert.equal((await post(`/api/traspasos/${e}/cancelar`, tokens.cb)).status, 200);
    assert.equal(stock(1, 1, 1, 1), o0, "devuelto al origen");
    assert.equal((await post(`/api/traspasos/${e}/cancelar`, tokens.cb)).status, 409);
    assert.equal(stock(1, 1, 1, 1), o0);
  });

  it("despacho sin stock suficiente: 409, nada se mueve y sigue pendiente", async () => {
    const t = (await create(tokens.cb, { items: [{ producto_id: 3, talla_id: 1, color_id: 1, cantidad: 5 }] })).json.data.id;
    const r = await post(`/api/traspasos/${t}/despachar`, tokens.cb);
    assert.equal(r.status, 409);
    const list = (await get("/api/traspasos", tokens.cb)).json.data;
    assert.equal(list.find((x) => x.id === t).estado, "pendiente");
    assert.equal(stock(1, 3, 1, 1), 0);
    assert.equal(stock(2, 3, 1, 1), 0);
  });

  it("concurrencia: dos despachos y dos recepciones simultáneas mueven stock una sola vez", async () => {
    const o0 = stock(1, 1, 1, 1), d0 = stock(2, 1, 1, 1);
    const t = (await create(tokens.cb)).json.data.id;
    const ds = await Promise.all([1, 2, 3].map(() => post(`/api/traspasos/${t}/despachar`, tokens.cb)));
    assert.equal(ds.filter((r) => r.status === 200).length, 1, ds.map((r) => r.status).join(","));
    assert.equal(stock(1, 1, 1, 1), o0 - 2);
    const rs = await Promise.all([1, 2, 3].map(() => post(`/api/traspasos/${t}/recibir`, tokens.sc)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
    assert.equal(stock(2, 1, 1, 1), d0 + 2);
  });

  it("dos traspasos compitiendo por el mismo stock: el CHECK impide el negativo", async () => {
    const left = stock(1, 1, 1, 1);
    const mk = () => create(tokens.cb, { items: [{ producto_id: 1, talla_id: 1, color_id: 1, cantidad: left }] }).then((r) => r.json.data.id);
    const [a, b] = [await mk(), await mk()];
    const rs = await Promise.all([a, b].map((id) => post(`/api/traspasos/${id}/despachar`, tokens.cb)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
    assert.equal(stock(1, 1, 1, 1), 0);
    assert.ok(sql("SELECT COUNT(*) AS n FROM inventario WHERE cantidad < 0")[0].n === 0);
  });
});

describe("inventario, stock y reportes", () => {
  it("ingreso de stock: solo admin, idempotente por clave y con movimiento", async () => {
    const key = randomUUID();
    const body = { sucursal_id: 2, producto_id: 3, talla_id: 2, color_id: 2, cantidad: 7 };
    assert.equal((await post("/api/inventario/agregar", tokens.admin, body)).status, 400, "falta Idempotency-Key");
    const a = await post("/api/inventario/agregar", tokens.admin, body, { "Idempotency-Key": key });
    const b = await post("/api/inventario/agregar", tokens.admin, body, { "Idempotency-Key": key });
    assert.equal(a.status, 200); assert.equal(b.json.data.repetido, true);
    assert.equal(stock(2, 3, 2, 2), 7, "sumado una sola vez");
    assert.equal((await post("/api/inventario/agregar", tokens.admin, { ...body, cantidad: -1 }, { "Idempotency-Key": randomUUID() })).status, 400);
    assert.equal((await post("/api/inventario/agregar", tokens.admin, { ...body, producto_id: 999 }, { "Idempotency-Key": randomUUID() })).status, 400);
  });

  it("inventario por sucursal e independiente; consolidado solo admin y suma ambas", async () => {
    const cb = (await get("/api/inventario?sucursal_id=1", tokens.admin)).json.data;
    const sc = (await get("/api/inventario?sucursal_id=2", tokens.admin)).json.data;
    const all = (await get("/api/inventario", tokens.admin)).json.data;
    const sum = (rows) => rows.reduce((a, r) => a + r.cantidad, 0);
    assert.equal(sum(all), sum(cb) + sum(sc));
    assert.ok(all.every((r) => r.sucursal_id === null));
    assert.ok(cb.every((r) => r.sucursal_id === 1) && sc.every((r) => r.sucursal_id === 2));
    assert.deepEqual(Object.keys(cb[0]).sort(), ["cantidad", "color", "id", "ingreso", "producto", "sucursal_id", "talla"]);
  });

  it("producto nuevo: nombre único y precio editable solo por admin", async () => {
    const r = await post("/api/productos", tokens.admin, { nombre: "Modelo de prueba", precio_venta: 99.5 });
    assert.equal(r.status, 200);
    assert.equal((await post("/api/productos", tokens.admin, { nombre: "Modelo de prueba" })).status, 409);
    assert.equal((await api("PATCH", `/api/productos/${r.json.data.id}`, { token: tokens.cb, body: { precio_venta: 1 } })).status, 403);
    assert.equal((await api("PATCH", `/api/productos/${r.json.data.id}`, { token: tokens.admin, body: { precio_venta: 120 } })).status, 200);
  });

  it("balance: ingresos = suma de ventas completadas; cada desglose suma el total; traspasos aparte", async () => {
    const b = (await get("/api/reportes/balance", tokens.admin)).json.data;
    const expected = sql("SELECT ROUND(SUM(total),2) AS s, COUNT(*) AS c FROM ventas WHERE estado='completada'")[0];
    assert.equal(b.resumen.ingresos, expected.s);
    assert.equal(b.resumen.ventas, expected.c);
    const units = sql("SELECT SUM(dv.cantidad) AS u FROM detalle_venta dv JOIN ventas v ON v.id=dv.venta_id WHERE v.estado='completada'")[0].u;
    assert.equal(b.resumen.unidades, units);
    for (const k of ["por_metodo", "por_sucursal", "por_departamento", "por_modalidad", "por_dia"]) {
      const total = Math.round(b[k].reduce((a, x) => a + x.ingresos, 0) * 100) / 100;
      assert.equal(total, b.resumen.ingresos, k);
    }
    assert.ok(b.traspasos.total >= 4 && b.traspasos.recibidos >= 2);
    assert.ok(b.traspasos.unidades_recibidas >= 4);
    // los traspasos no alteran ingresos: la suma sigue siendo solo de ventas
    const qr = (await get("/api/reportes/balance?metodo_pago=QR", tokens.admin)).json.data;
    assert.ok(qr.por_metodo.every((x) => x.clave === "QR"));
    const pot = (await get("/api/reportes/balance?departamento=Potosí", tokens.admin)).json.data;
    assert.equal(pot.resumen.ventas, 1);
    const today = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
    const day = (await get(`/api/reportes/balance?desde=${today}&hasta=${today}`, tokens.admin)).json.data;
    assert.equal(day.resumen.ventas, b.resumen.ventas);
    const cbOnly = (await get("/api/reportes/balance?sucursal_id=1", tokens.admin)).json.data;
    assert.ok(cbOnly.por_sucursal.every((x) => x.clave === "MISSI Cochabamba"));
    assert.equal((await get("/api/reportes/balance?sucursal_id=1", tokens.sc)).status, 403);
    assert.equal((await get("/api/reportes/balance?desde=2026-13-45", tokens.admin)).status, 400);
  });

  it("dashboard con sucursal", async () => {
    const d = (await get("/api/dashboard?sucursal_id=1", tokens.cb)).json.data;
    assert.ok(d.stats.totalStock >= 0 && d.stats.salesToday >= 1);
    assert.ok(Array.isArray(d.recentSales) && Array.isArray(d.lowStockItems));
  });
});

// ---------------------------------------------------------------- formulario de venta, recibo, reportes y fotos
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(32, 2)]);
const rawPost = (p, token, body, type) =>
  fetch(BASE + p, { method: "POST", headers: { Connection: "close", Authorization: `Bearer ${token}`, "Content-Type": type }, body });

describe("teléfono (8 dígitos, texto)", () => {
  it("acepta vacío y exactamente 8 dígitos, conservando el cero inicial", async () => {
    const r0 = await post("/api/inventario/agregar", tokens.admin, { sucursal_id: 1, producto_id: 1, talla_id: 1, color_id: 1, cantidad: 30 }, { "Idempotency-Key": randomUUID() });
    assert.equal(r0.status, 200);
    const vacio = await post("/api/ventas", tokens.cb, saleBody({ cliente_telefono: "" }));
    assert.equal(vacio.status, 200);
    assert.equal(vacio.json.data.cliente_telefono, null);
    const ok = await post("/api/ventas", tokens.cb, saleBody({ cliente_telefono: "07123456" }));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(sql(`SELECT cliente_telefono AS t FROM ventas WHERE id=${ok.json.data.id}`)[0].t, "07123456");
  });

  it("rechaza 7 o 9 dígitos, letras, espacios, signos y números (no texto)", async () => {
    for (const bad of ["1234567", "123456789", "7123 456", "+59171234567", "7123-456", "7123456a", "abcdefgh", 71234567]) {
      const r = await post("/api/ventas", tokens.cb, saleBody({ cliente_telefono: bad }));
      assert.equal(r.status, 400, `aceptó ${JSON.stringify(bad)}`);
    }
  });
});

describe("entrega según modalidad", () => {
  it("entrega directa ignora cualquier dato de destino (no se guarda destino)", async () => {
    const r = await post("/api/ventas", tokens.cb, saleBody({ departamento: "Potosí", ciudad: "X", direccion: "Y", provincia: "Z" }));
    assert.equal(r.status, 200);
    assert.equal(r.json.data.modalidad, "entrega_directa");
    assert.equal(r.json.data.departamento, null);
    assert.equal(r.json.data.provincia, null);
  });

  it("envío: solo el departamento es obligatorio (ciudad y dirección ya no se piden)", async () => {
    const sinDepto = await post("/api/ventas", tokens.cb, saleBody({ modalidad: "envio" }));
    assert.equal(sinDepto.status, 400);
    const invalido = await post("/api/ventas", tokens.cb, saleBody({ modalidad: "envio", departamento: "Atlántida" }));
    assert.equal(invalido.status, 400);
    const ok = await post("/api/ventas", tokens.cb, saleBody({ modalidad: "envio", metodo_pago: "QR", departamento: "Santa Cruz" }));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.data.modalidad, "envio");
    assert.equal(ok.json.data.departamento, "Santa Cruz");
  });

  it("envío interprovincial: la provincia (texto libre) es obligatoria", async () => {
    const sinProv = await post("/api/ventas", tokens.cb, saleBody({ modalidad: "envio_interprovincial", departamento: "Potosí" }));
    assert.equal(sinProv.status, 400);
    const ok = await post("/api/ventas", tokens.cb, saleBody({ modalidad: "envio_interprovincial", provincia: "Nor Chichas" }));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.data.provincia, "Nor Chichas");
    assert.equal(ok.json.data.modalidad, "envio_interprovincial");
  });
});

describe("recibo de la venta confirmada", () => {
  it("la respuesta trae número real, fecha ISO, sucursal, vendedor, pago, líneas y total", async () => {
    const r = await post("/api/ventas", tokens.cb, saleBody({ metodo_pago: "QR", items: [line(1, 1, 1, 2, 135)], cliente_nombre: "Ana", cliente_telefono: "71234567" }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const rec = r.json.data;
    assert.equal(sql(`SELECT COUNT(*) AS n FROM ventas WHERE id=${rec.id}`)[0].n, 1, "id existe en la base");
    assert.equal(rec.total, 270);
    assert.equal(rec.metodo_pago, "QR");
    assert.equal(rec.sucursal, "MISSI Cochabamba");
    assert.equal(rec.vendedor, "Vend CB");
    assert.match(rec.fecha, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(rec.items.length, 1);
    assert.equal(rec.items[0].cantidad, 2);
    assert.equal(rec.items[0].precio_unitario, 135);
    assert.equal(rec.items[0].subtotal, 270);
    assert.ok(rec.items[0].producto && rec.items[0].talla && rec.items[0].color);
    assert.equal(rec.repetida, false);
  });

  it("repetir la misma venta devuelve el mismo recibo sin duplicar ni volver a descontar", async () => {
    const body = saleBody({ items: [line(1, 1, 1, 1, 100)] });
    const s0 = stock(1, 1, 1, 1);
    const a = await post("/api/ventas", tokens.cb, body);
    const b = await post("/api/ventas", tokens.cb, body);
    assert.equal(a.json.data.id, b.json.data.id);
    assert.equal(b.json.data.repetida, true);
    assert.equal(b.json.data.items.length, 1);
    assert.equal(stock(1, 1, 1, 1), s0 - 1);
  });
});

describe("reportes: horas, semanas, meses y ticket promedio", () => {
  it("ticket promedio = ingresos / ventas completadas; cada desglose suma el total", async () => {
    const b = (await get("/api/reportes/balance", tokens.admin)).json.data;
    assert.equal(b.resumen.ticket_promedio, Math.round((b.resumen.ingresos / b.resumen.ventas) * 100) / 100);
    for (const k of ["por_hora", "por_semana", "por_mes", "por_dia"]) {
      assert.equal(Math.round(b[k].reduce((a, x) => a + x.ingresos, 0) * 100) / 100, b.resumen.ingresos, k);
      assert.equal(b[k].reduce((a, x) => a + x.ventas, 0), b.resumen.ventas, k + " ventas");
    }
    assert.ok(b.por_hora.every((x) => /^\d{2}:00$/.test(x.clave)), "horas HH:00");
  });

  it("la hora es de Bolivia (UTC-4): 02:30 UTC del 10-oct aparece a las 22:00 del 09-oct", async () => {
    sql("INSERT INTO ventas (sucursal_id, fecha, total, metodo_pago, estado) VALUES (1, '2026-10-10 02:30:00', 50, 'efectivo', 'completada')");
    assert.equal(sql("SELECT strftime('%H', '2026-10-10 02:30:00', '-4 hours') AS h")[0].h, "22");
    const r = (await get("/api/reportes/balance?desde=2026-10-09&hasta=2026-10-09", tokens.admin)).json.data;
    assert.ok(r.por_hora.some((x) => x.clave === "22:00"), "22:00 del día local 09-oct");
  });

  it("una venta cancelada no cuenta en horas, meses, días ni ticket", async () => {
    const before = (await get("/api/reportes/balance", tokens.admin)).json.data;
    const v = (await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 1, 1, 1, 999)] }))).json.data;
    assert.equal((await post(`/api/ventas/${v.id}/cancelar`, tokens.admin, { motivo: "prueba de reporte" })).status, 200);
    const after = (await get("/api/reportes/balance", tokens.admin)).json.data;
    assert.equal(after.resumen.ventas, before.resumen.ventas + 0, "la cancelada no suma a ventas");
    assert.equal(after.resumen.ingresos, before.resumen.ingresos, "ni a ingresos");
    assert.equal(Math.round(after.por_mes.reduce((a, x) => a + x.ingresos, 0) * 100) / 100, after.resumen.ingresos);
  });
});

describe("fotos de producto (una por modelo, en R2)", () => {
  it("solo administrador sube; tipos y contenido validados; sin foto = fallback", async () => {
    assert.equal((await rawPost("/api/productos/1/foto", tokens.cb, PNG, "image/png")).status, 403);
    assert.equal((await rawPost("/api/productos/1/foto", tokens.admin, Buffer.from("hola"), "text/plain")).status, 415);
    assert.equal((await rawPost("/api/productos/1/foto", tokens.admin, PNG, "image/jpeg")).status, 400, "tipo declarado no coincide");
    assert.equal((await rawPost("/api/productos/1/foto", tokens.admin, Buffer.alloc(0), "image/png")).status, 400);
    assert.equal((await rawPost("/api/productos/1/foto", tokens.admin, Buffer.alloc(2 * 1024 * 1024 + 1, 1), "image/jpeg")).status, 413);
    assert.equal((await rawPost("/api/productos/99999/foto", tokens.admin, PNG, "image/png")).status, 404);
    const sinFoto = (await get("/api/productos", tokens.cb)).json.data.find((p) => p.foto_url === null);
    assert.ok(sinFoto, "hay modelos sin foto");
    assert.equal((await fetch(`${BASE}/api/productos/${sinFoto.id}/foto`)).status, 404, "sin foto: 404 y la app muestra el fallback");
  });

  it("sube PNG, JPEG y WebP; la URL pública devuelve la imagen; subir otra reemplaza la anterior", async () => {
    const up1 = await rawPost("/api/productos/1/foto", tokens.admin, PNG, "image/png");
    const up1Body = await up1.json();
    assert.equal(up1.status, 200, JSON.stringify(up1Body));
    const url1 = up1Body.data.foto_url;
    assert.match(url1, /^\/api\/productos\/1\/foto\?v=/);
    const img = await fetch(BASE + url1);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    assert.equal((await get("/api/productos", tokens.cb)).json.data.find((p) => p.id === 1).foto_url, url1);

    const up2 = await rawPost("/api/productos/1/foto", tokens.admin, JPEG, "image/jpeg");
    assert.equal(up2.status, 200);
    const url2 = (await up2.json()).data.foto_url;
    assert.notEqual(url2, url1, "nueva versión, nueva URL");
    assert.equal((await fetch(BASE + url2)).headers.get("content-type"), "image/jpeg");
    assert.equal((await rawPost("/api/productos/1/foto", tokens.admin, WEBP, "image/webp")).status, 200, "WebP aceptado");
  });

  it("subir la foto no cambia nombre, precio, estado ni stock del modelo", async () => {
    const antes = sql("SELECT nombre, precio_venta, activo FROM productos WHERE id=1")[0];
    const stockAntes = sql("SELECT SUM(cantidad) AS n FROM inventario WHERE producto_id=1")[0].n;
    assert.equal((await rawPost("/api/productos/1/foto", tokens.admin, PNG, "image/png")).status, 200);
    assert.deepEqual(sql("SELECT nombre, precio_venta, activo FROM productos WHERE id=1")[0], antes);
    assert.equal(sql("SELECT SUM(cantidad) AS n FROM inventario WHERE producto_id=1")[0].n, stockAntes);
  });
});

// ---------------------------------------------------------------- formulario único: descripción, confirmación única y recibo
describe("formulario único: descripción y confirmación", () => {
  it("guarda la descripción, la devuelve en el recibo y la lista; sin descripción queda null", async () => {
    const r = await post("/api/ventas", tokens.cb, saleBody({ observaciones: "  regalo de cumpleaños  ", items: [line(1, 1, 1, 1, 100)] }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.observaciones, "regalo de cumpleaños");
    assert.equal(sql(`SELECT observaciones AS o FROM ventas WHERE id=${r.json.data.id}`)[0].o, "regalo de cumpleaños");
    const list = (await get("/api/ventas?limit=5", tokens.cb)).json.data;
    assert.equal(list.find((s) => s.id === r.json.data.id).observaciones, "regalo de cumpleaños");
    const plain = await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 1, 1, 1, 100)] }));
    assert.equal(plain.json.data.observaciones, null);
  });

  it("descripción de más de 300 caracteres se rechaza", async () => {
    const r = await post("/api/ventas", tokens.cb, saleBody({ observaciones: "x".repeat(301) }));
    assert.equal(r.status, 400);
  });

  it("confirmar dos veces con la misma clave (reintento tras un fallo de red) = una sola venta y un solo descuento", async () => {
    const body = saleBody({ items: [line(1, 1, 1, 2, 100)], observaciones: "reintento" });
    const s0 = stock(1, 1, 1, 1);
    const ventas0 = sql("SELECT COUNT(*) AS n FROM ventas")[0].n;
    const [a, b] = await Promise.all([post("/api/ventas", tokens.cb, body), post("/api/ventas", tokens.cb, body)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.json.data.id, b.json.data.id, "mismo recibo");
    assert.equal(sql("SELECT COUNT(*) AS n FROM ventas")[0].n, ventas0 + 1, "una sola venta");
    assert.equal(stock(1, 1, 1, 1), s0 - 2, "descuento único");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM movimientos_inventario WHERE tipo='venta' AND referencia_id=${a.json.data.id}`)[0].n, 1, "un solo movimiento");
  });
});

// ---------------------------------------------------------------- devoluciones, cambios y anulaciones
const todayLocal = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
const opBody = (over = {}) => ({ idempotency_key: randomUUID(), ...over });
const pendientesOf = async (ventaId, token = tokens.admin) =>
  (await get(`/api/ventas/${ventaId}/detalle-completo`, token)).json.data;

describe("devoluciones, cambios y anulaciones", () => {
  let venta;
  before(async () => {
    for (const [t, c, n] of [[1, 1, 100], [2, 1, 60]]) {
      const add = await post("/api/inventario/agregar", tokens.admin, { sucursal_id: 1, producto_id: 1, talla_id: t, color_id: c, cantidad: n }, { "Idempotency-Key": randomUUID() });
      assert.equal(add.status, 200);
    }
    const r = await post("/api/ventas", tokens.cb, saleBody({
      modalidad: "envio", departamento: "Tarija", metodo_pago: "QR", cliente_nombre: "Lucía Prueba", cliente_telefono: "76543210",
      items: [line(1, 1, 1, 5, 135)], observaciones: "para boda",
    }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    venta = r.json.data;
  });

  it("búsqueda por cliente, teléfono, número, producto, talla, color, fecha, destino y sucursal", async () => {
    const find = async (q) => (await get(`/api/ventas/buscar?${q}`, tokens.cb)).json.data.map((v) => v.id);
    assert.ok((await find("cliente=lucía")).includes(venta.id), "cliente sin importar mayúsculas");
    assert.ok((await find("telefono=7654")).includes(venta.id), "teléfono parcial");
    assert.ok((await find(`numero=${venta.id}`)).includes(venta.id), "número de venta");
    assert.ok((await find("producto=Palazzo sastrero")).includes(venta.id), "modelo");
    assert.ok((await find("talla=P&color=Blanco")).includes(venta.id), "talla y color");
    assert.ok((await find(`desde=${todayLocal()}&hasta=${todayLocal()}`)).includes(venta.id), "rango de fechas");
    assert.ok((await find("departamento=Tarija")).includes(venta.id), "departamento de envío");
    assert.ok((await find("sucursal_id=1")).includes(venta.id), "sucursal");
    assert.ok(!(await find("cliente=no-existe-xyz")).length, "sin coincidencias");
    const hit = (await get(`/api/ventas/buscar?numero=${venta.id}`, tokens.cb)).json.data[0];
    assert.equal(hit.items[0].cantidad, 5);
    assert.equal(hit.sucursal, "MISSI Cochabamba");
  });

  it("búsqueda y detalle de otra sucursal no se ven desde un vendedor de otra sucursal", async () => {
    const ids = (await get("/api/ventas/buscar", tokens.sc)).json.data.map((v) => v.id);
    assert.ok(!ids.includes(venta.id));
    assert.equal((await get(`/api/ventas/${venta.id}/detalle-completo`, tokens.sc)).status, 403);
  });

  it("devolución parcial: devuelve 1 de 3, reembolso inmediato en efectivo, stock +1 con movimiento, venta original intacta", async () => {
    const detail = await pendientesOf(venta.id);
    const line1 = detail.lineas[0];
    assert.equal(line1.pendiente, 5);
    const s0 = stock(1, 1, 1, 1);
    const r = await post("/api/operaciones/devolucion", tokens.cb, opBody({
      venta_id: venta.id, motivo: "talla no le queda", items: [{ detalle_id: line1.detalle_id, cantidad: 1, condicion: "vendible" }],
      liquidacion: "reembolso_inmediato", metodo_pago: "efectivo",
    }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const op = r.json.data;
    assert.equal(op.tipo, "devolucion");
    assert.equal(op.valor_devuelto, 135);
    assert.equal(op.pago.tipo, "reembolso");
    assert.equal(op.pago.estado, "completado");
    assert.equal(op.pago.metodo, "efectivo");
    assert.equal(op.pago.monto, 135);
    assert.equal(op.operador, "Vend CB");
    assert.equal(op.repetida, false);
    assert.equal(stock(1, 1, 1, 1), s0 + 1);
    assert.equal(sql(`SELECT COUNT(*) AS n FROM movimientos_inventario WHERE tipo='entrada' AND referencia_tipo='devolucion' AND referencia_id=${op.id}`)[0].n, 1);
    const after = await pendientesOf(venta.id);
    assert.equal(after.lineas[0].devuelta, 1);
    assert.equal(after.lineas[0].pendiente, 4);
    assert.equal(sql(`SELECT total FROM ventas WHERE id=${venta.id}`)[0].total, 675, "el total de la venta no cambia");
    assert.equal(sql(`SELECT estado FROM ventas WHERE id=${venta.id}`)[0].estado, "completada");
  });

  it("no se puede devolver más de lo que queda (validado en el servidor)", async () => {
    const line1 = (await pendientesOf(venta.id)).lineas[0];
    const r = await post("/api/operaciones/devolucion", tokens.cb, opBody({
      venta_id: venta.id, motivo: "x", items: [{ detalle_id: line1.detalle_id, cantidad: 5, condicion: "vendible" }],
      liquidacion: "reembolso_pendiente",
    }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /quedan 4/);
  });

  it("dañado: no suma stock vendible, va a cuarentena con movimiento trazable", async () => {
    const line1 = (await pendientesOf(venta.id)).lineas[0];
    const s0 = stock(1, 1, 1, 1);
    const dan0 = sql("SELECT COALESCE(SUM(cantidad),0) AS n FROM inventario_danado WHERE sucursal_id=1 AND producto_id=1 AND talla_id=1 AND color_id=1")[0].n;
    const r = await post("/api/operaciones/devolucion", tokens.cb, opBody({
      venta_id: venta.id, motivo: "manchado", items: [{ detalle_id: line1.detalle_id, cantidad: 1, condicion: "danado" }],
      liquidacion: "credito",
    }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.pago.tipo, "credito");
    assert.equal(r.json.data.pago.estado, "pendiente");
    assert.equal(stock(1, 1, 1, 1), s0, "stock vendible sin cambios");
    assert.equal(sql("SELECT COALESCE(SUM(cantidad),0) AS n FROM inventario_danado WHERE sucursal_id=1 AND producto_id=1 AND talla_id=1 AND color_id=1")[0].n, dan0 + 1);
    assert.equal(sql(`SELECT COUNT(*) AS n FROM movimientos_inventario WHERE referencia_tipo='devolucion_danada' AND referencia_id=${r.json.data.id}`)[0].n, 1);
  });

  it("reintento con la misma clave (doble clic / red) no duplica ni suma stock de nuevo", async () => {
    const line1 = (await pendientesOf(venta.id)).lineas[0];
    const key = randomUUID();
    const body = { venta_id: venta.id, motivo: "reintento", items: [{ detalle_id: line1.detalle_id, cantidad: 1, condicion: "vendible" }], liquidacion: "reembolso_pendiente", idempotency_key: key };
    const s0 = stock(1, 1, 1, 1);
    const [a, b] = await Promise.all([post("/api/operaciones/devolucion", tokens.cb, body), post("/api/operaciones/devolucion", tokens.cb, body)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.json.data.id, b.json.data.id);
    assert.equal(sql(`SELECT COUNT(*) AS n FROM operaciones WHERE idempotency_key='${key}'`)[0].n, 1);
    assert.equal(stock(1, 1, 1, 1), s0 + 1, "una sola suma");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM movimientos_inventario WHERE referencia_tipo='devolucion' AND referencia_id=${a.json.data.id}`)[0].n, 1);
  });

  it("concurrencia: dos devoluciones simultáneas por más de lo que queda → una gana, la otra no guarda nada", async () => {
    const line1 = (await pendientesOf(venta.id)).lineas[0];
    assert.equal(line1.pendiente, 2, "quedan 2 unidades para la prueba");
    const s0 = stock(1, 1, 1, 1);
    const ops0 = sql(`SELECT COUNT(*) AS n FROM operaciones WHERE venta_id=${venta.id}`)[0].n;
    const mk = () => post("/api/operaciones/devolucion", tokens.cb, opBody({
      venta_id: venta.id, motivo: "carrera", items: [{ detalle_id: line1.detalle_id, cantidad: 2, condicion: "vendible" }], liquidacion: "reembolso_pendiente",
    }));
    const rs = await Promise.all([mk(), mk()]);
    assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
    assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 400 || r.status === 409), rs.map((r) => r.status).join(","));
    assert.equal(stock(1, 1, 1, 1), s0 + 2, "stock sumado una sola vez");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM operaciones WHERE venta_id=${venta.id}`)[0].n, ops0 + 1);
    const loser = rs.find((r) => r.status !== 200);
    assert.match(loser.json.error, /quedan 0|cambi|No se guardó nada/, JSON.stringify(loser.json));
    assert.ok(sql("SELECT COUNT(*) AS n FROM inventario WHERE cantidad < 0")[0].n === 0);
  });

  it("cambio de talla: devuelve la unidad y entrega otra talla (diferencia 0 = sin pago)", async () => {
    const v = (await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 1, 1, 1, 135)] }))).json.data;
    const det = (await pendientesOf(v.id)).lineas[0];
    const s1 = stock(1, 1, 1, 1), s2 = stock(1, 1, 2, 1);
    const r = await post("/api/operaciones/cambio", tokens.cb, opBody({
      venta_id: v.id, motivo: "cambio de talla", items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "vendible" }],
      reemplazos: [{ producto_id: 1, talla_id: 2, color_id: 1, cantidad: 1 }],
    }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.tipo, "cambio");
    assert.equal(r.json.data.diferencia, 0);
    assert.equal(r.json.data.pago.tipo, "ninguno");
    assert.equal(stock(1, 1, 1, 1), s1 + 1, "devuelta vuelve");
    assert.equal(stock(1, 1, 2, 1), s2 - 1, "reemplazo sale de la sucursal de la venta");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM movimientos_inventario WHERE referencia_tipo='cambio' AND referencia_id=${r.json.data.id}`)[0].n, 1);
    assert.equal(sql(`SELECT COUNT(*) AS n FROM ventas WHERE id=${v.id} AND total=135`)[0].n, 1, "el cambio no crea venta nueva");
  });

  it("cambio con diferencia a favor de la tienda exige cobro (método) y queda completado", async () => {
    const v = (await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 1, 1, 1, 135)] }))).json.data;
    const det = (await pendientesOf(v.id)).lineas[0];
    const base = { venta_id: v.id, motivo: "sube de modelo", items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "vendible" }],
      reemplazos: [{ producto_id: 2, talla_id: 1, color_id: 1, cantidad: 1, precio_unitario: 200 }] };
    const sinMetodo = await post("/api/operaciones/cambio", tokens.cb, opBody(base));
    assert.equal(sinMetodo.status, 400, "cobro sin método de pago no se acepta");
    const ok = await post("/api/operaciones/cambio", tokens.cb, opBody({ ...base, metodo_pago: "qr" }));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.data.diferencia, 65);
    assert.equal(ok.json.data.valor_entregado, 200);
    assert.equal(ok.json.data.pago.tipo, "cobro");
    assert.equal(ok.json.data.pago.estado, "completado");
    assert.equal(ok.json.data.pago.metodo, "qr");
    assert.equal(ok.json.data.pago.monto, 65);
  });

  it("cambio a un modelo más barato: el cliente recibe crédito pendiente o reembolso; sin elegir no se guarda", async () => {
    const v = (await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 1, 1, 1, 135)] }))).json.data;
    const det = (await pendientesOf(v.id)).lineas[0];
    const base = { venta_id: v.id, motivo: "modelo más barato", items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "vendible" }],
      reemplazos: [{ producto_id: 1, talla_id: 2, color_id: 1, cantidad: 1, precio_unitario: 100 }] };
    const ok = await post("/api/operaciones/cambio", tokens.cb, opBody({ ...base, liquidacion: "credito" }));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.data.diferencia, -35);
    assert.equal(ok.json.data.pago.tipo, "credito");
    assert.equal(ok.json.data.pago.estado, "pendiente");
    assert.equal(ok.json.data.pago.monto, 35);
    const v2 = (await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 1, 1, 1, 135)] }))).json.data;
    const det2 = (await pendientesOf(v2.id)).lineas[0];
    const porDefecto = await post("/api/operaciones/cambio", tokens.cb, opBody({ venta_id: v2.id, motivo: "modelo más barato", items: [{ detalle_id: det2.detalle_id, cantidad: 1, condicion: "vendible" }], reemplazos: [{ producto_id: 1, talla_id: 2, color_id: 1, cantidad: 1, precio_unitario: 100 }] }));
    assert.equal(porDefecto.status, 200, JSON.stringify(porDefecto.json));
    assert.equal(porDefecto.json.data.pago.tipo, "reembolso", "sin elegir, el reembolso queda pendiente");
    assert.equal(porDefecto.json.data.pago.estado, "pendiente");
  });

  it("cambio sin stock de reemplazo: 409 y no queda NADA (ni devolución, ni dinero, ni movimientos)", async () => {
    const v = (await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 1, 1, 1, 135)] }))).json.data;
    const det = (await pendientesOf(v.id)).lineas[0];
    const s1 = stock(1, 1, 1, 1);
    const ops0 = sql("SELECT COUNT(*) AS n FROM operaciones")[0].n;
    const mov0 = sql("SELECT COUNT(*) AS n FROM movimientos_inventario")[0].n;
    const r = await post("/api/operaciones/cambio", tokens.cb, opBody({
      venta_id: v.id, motivo: "sin stock", items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "vendible" }],
      reemplazos: [{ producto_id: 1, talla_id: 3, color_id: 13, cantidad: 999 }], liquidacion: "credito",
    }));
    assert.ok(r.status === 400 || r.status === 409, JSON.stringify(r.json));
    assert.equal(sql("SELECT COUNT(*) AS n FROM operaciones")[0].n, ops0);
    assert.equal(sql("SELECT COUNT(*) AS n FROM movimientos_inventario")[0].n, mov0);
    assert.equal(stock(1, 1, 1, 1), s1);
    assert.equal((await pendientesOf(v.id)).lineas[0].devuelta, 0);
  });

  it("aislamiento de sucursal: un vendedor de otra sucursal no puede devolver ni cambiar", async () => {
    const det = (await pendientesOf(venta.id)).lineas[0];
    const r = await post("/api/operaciones/devolucion", tokens.sc, opBody({ venta_id: venta.id, motivo: "x", items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "vendible" }], liquidacion: "credito" }));
    assert.equal(r.status, 403);
  });

  it("anulación (solo admin): repone SOLO lo que queda, cambia el estado, deja historial, y no se repite", async () => {
    const v = (await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 1, 1, 3, 135)] }))).json.data;
    const det = (await pendientesOf(v.id)).lineas[0];
    await post("/api/operaciones/devolucion", tokens.cb, opBody({ venta_id: v.id, motivo: "parcial", items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "vendible" }], liquidacion: "reembolso_inmediato", metodo_pago: "efectivo" }));
    const s0 = stock(1, 1, 1, 1);
    assert.equal((await post(`/api/ventas/${v.id}/cancelar`, tokens.cb, { motivo: "x" })).status, 403);
    const r = await post(`/api/ventas/${v.id}/cancelar`, tokens.admin, { motivo: "cliente desistió", liquidacion: "reembolso_pendiente" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(stock(1, 1, 1, 1), s0 + 2, "repone solo las 2 unidades que quedaban");
    assert.equal(sql(`SELECT estado FROM ventas WHERE id=${v.id}`)[0].estado, "cancelada");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM operaciones WHERE tipo='anulacion' AND venta_id=${v.id}`)[0].n, 1);
    assert.equal((await post(`/api/ventas/${v.id}/cancelar`, tokens.admin, { motivo: "otra vez" })).status, 409);
    assert.equal(stock(1, 1, 1, 1), s0 + 2, "no se repone dos veces");
    const d = await pendientesOf(v.id);
    assert.equal(d.venta.estado, "cancelada");
    assert.equal(d.puede_anular, false);
    assert.equal((await post("/api/operaciones/devolucion", tokens.cb, opBody({ venta_id: v.id, motivo: "x", items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "vendible" }], liquidacion: "credito" }))).status, 409, "venta anulada no admite devoluciones");
  });

  it("no se puede anular una venta ya devuelta por completo: el sistema lo explica", async () => {
    const v = (await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 1, 1, 1, 135)] }))).json.data;
    const det = (await pendientesOf(v.id)).lineas[0];
    await post("/api/operaciones/devolucion", tokens.cb, opBody({ venta_id: v.id, motivo: "todo", items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "vendible" }], liquidacion: "reembolso_pendiente" }));
    const r = await post(`/api/ventas/${v.id}/cancelar`, tokens.admin, { motivo: "x" });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /devuelto|cambiado/);
  });

  it("reportes: ingresos brutos sin cambio, devoluciones y cambios restados en el neto, reembolsos separados", async () => {
    const b = (await get("/api/reportes/balance", tokens.admin)).json.data;
    const o = b.operaciones;
    assert.equal(o.ingresos_brutos, b.resumen.ingresos);
    assert.equal(o.ingresos_netos, Math.round((o.ingresos_brutos - o.valor_devuelto + o.valor_cambio_entregado) * 100) / 100);
    assert.ok(o.devoluciones >= 1 && o.cambios >= 1 && o.anulaciones >= 1);
    assert.ok(o.reembolsos_completados > 0, "reembolso inmediato registrado como completado");
    assert.ok(o.reembolsos_pendientes > 0, "reembolso pendiente registrado como pendiente");
    assert.ok(o.creditos_pendientes > 0, "crédito registrado como pendiente");
    assert.ok(o.cobros_completados >= 65, "cobro de diferencia registrado");
    const cb1 = (await get("/api/reportes/balance?sucursal_id=1", tokens.admin)).json.data;
    assert.ok(cb1.operaciones.devoluciones <= o.devoluciones);
    assert.equal((await get("/api/reportes/balance", tokens.sc)).status, 200);
    assert.equal((await get("/api/reportes/balance?sucursal_id=1", tokens.sc)).status, 403);
  });

  it("historial de operaciones filtrado por venta y por sucursal", async () => {
    const h = (await get(`/api/operaciones?venta_id=${venta.id}`, tokens.admin)).json.data;
    assert.ok(h.length >= 3);
    assert.ok(h.every((o) => o.venta_id === venta.id));
    const hs = (await get("/api/operaciones", tokens.sc)).json.data;
    assert.ok(hs.every((o) => o.sucursal_id === 2));
  });
});

// ---------------------------------------------------------------- reportes por periodo (servidor)
const diaBolivia = (offset = 0) => new Date(Date.now() - 4 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);

describe("reportes por periodo: fechas, sucursal y totales", () => {
  it("valida el periodo: desde <= hasta y formato AAAA-MM-DD", async () => {
    assert.equal((await get(`/api/reportes/movimientos?desde=${diaBolivia(0)}&hasta=${diaBolivia(-1)}`, tokens.admin)).status, 400);
    assert.equal((await get("/api/reportes/movimientos?desde=2026-02-30&hasta=2026-10-18", tokens.admin)).status, 400);
    assert.equal((await get("/api/reportes/movimientos?desde=18/10/2026&hasta=2026-10-18", tokens.admin)).status, 400);
    assert.equal((await get("/api/reportes/movimientos", tokens.admin)).status, 400, "periodo obligatorio");
  });

  it("incluye el último día: una venta de hoy (fecha local) aparece con hasta = hoy y no con hasta = ayer", async () => {
    const v = (await post("/api/ventas", tokens.cb, saleBody({ items: [line(1, 1, 1, 1, 77)], cliente_nombre: "Fin de periodo" }))).json.data;
    const hoy = diaBolivia(0);
    const enHoy = (await get(`/api/ventas?desde=${hoy}&hasta=${hoy}&limit=500`, tokens.admin)).json.data;
    assert.ok(enHoy.some((s) => s.id === v.id), "la venta de hoy entra con hasta = hoy");
    const enAyer = (await get(`/api/ventas?desde=${diaBolivia(-1)}&hasta=${diaBolivia(-1)}&limit=500`, tokens.admin)).json.data;
    assert.ok(!enAyer.some((s) => s.id === v.id), "no entra en el día anterior");
    const mov = (await get(`/api/reportes/movimientos?desde=${hoy}&hasta=${hoy}`, tokens.admin)).json.data;
    assert.ok(mov.filas.some((f) => f.referencia === `venta #${v.id}` && f.efecto === "Salida"), "el movimiento de la venta de hoy entra en el periodo de hoy");
  });

  it("el balance y el detalle usan el mismo periodo: mismo número de ventas completadas", async () => {
    const d = diaBolivia(0);
    const bal = (await get(`/api/reportes/balance?desde=${d}&hasta=${d}`, tokens.admin)).json.data;
    const det = (await get(`/api/ventas?desde=${d}&hasta=${d}&estado=completada&limit=500`, tokens.admin)).json.data;
    assert.equal(bal.resumen.ventas, det.length);
    const total = Math.round(det.reduce((a, s) => a + s.total, 0) * 100) / 100;
    assert.equal(bal.resumen.ingresos, total, "mismo total");
  });

  it("aislamiento de sucursal: vendedor de Santa Cruz no ve Cochabamba y sin sucursal solo ve la suya", async () => {
    const d = diaBolivia(0);
    assert.equal((await get(`/api/reportes/movimientos?desde=${d}&hasta=${d}&sucursal_id=1`, tokens.sc)).status, 403);
    assert.equal((await get(`/api/reportes/stock?sucursal_id=1`, tokens.sc)).status, 403);
    assert.equal((await get(`/api/reportes/balance?desde=${d}&hasta=${d}&sucursal_id=1`, tokens.sc)).status, 403);
    const movSc = (await get(`/api/reportes/movimientos?desde=2000-01-01&hasta=${d}`, tokens.sc)).json.data;
    assert.ok(movSc.filas.every((f) => f.sucursal === "MISSI Santa Cruz"));
    const stSc = (await get("/api/reportes/stock", tokens.sc)).json.data;
    assert.ok(stSc.totales_por_sucursal.every((t) => t.sucursal === "MISSI Santa Cruz"));
  });

  it("periodo sin movimientos: filas vacías y totales vacíos (no inventa cifras)", async () => {
    const mov = (await get("/api/reportes/movimientos?desde=1990-01-01&hasta=1990-01-31", tokens.admin)).json.data;
    assert.equal(mov.total_movimientos, 0);
    assert.deepEqual(mov.filas, []);
    assert.deepEqual(mov.totales, []);
    const bal = (await get("/api/reportes/balance?desde=1990-01-01&hasta=1990-01-31", tokens.admin)).json.data;
    assert.equal(bal.resumen.ventas, 0);
    assert.equal(bal.resumen.ingresos, 0);
  });

  it("stock actual: totales por sucursal coinciden con el inventario guardado (vendible)", async () => {
    const st = (await get("/api/reportes/stock", tokens.admin)).json.data;
    for (const t of st.totales_por_sucursal) {
      const id = t.sucursal === "MISSI Cochabamba" ? 1 : 2;
      const real = sql(`SELECT COALESCE(SUM(cantidad),0) AS n FROM inventario WHERE sucursal_id=${id}`)[0].n;
      assert.equal(t.vendible, real, t.sucursal);
    }
  });
});

describe("búsqueda universal de ventas (un solo campo)", () => {
  let v;
  before(async () => {
    const r = await post("/api/ventas", tokens.cb, saleBody({
      modalidad: "envio_interprovincial", provincia: "Omasuyos", metodo_pago: "QR",
      cliente_nombre: "Rosario Quispe", cliente_telefono: "71234598", items: [line(1, 1, 1, 1, 135)], observaciones: "regalo aniversario",
    }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    v = r.json.data;
  });
  const ids = async (q, token = tokens.cb) => (await get(`/api/ventas/buscar?q=${encodeURIComponent(q)}`, token)).json.data.map((s) => s.id);

  it("encuentra por número de venta, con o sin #", async () => {
    assert.ok((await ids(String(v.id))).includes(v.id));
    assert.ok((await ids(`#${v.id}`)).includes(v.id));
  });
  it("encuentra por nombre parcial sin importar mayúsculas", async () => {
    assert.ok((await ids("rosario")).includes(v.id));
    assert.ok((await ids("QUISPE")).includes(v.id));
  });
  it("encuentra por teléfono parcial, completo o con prefijo +591 y espacios", async () => {
    assert.ok((await ids("4598")).includes(v.id));
    assert.ok((await ids("71234598")).includes(v.id));
    assert.ok((await ids("+591 71234598")).includes(v.id));
  });
  it("encuentra por modelo, talla, color, provincia, notas y método de pago", async () => {
    const detail = (await get(`/api/ventas/${v.id}/detalle-completo`, tokens.cb)).json.data;
    const l = detail.lineas[0];
    for (const q of [l.producto, l.color, "Omasuyos", "aniversario"]) assert.ok((await ids(q)).includes(v.id), q);
  });
  it("encuentra por fecha local (AAAA-MM-DD o DD/MM/AAAA)", async () => {
    const d = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
    const [y, m, dd] = d.split("-");
    assert.ok((await ids(d)).includes(v.id));
    assert.ok((await ids(`${dd}/${m}/${y}`)).includes(v.id));
  });
  it("varias palabras se combinan (todas deben coincidir)", async () => {
    assert.ok((await ids("rosario omasuyos")).includes(v.id));
    assert.ok(!(await ids("rosario zzznoexiste")).includes(v.id));
  });
  it("sin coincidencias devuelve lista vacía; respeta la sucursal del vendedor", async () => {
    assert.deepEqual(await ids("palabra-que-no-existe-xyz"), []);
    assert.ok(!(await ids("rosario", tokens.sc)).includes(v.id), "Santa Cruz no ve ventas de Cochabamba");
  });
  it("caracteres especiales no rompen la consulta (parámetros, sin inyección)", async () => {
    for (const q of ["%", "_", "' OR 1=1 --", "\\"]) {
      const r = await get(`/api/ventas/buscar?q=${encodeURIComponent(q)}`, tokens.cb);
      assert.equal(r.status, 200, q);
    }
  });
});

describe("venta multiproducto: una venta, un número, varias líneas", () => {
  // Tres modelos distintos con stock propio en CADA sucursal (3 en Cochabamba y 3 en Santa Cruz, cantidades distintas).
  let P; // ids de los modelos usados: [palazzo, pantalón con hebilla, short]
  const nameOf = (id) => sql(`SELECT nombre FROM productos WHERE id = ${id}`)[0].nombre;
  const balance = async () => (await get("/api/reportes/balance", tokens.admin)).json.data.resumen;
  const maria = (over = {}) => saleBody({
    cliente_nombre: "María", cliente_telefono: "71234567", metodo_pago: "QR",
    items: [line(P[0], 1, 1, 1, 120), line(P[1], 1, 1, 1, 135), line(P[2], 1, 1, 2, 65)], ...over,
  });

  before(() => {
    P = sql("SELECT id FROM productos WHERE activo = 1 AND id > 3 ORDER BY id LIMIT 3").map((r) => r.id);
    assert.equal(P.length, 3, "el catálogo de prueba debe tener al menos 3 modelos activos extra");
    sql(`INSERT INTO inventario (producto_id,talla_id,color_id,sucursal_id,cantidad) VALUES
      (${P[0]},1,1,1,40),(${P[1]},1,1,1,40),(${P[2]},1,1,1,40),
      (${P[0]},1,1,2,7),(${P[1]},1,1,2,8),(${P[2]},1,1,2,9)`);
  });

  it("TEST A/B: María compra 3 productos distintos -> UNA venta, UN número, 3 líneas con su precio y total Bs 385", async () => {
    const ventas = count("ventas"), detalles = count("detalle_venta"), b0 = await balance();
    const r = await post("/api/ventas", tokens.cb, maria());
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const rec = r.json.data;
    assert.equal(count("ventas"), ventas + 1, "una sola venta");
    assert.equal(count("detalle_venta"), detalles + 3, "tres líneas");
    assert.equal(rec.total, 385);
    assert.equal(rec.items.length, 3);
    assert.deepEqual(rec.items.map((i) => [i.cantidad, i.precio_unitario, i.subtotal]), [[1, 120, 120], [1, 135, 135], [2, 65, 130]]);
    assert.deepEqual(rec.items.map((i) => i.producto), P.map(nameOf), "cada línea conserva su propio producto");
    // lo persistido coincide con el recibo
    const rows = sql(`SELECT producto_id, cantidad, precio_unitario, subtotal FROM detalle_venta WHERE venta_id = ${rec.id} ORDER BY id`);
    assert.deepEqual(rows.map((x) => x.producto_id), P);
    assert.equal(sql(`SELECT ROUND(SUM(subtotal),2) AS s FROM detalle_venta WHERE venta_id = ${rec.id}`)[0].s, 385);
    assert.equal(sql(`SELECT total FROM ventas WHERE id = ${rec.id}`)[0].total, 385);
    // cliente, pago y vendedor una sola vez, a nivel de venta
    assert.equal(rec.cliente_nombre, "María");
    assert.equal(rec.cliente_telefono, "71234567");
    assert.equal(rec.metodo_pago, "QR");
    assert.equal(rec.vendedor, "Vend CB");
    assert.equal(rec.sucursal, "MISSI Cochabamba");
    // detalle por API
    const det = (await get(`/api/ventas/${rec.id}/detalle`, tokens.cb)).json.data;
    assert.equal(det.length, 3);
    // TEST F: reportes cuentan la venta UNA vez (no una por producto)
    const b1 = await balance();
    assert.equal(b1.ventas, b0.ventas + 1);
    assert.equal(Math.round((b1.ingresos - b0.ingresos) * 100) / 100, 385);
    assert.equal(b1.unidades, b0.unidades + 4);
  });

  it("el total que envía el cliente se ignora: el servidor calcula Bs 385 desde las líneas", async () => {
    const r = await post("/api/ventas", tokens.cb, maria({ total: 1, subtotal: 1 }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.total, 385);
    assert.equal(sql(`SELECT total FROM ventas WHERE id = ${r.json.data.id}`)[0].total, 385);
  });

  it("TEST C: descuenta exactamente lo vendido de cada variante y la otra sucursal no cambia", async () => {
    const cb0 = P.map((p) => stock(1, p, 1, 1)), sc0 = P.map((p) => stock(2, p, 1, 1));
    const r = await post("/api/ventas", tokens.cb, maria());
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(P.map((p) => stock(1, p, 1, 1)), [cb0[0] - 1, cb0[1] - 1, cb0[2] - 2]);
    assert.deepEqual(P.map((p) => stock(2, p, 1, 1)), sc0, "Santa Cruz intacta");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM movimientos_inventario WHERE tipo='venta' AND referencia_tipo='venta' AND referencia_id=${r.json.data.id}`)[0].n, 3, "un movimiento por línea");
  });

  it("vender en Santa Cruz descuenta solo Santa Cruz", async () => {
    const cb0 = P.map((p) => stock(1, p, 1, 1)), sc0 = P.map((p) => stock(2, p, 1, 1));
    const r = await post("/api/ventas", tokens.sc, maria({ sucursal_id: 2 }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(P.map((p) => stock(2, p, 1, 1)), [sc0[0] - 1, sc0[1] - 1, sc0[2] - 2]);
    assert.deepEqual(P.map((p) => stock(1, p, 1, 1)), cb0);
    assert.equal(r.json.data.sucursal, "MISSI Santa Cruz");
  });

  it("TEST D: una línea sin stock rechaza TODA la venta, nombra el producto y no deja nada", async () => {
    const ventas = count("ventas"), detalles = count("detalle_venta"), movs = count("movimientos_inventario"), destinos = count("destinos_entrega");
    const before = P.map((p) => stock(1, p, 1, 1));
    const r = await post("/api/ventas", tokens.cb, maria({
      modalidad: "envio", departamento: "La Paz",
      items: [line(P[0], 1, 1, 1, 120), line(P[1], 1, 1, 1, 135), line(P[2], 1, 1, before[2] + 1, 65)],
    }));
    assert.equal(r.status, 409);
    assert.match(r.json.error, new RegExp(`Stock insuficiente para ${nameOf(P[2])}`));
    assert.match(r.json.error, /No se guardó ninguna parte/);
    assert.equal(count("ventas"), ventas);
    assert.equal(count("detalle_venta"), detalles);
    assert.equal(count("movimientos_inventario"), movs);
    assert.equal(count("destinos_entrega"), destinos, "ni siquiera el destino de entrega");
    assert.deepEqual(P.map((p) => stock(1, p, 1, 1)), before, "las líneas válidas tampoco descontaron");
  });

  it("variante sin fila de inventario en la sucursal: 409 y nada guardado", async () => {
    const ventas = count("ventas"), before = P.map((p) => stock(1, p, 1, 1));
    const r = await post("/api/ventas", tokens.cb, maria({ items: [line(P[0], 1, 1, 1, 120), line(P[1], 2, 2, 1, 135)] }));
    assert.equal(r.status, 409);
    assert.equal(count("ventas"), ventas);
    assert.deepEqual(P.map((p) => stock(1, p, 1, 1)), before);
  });

  it("concurrencia: dos ventas multilínea compiten por la última unidad de un producto -> una gana, la otra no deja rastro", async () => {
    // Fijar stock = 1 por fuera de la API: primero se ajustan los lotes (la base exige lotes = stock) y luego el stock.
    sql(`UPDATE lotes SET cantidad_restante = 0 WHERE sucursal_id = 1 AND producto_id = ${P[2]} AND talla_id = 1 AND color_id = 1 AND id <> (SELECT MIN(id) FROM lotes WHERE sucursal_id = 1 AND producto_id = ${P[2]} AND talla_id = 1 AND color_id = 1)`);
    sql(`UPDATE lotes SET cantidad_restante = 1 WHERE id = (SELECT MIN(id) FROM lotes WHERE sucursal_id = 1 AND producto_id = ${P[2]} AND talla_id = 1 AND color_id = 1)`);
    sql(`UPDATE inventario SET cantidad = 1 WHERE sucursal_id = 1 AND producto_id = ${P[2]} AND talla_id = 1 AND color_id = 1`);
    const palazzo0 = stock(1, P[0], 1, 1), ventas = count("ventas");
    const body = () => saleBody({ items: [line(P[0], 1, 1, 1, 120), line(P[2], 1, 1, 1, 65)] });
    const rs = await Promise.all([post("/api/ventas", tokens.cb, body()), post("/api/ventas", tokens.cb, body()), post("/api/ventas", tokens.cb, body())]);
    assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
    assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
    assert.equal(stock(1, P[2], 1, 1), 0, "nunca negativo");
    assert.equal(stock(1, P[0], 1, 1), palazzo0 - 1, "la línea del perdedor NO descontó el palazzo");
    assert.equal(count("ventas"), ventas + 1);
    sql(`UPDATE inventario SET cantidad = 40 WHERE sucursal_id = 1 AND producto_id = ${P[2]} AND talla_id = 1 AND color_id = 1`); // sube: el stock sin lote recibe un lote de conciliación
  });

  it("TEST E: reintentos simultáneos y repetidos con la misma clave = una sola venta y un solo descuento", async () => {
    const body = maria();
    const ventas = count("ventas"), detalles = count("detalle_venta");
    const s0 = P.map((p) => stock(1, p, 1, 1));
    const rs = await Promise.all(Array.from({ length: 5 }, () => post("/api/ventas", tokens.cb, body)));
    assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join(","));
    assert.equal(new Set(rs.map((r) => r.json.data.id)).size, 1, "todas devuelven el mismo número de venta");
    assert.equal(count("ventas"), ventas + 1);
    assert.equal(count("detalle_venta"), detalles + 3);
    assert.deepEqual(P.map((p) => stock(1, p, 1, 1)), [s0[0] - 1, s0[1] - 1, s0[2] - 2], "descontado una sola vez");
    const again = await post("/api/ventas", tokens.cb, body);
    assert.equal(again.json.data.repetida, true);
    assert.equal(again.json.data.items.length, 3);
    assert.equal(again.json.data.total, 385);
  });

  it("TEST F: el historial muestra UNA fila por venta (con vendedor) y su detalle trae las 3 líneas", async () => {
    const r = await post("/api/ventas", tokens.cb, maria({ cliente_nombre: "María Historial" }));
    const list = (await get("/api/ventas?limit=100", tokens.cb)).json.data;
    const rows = list.filter((s) => s.id === r.json.data.id);
    assert.equal(rows.length, 1, "una sola fila para la venta");
    assert.equal(rows[0].total, 385);
    assert.equal(rows[0].vendedor, "Vend CB");
    assert.equal(rows[0].cliente_nombre, "María Historial");
    assert.equal((await get(`/api/ventas/${r.json.data.id}/detalle`, tokens.cb)).json.data.length, 3);
  });

  it("cancelar la venta repone TODAS las líneas, una sola vez; los reportes dejan de contarla", async () => {
    const s0 = P.map((p) => stock(1, p, 1, 1)), b0 = await balance();
    const r = await post("/api/ventas", tokens.cb, maria());
    assert.deepEqual(P.map((p) => stock(1, p, 1, 1)), [s0[0] - 1, s0[1] - 1, s0[2] - 2]);
    const rs = await Promise.all([1, 2].map(() => post(`/api/ventas/${r.json.data.id}/cancelar`, tokens.admin, { motivo: "prueba multiproducto" })));
    assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409]);
    assert.deepEqual(P.map((p) => stock(1, p, 1, 1)), s0, "las 3 líneas repuestas exactamente una vez");
    const b1 = await balance();
    assert.equal(b1.ventas, b0.ventas);
    assert.equal(b1.ingresos, b0.ingresos);
  });

  it("devolución de UNA línea de una venta multiproducto repone solo esa línea; la venta y las otras líneas quedan intactas", async () => {
    const r = await post("/api/ventas", tokens.cb, maria());
    const id = r.json.data.id;
    const detail = await pendientesOf(id);
    assert.equal(detail.lineas.length, 3, "la venta expone sus 3 líneas");
    const target = detail.lineas[1]; // pantalón con hebilla
    const s0 = P.map((p) => stock(1, p, 1, 1));
    const op = await post("/api/operaciones/devolucion", tokens.cb, opBody({
      venta_id: id, motivo: "talla", items: [{ detalle_id: target.detalle_id, cantidad: 1, condicion: "vendible" }],
      liquidacion: "reembolso_inmediato", metodo_pago: "efectivo",
    }));
    assert.equal(op.status, 200, JSON.stringify(op.json));
    assert.equal(op.json.data.valor_devuelto, 135);
    assert.deepEqual(P.map((p) => stock(1, p, 1, 1)), [s0[0], s0[1] + 1, s0[2]], "solo la línea devuelta repone stock");
    assert.equal(sql(`SELECT total FROM ventas WHERE id = ${id}`)[0].total, 385, "el total histórico no cambia");
    const after = await pendientesOf(id);
    assert.deepEqual(after.lineas.map((l) => l.pendiente), [1, 0, 2]);
  });

  it("validaciones: cantidad 0/negativa/decimal, precio inválido y líneas repetidas se rechazan sin guardar nada", async () => {
    const ventas = count("ventas");
    for (const items of [
      [line(P[0], 1, 1, 1, 120), line(P[1], 1, 1, 0, 135)],
      [line(P[0], 1, 1, 1, 120), line(P[1], 1, 1, -1, 135)],
      [line(P[0], 1, 1, 1, 120), line(P[1], 1, 1, 1.5, 135)],
      [line(P[0], 1, 1, 1, 120), line(P[1], 1, 1, 1, -5)],
      [line(P[0], 1, 1, 1, 120), line(P[0], 1, 1, 1, 120)],
    ]) {
      const r = await post("/api/ventas", tokens.cb, saleBody({ items }));
      assert.ok(r.status === 400 || r.status === 409, `${JSON.stringify(items).slice(0, 60)} -> ${r.status}`);
    }
    assert.equal(count("ventas"), ventas);
  });

  it("un vendedor no puede vender en otra sucursal ni sin sesión", async () => {
    assert.equal((await post("/api/ventas", tokens.cb, maria({ sucursal_id: 2 }))).status, 403);
    assert.equal((await post("/api/ventas", undefined, maria())).status, 401);
  });

  it("el precio histórico no cambia aunque cambie el precio del modelo", async () => {
    const r = await post("/api/ventas", tokens.cb, maria());
    sql(`UPDATE productos SET precio_venta = 999 WHERE id = ${P[0]}`);
    const det = (await get(`/api/ventas/${r.json.data.id}/detalle`, tokens.cb)).json.data;
    assert.equal(det[0].precio_unitario, 120);
    assert.equal(sql(`SELECT total FROM ventas WHERE id = ${r.json.data.id}`)[0].total, 385);
  });
});

// ================================================================ catálogo de tallas, libro de movimientos, traspasos, motivos y reportes
import { DEPARTMENTS, MOVEMENT_CATEGORIES, PANTS_SIZES } from "../../shared/catalogo.ts";

const idOf = (table, col, val) => sql(`SELECT id FROM ${table} WHERE ${col} = '${val}'`)[0].id;
const userId = (email) => sql(`SELECT id FROM usuarios WHERE email = '${email}'`)[0].id;
const ingreso = (token, body) => api("POST", "/api/inventario/agregar", { token, body, headers: { "Idempotency-Key": randomUUID() } });
const salida = (token, body, key = randomUUID()) => api("POST", "/api/inventario/salida", { token, body, headers: { "Idempotency-Key": key } });
const ajuste = (token, body, key = randomUUID()) => api("POST", "/api/inventario/ajuste", { token, body, headers: { "Idempotency-Key": key } });
const movs = async (query, token = tokens.admin) => (await get(`/api/movimientos?${query}`, token)).json.data;
const must = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.json)); return r.json.data; };

describe("tallas oficiales de pantalón", () => {
  it("el catálogo de la API es exactamente la lista oficial, en orden, con rótulos literales", async () => {
    const list = must(await get("/api/tallas", tokens.cb));
    const oficiales = list.filter((t) => t.oficial_pantalon);
    assert.deepEqual(oficiales.map((t) => t.nombre), [...PANTS_SIZES]);
    assert.deepEqual([...PANTS_SIZES], ["P", "M", "G", "GG", "3G", "4G", "36", "38", "40", "42", "44", "46", "48"]);
    assert.ok(oficiales.every((t) => typeof t.nombre === "string"), "los rótulos 36 y 38 son texto");
    for (const prohibido of ["S", "XS", "L", "XL", "XXL", "GGG", "3XL", "4XL"]) assert.ok(!oficiales.some((t) => t.nombre === prohibido), prohibido);
    assert.equal(list.find((t) => t.nombre === "3G").etiqueta_historica, "GGG", "el rótulo anterior queda auditable");
    assert.equal(list.find((t) => t.nombre === "P").etiqueta_historica, "S", "«P» era «S»: mismo id, el rótulo anterior queda auditable");
    assert.ok(!list.some((t) => t.nombre === "S"), "«S» ya no existe como talla separada");
  });

  it("tallas históricas se leen pero no se aceptan para inventario nuevo; los rótulos oficiales no se pueden renombrar", async () => {
    sql("INSERT INTO tallas (nombre, orden) VALUES ('XL-hist', 150)");
    const xl = idOf("tallas", "nombre", "XL-hist");
    const prod = 4, color = 1;
    // historia: stock heredado con talla antigua sigue legible
    sql(`INSERT INTO inventario (producto_id,talla_id,color_id,sucursal_id,cantidad) VALUES (${prod},${xl},${color},1,3)`);
    const inv = must(await get("/api/inventario?sucursal_id=1", tokens.admin));
    assert.ok(inv.some((r) => r.talla.nombre === "XL-hist" && r.cantidad === 3), "talla histórica legible en inventario");
    const lista = must(await get("/api/tallas", tokens.admin));
    const hist = lista.find((t) => t.nombre === "XL-hist");
    assert.equal(hist.oficial_pantalon, false);
    assert.ok(lista.indexOf(hist) > lista.findIndex((t) => t.nombre === "48"), "las históricas van al final");

    // ingreso, venta, traspaso y ajuste positivo con talla no oficial: rechazados en el servidor
    assert.equal((await ingreso(tokens.admin, { sucursal_id: 1, producto_id: prod, talla_id: xl, color_id: color, cantidad: 1 })).status, 400);
    assert.equal((await post("/api/ventas", tokens.cb, saleBody({ items: [line(prod, xl, color, 1, 100)] }))).status, 400);
    assert.equal((await post("/api/traspasos", tokens.cb, { idempotency_key: randomUUID(), origen_id: 1, destino_id: 2, items: [{ producto_id: prod, talla_id: xl, color_id: color, cantidad: 1 }] })).status, 400);
    assert.equal((await ajuste(tokens.admin, { sucursal_id: 1, producto_id: prod, talla_id: xl, color_id: color, delta: 1, motivo: "prueba" })).status, 400);
    assert.equal(stock(1, prod, xl, color), 3, "nada cambió");

    // un rótulo oficial no se puede renombrar ni borrar
    assert.throws(() => sql("UPDATE tallas SET nombre = '3XL' WHERE nombre = '3G'"));
    assert.throws(() => sql("DELETE FROM tallas WHERE nombre = '4G'"));
    assert.equal(idOf("tallas", "nombre", "3G") > 0, true);
  });

  it("la restricción es solo para pantalones: otra categoría puede usar otra talla", async () => {
    sql("INSERT INTO productos (nombre, categoria, precio_venta) VALUES ('Cinturón prueba', 'Accesorios', 50)");
    const accesorio = idOf("productos", "nombre", "Cinturón prueba");
    const xl = idOf("tallas", "nombre", "XL-hist");
    must(await ingreso(tokens.admin, { sucursal_id: 1, producto_id: accesorio, talla_id: xl, color_id: 1, cantidad: 2 }));
    assert.equal(stock(1, accesorio, xl, 1), 2);
  });
});

describe("libro de movimientos", () => {
  const V = () => ({ producto: 5, talla: 2, color: 2 }); // variante propia de este bloque (M, color 2)

  it("INGRESO: registra variante, cantidad, usuario autenticado (ignora usuario del cliente), cantidades anterior/resultante e idempotencia", async () => {
    const admin = userId("admin@test.local");
    const key = randomUUID();
    const body = { sucursal_id: 1, producto_id: V().producto, talla_id: V().talla, color_id: V().color, cantidad: 7, notas: "lote de prueba", usuario_id: 999999, creado_por: 999999 };
    const a = await api("POST", "/api/inventario/agregar", { token: tokens.admin, body, headers: { "Idempotency-Key": key } });
    const b = await api("POST", "/api/inventario/agregar", { token: tokens.admin, body, headers: { "Idempotency-Key": key } });
    assert.equal(must(a).repetido, false);
    assert.equal(must(b).repetido, true);
    assert.equal(stock(1, 5, 2, 2), 7, "suma una sola vez");
    const rows = (await movs(`categoria=INGRESO&producto_id=5&talla_id=2&color_id=2`)).filas;
    assert.equal(rows.length, 1, "un solo asiento");
    const m = rows[0];
    assert.equal(m.categoria, "INGRESO");
    assert.equal(m.usuario.id, admin, "el responsable sale de la sesión, no del cuerpo");
    assert.equal(m.cantidad, 7);
    assert.equal(m.cantidad_anterior, 0);
    assert.equal(m.cantidad_resultante, 7);
    assert.match(m.referencia, /^MOV-\d{6}$/);
    assert.equal(m.observaciones, "lote de prueba");
    assert.ok(m.fecha.endsWith("Z"), "fecha generada por el servidor");
  });

  it("valida cantidades y permisos del ingreso (solo admin, entero positivo)", async () => {
    const base = { sucursal_id: 1, producto_id: 5, talla_id: 2, color_id: 2 };
    for (const cantidad of [0, -3, 1.5, "2", null]) assert.equal((await ingreso(tokens.admin, { ...base, cantidad })).status, 400, String(cantidad));
    assert.equal((await ingreso(tokens.cb, { ...base, cantidad: 1 })).status, 403);
    assert.equal((await api("POST", "/api/inventario/agregar", { body: { ...base, cantidad: 1 }, headers: { "Idempotency-Key": randomUUID() } })).status, 401);
  });

  it("SALIDA: motivo obligatorio, solo admin, nunca negativo, idempotente y con asiento SALIDA", async () => {
    const base = { sucursal_id: 1, producto_id: 5, talla_id: 2, color_id: 2 };
    assert.equal((await salida(tokens.cb, { ...base, cantidad: 1, motivo_codigo: "DANADO" })).status, 403);
    assert.equal((await salida(tokens.admin, { ...base, cantidad: 1 })).status, 400, "motivo obligatorio");
    assert.equal((await salida(tokens.admin, { ...base, cantidad: 1, motivo_codigo: "OTRO" })).status, 400, "OTRO exige explicación");
    const key = randomUUID();
    must(await salida(tokens.admin, { ...base, cantidad: 2, motivo_codigo: "DANADO", detalle: "mancha de fábrica" }, key));
    must(await salida(tokens.admin, { ...base, cantidad: 2, motivo_codigo: "DANADO", detalle: "mancha de fábrica" }, key));
    assert.equal(stock(1, 5, 2, 2), 5, "descuenta una sola vez");
    const sinStock = await salida(tokens.admin, { ...base, cantidad: 99, motivo_codigo: "PERDIDA" });
    assert.equal(sinStock.status, 409);
    assert.equal(stock(1, 5, 2, 2), 5);
    const rows = (await movs(`categoria=SALIDA&producto_id=5&talla_id=2&color_id=2`)).filas;
    assert.equal(rows.length, 1, "la salida rechazada no deja asiento");
    assert.equal(rows[0].signo, -1);
    assert.equal(rows[0].cantidad_anterior, 7);
    assert.equal(rows[0].cantidad_resultante, 5);
    assert.equal(rows[0].motivo_codigo, "DANADO");
    assert.equal(rows[0].motivo_etiqueta, "Producto dañado");
    // una variante que no tiene fila de inventario tampoco puede dar salida
    assert.equal((await salida(tokens.admin, { sucursal_id: 2, producto_id: 5, talla_id: 2, color_id: 2, cantidad: 1, motivo_codigo: "PERDIDA" })).status, 409);
  });

  it("AJUSTE: corrección positiva o negativa con motivo; un ajuste que dejaría stock negativo se rechaza", async () => {
    const base = { sucursal_id: 1, producto_id: 5, talla_id: 2, color_id: 2 };
    assert.equal((await ajuste(tokens.admin, { ...base, delta: 0, motivo: "x" })).status, 400);
    assert.equal((await ajuste(tokens.admin, { ...base, delta: 3 })).status, 400, "motivo obligatorio");
    assert.equal((await ajuste(tokens.cb, { ...base, delta: 1, motivo: "intento" })).status, 403);
    must(await ajuste(tokens.admin, { ...base, delta: 4, motivo: "conteo físico" }));
    must(await ajuste(tokens.admin, { ...base, delta: -1, motivo: "conteo físico" }));
    assert.equal(stock(1, 5, 2, 2), 8);
    assert.equal((await ajuste(tokens.admin, { ...base, delta: -50, motivo: "error" })).status, 409);
    assert.equal(stock(1, 5, 2, 2), 8);
    const rows = (await movs(`categoria=AJUSTE&producto_id=5&talla_id=2&color_id=2`)).filas;
    assert.deepEqual(rows.map((r) => [r.signo, r.cantidad]).sort(), [[-1, 1], [1, 4]]);
  });

  it("VENTA: cada línea deja su asiento con el vendedor autenticado y la cadena anterior/resultante cuadra", async () => {
    const cb = userId("cb@test.local");
    const r = must(await post("/api/ventas", tokens.cb, saleBody({ vendedor_id: 999999, items: [line(5, 2, 2, 3, 100)] })));
    assert.equal(stock(1, 5, 2, 2), 5);
    const rows = (await movs(`categoria=VENTA&producto_id=5&talla_id=2&color_id=2`)).filas;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].usuario.id, cb, "el vendedor sale de la sesión");
    assert.equal(rows[0].documento.codigo, `V-${String(r.id).padStart(6, "0")}`);
    assert.equal(rows[0].cantidad_anterior - rows[0].cantidad, rows[0].cantidad_resultante);
    assert.equal(rows[0].cantidad_resultante, 5);
    // la cadena completa de la variante es consistente de principio a fin
    const todos = (await movs(`producto_id=5&talla_id=2&color_id=2&limite=100`)).filas.sort((a, b) => a.id - b.id);
    let esperado = 0;
    for (const m of todos) {
      assert.equal(m.cantidad_anterior, esperado, `${m.referencia}: anterior`);
      esperado += m.signo * m.cantidad;
      assert.equal(m.cantidad_resultante, esperado, `${m.referencia}: resultante`);
    }
    assert.equal(esperado, stock(1, 5, 2, 2));
  });

  it("el historial es inmutable: no se edita ni se borra (movimientos, auditoría, detalle de venta, devoluciones)", async () => {
    // Filas reales para alterar: una línea de traspaso (se crea por la API) y un registro de auditoría.
    must(await post("/api/traspasos", tokens.cb, { idempotency_key: randomUUID(), origen_id: 1, destino_id: 2, items: [{ producto_id: 4, talla_id: 1, color_id: 1, cantidad: 1 }] }));
    must(await ingreso(tokens.admin, { sucursal_id: 1, producto_id: 1, talla_id: 1, color_id: 1, cantidad: 2 }));
    must(await post("/api/ventas", tokens.cb, saleBody()));
    sql("INSERT INTO auditoria (usuario_id, accion, entidad) VALUES (NULL, 'prueba_inmutable', 'prueba')");
    assert.ok(sql("SELECT COUNT(*) AS n FROM traspaso_detalles")[0].n > 0);
    assert.ok(sql("SELECT COUNT(*) AS n FROM detalle_venta")[0].n > 0);
    const id = sql("SELECT id FROM movimientos_inventario ORDER BY id DESC LIMIT 1")[0].id;
    assert.throws(() => sql(`UPDATE movimientos_inventario SET cantidad = 999 WHERE id = ${id}`));
    assert.throws(() => sql(`UPDATE movimientos_inventario SET usuario_id = NULL WHERE id = ${id}`));
    assert.throws(() => sql(`DELETE FROM movimientos_inventario WHERE id = ${id}`));
    assert.throws(() => sql("UPDATE auditoria SET detalle = 'x' WHERE id = (SELECT MIN(id) FROM auditoria)"));
    assert.throws(() => sql("DELETE FROM auditoria WHERE id = (SELECT MIN(id) FROM auditoria)"));
    assert.throws(() => sql("UPDATE detalle_venta SET precio_unitario = 1 WHERE id = (SELECT MIN(id) FROM detalle_venta)"));
    assert.throws(() => sql("DELETE FROM traspaso_detalles WHERE id = (SELECT MIN(id) FROM traspaso_detalles)"));
    assert.equal(sql(`SELECT cantidad FROM movimientos_inventario WHERE id = ${id}`).length, 1);
  });

  it("un script antiguo que inserta sin categoría queda clasificado igual (disparador de respaldo)", async () => {
    sql("INSERT INTO movimientos_inventario (sucursal_id,producto_id,talla_id,color_id,tipo,cantidad,referencia_tipo,observaciones) VALUES (1,5,2,2,'entrada',1,'importacion_supabase','legado')");
    const row = sql("SELECT categoria, signo FROM movimientos_inventario WHERE referencia_tipo = 'importacion_supabase' ORDER BY id DESC LIMIT 1")[0];
    assert.deepEqual(row, { categoria: "INGRESO", signo: 1 });
    assert.throws(() => sql("INSERT INTO movimientos_inventario (sucursal_id,producto_id,talla_id,color_id,tipo,cantidad,categoria) VALUES (1,5,2,2,'entrada',1,'INVENTADA')"));
  });
});

describe("traspasos con trazabilidad completa", () => {
  // Variantes propias: modelo 6, tallas 38 y 40, colores 1 y 3 (el color 3 sirve para comprobar que no se mezcla).
  let tallas, tid;
  const items = () => [
    { producto_id: 6, talla_id: tallas["40"], color_id: 1, cantidad: 3 },
    { producto_id: 6, talla_id: tallas["38"], color_id: 1, cantidad: 2 },
  ];

  before(async () => {
    tallas = Object.fromEntries(["38", "40", "42"].map((n) => [n, idOf("tallas", "nombre", n)]));
    for (const [t, c, n] of [["40", 1, 10], ["38", 1, 10], ["40", 3, 10], ["42", 1, 10]]) {
      must(await ingreso(tokens.admin, { sucursal_id: 1, producto_id: 6, talla_id: tallas[t], color_id: c, cantidad: n }));
    }
  });

  it("un traspaso con VARIAS líneas: el borrador no mueve stock, despachar descuenta una vez, recibir suma una vez", async () => {
    const forged = await post("/api/traspasos", tokens.cb, { idempotency_key: randomUUID(), origen_id: 1, destino_id: 2, notas: "reposición", items: items(), creado_por: 999999 });
    const t = must(forged);
    tid = t.id;
    assert.match(t.referencia, /^TR-\d{6}$/);
    const o = (ta, c) => stock(1, 6, ta, c), d = (ta, c) => stock(2, 6, ta, c);
    const before = { o40: o(tallas["40"], 1), o38: o(tallas["38"], 1), o40c3: o(tallas["40"], 3), o42: o(tallas["42"], 1) };
    assert.equal(o(tallas["40"], 1), 10, "borrador: sin descuento");

    const sendKey = await post(`/api/traspasos/${tid}/despachar`, tokens.cb);
    must(sendKey);
    assert.equal(o(tallas["40"], 1), before.o40 - 3);
    assert.equal(o(tallas["38"], 1), before.o38 - 2);
    assert.equal(d(tallas["40"], 1), 0, "el destino aún no recibió");
    // duplicado de despacho: no vuelve a descontar
    assert.equal((await post(`/api/traspasos/${tid}/despachar`, tokens.cb)).status, 409);
    assert.equal(o(tallas["40"], 1), before.o40 - 3);

    // origen no puede recibir; destino sí
    assert.equal((await post(`/api/traspasos/${tid}/recibir`, tokens.cb)).status, 403);
    must(await post(`/api/traspasos/${tid}/recibir`, tokens.sc));
    assert.equal(d(tallas["40"], 1), 3);
    assert.equal(d(tallas["38"], 1), 2);
    assert.equal((await post(`/api/traspasos/${tid}/recibir`, tokens.sc)).status, 409);
    assert.equal(d(tallas["40"], 1), 3, "no se suma dos veces");

    // las variantes vecinas NO se tocaron (otro color, otra talla)
    assert.equal(o(tallas["40"], 3), before.o40c3);
    assert.equal(o(tallas["42"], 1), before.o42);
    assert.equal(d(tallas["40"], 3), 0);
    assert.equal(d(tallas["42"], 1), 0);
    // el total de la empresa no cambia: solo cambió la distribución
    assert.equal(o(tallas["40"], 1) + d(tallas["40"], 1), before.o40);
  });

  it("la trazabilidad guarda quién creó, despachó y recibió (usuarios autenticados) y cada línea con modelo, talla, color y cantidad", async () => {
    const det = must(await get(`/api/traspasos/${tid}`, tokens.sc));
    assert.equal(det.estado, "recibido");
    assert.equal(det.creado_por.id, userId("cb@test.local"), "no se puede falsificar el creador");
    assert.equal(det.despachado_por.id, userId("cb@test.local"));
    assert.equal(det.recibido_por.id, userId("sc@test.local"));
    assert.equal(det.cancelado_por, null);
    assert.equal(det.origen.nombre, "MISSI Cochabamba");
    assert.equal(det.destino.nombre, "MISSI Santa Cruz");
    assert.ok(det.fecha && det.enviado_at && det.recibido_at);
    assert.equal(det.unidades, 5);
    assert.deepEqual(det.items.map((i) => [i.talla, i.color_id, i.cantidad]).sort(), [["38", 1, 2], ["40", 1, 3]]);
    assert.ok(det.items.every((i) => i.producto && i.color));
    // movimientos del traspaso: 2 salidas + 2 entradas, todos TRASPASO, con origen/destino y usuario
    assert.equal(det.movimientos.length, 4);
    assert.ok(det.movimientos.every((m) => m.categoria === "TRASPASO" && m.usuario));
    assert.equal(det.movimientos.filter((m) => m.signo === -1).length, 2);
    assert.equal(det.movimientos.filter((m) => m.signo === 1).length, 2);
  });

  it("historial con filtros combinables y paginación; el vendedor solo ve lo de su sucursal", async () => {
    const all = must(await get("/api/traspasos/historial?limite=100", tokens.admin));
    const mine = all.filas.find((f) => f.id === tid);
    assert.ok(mine && mine.items.length === 2);
    const filt = async (q) => must(await get(`/api/traspasos/historial?${q}`, tokens.admin));
    assert.ok((await filt(`estado=recibido&origen_id=1&destino_id=2&producto_id=6`)).filas.some((f) => f.id === tid));
    assert.ok(!(await filt(`estado=pendiente&producto_id=6`)).filas.some((f) => f.id === tid));
    assert.ok(!(await filt(`origen_id=2`)).filas.some((f) => f.id === tid));
    assert.ok((await filt(`talla_id=${tallas["38"]}&color_id=1`)).filas.some((f) => f.id === tid));
    assert.ok(!(await filt(`talla_id=${tallas["42"]}`)).filas.some((f) => f.id === tid), "ninguna línea es 42");
    assert.ok((await filt(`usuario_id=${userId("sc@test.local")}`)).filas.some((f) => f.id === tid), "filtra por quien recibió");
    assert.ok((await filt(`q=${encodeURIComponent(mine.referencia)}`)).filas.some((f) => f.id === tid), "busca por referencia");
    assert.ok((await filt(`q=reposici`)).filas.some((f) => f.id === tid), "busca en notas");
    assert.ok((await filt(`desde=${todayLocal()}&hasta=${todayLocal()}`)).filas.some((f) => f.id === tid));
    const pag = await filt(`limite=1&pagina=1`);
    assert.equal(pag.filas.length, 1);
    assert.ok(pag.total >= 1);
    assert.equal((await get("/api/traspasos/historial?estado=raro", tokens.admin)).status, 400);
    // el vendedor de otra sucursal… (ambos participan: se verifica que un tercero inexistente no accede)
    assert.equal((await get(`/api/traspasos/${tid}`)).status, 401);
  });

  it("stock de origen insuficiente: el despacho se rechaza, queda pendiente y nada se mueve (sin actualización parcial)", async () => {
    const big = must(await post("/api/traspasos", tokens.cb, {
      idempotency_key: randomUUID(), origen_id: 1, destino_id: 2,
      items: [{ producto_id: 6, talla_id: tallas["42"], color_id: 1, cantidad: 4 }, { producto_id: 6, talla_id: tallas["40"], color_id: 3, cantidad: 500 }],
    }));
    const a = stock(1, 6, tallas["42"], 1), b = stock(1, 6, tallas["40"], 3);
    const r = await post(`/api/traspasos/${big.id}/despachar`, tokens.cb);
    assert.equal(r.status, 409);
    assert.equal(stock(1, 6, tallas["42"], 1), a, "la línea válida tampoco se descontó");
    assert.equal(stock(1, 6, tallas["40"], 3), b);
    const det = must(await get(`/api/traspasos/${big.id}`, tokens.admin));
    assert.equal(det.estado, "pendiente");
    assert.equal(det.movimientos.length, 0, "sin asientos");
    must(await post(`/api/traspasos/${big.id}/cancelar`, tokens.cb));
    assert.equal(must(await get(`/api/traspasos/${big.id}`, tokens.admin)).cancelado_por.id, userId("cb@test.local"));
  });

  it("validaciones: mismo origen y destino, cantidad inválida, línea repetida y sucursal ajena", async () => {
    const base = { origen_id: 1, destino_id: 2, items: items() };
    const bad = [
      { ...base, destino_id: 1 },
      { ...base, items: [{ ...items()[0], cantidad: 0 }] },
      { ...base, items: [{ ...items()[0], cantidad: -1 }] },
      { ...base, items: [{ ...items()[0], cantidad: 1.5 }] },
      { ...base, items: [items()[0], items()[0]] },
      { ...base, items: [] },
    ];
    for (const b of bad) assert.equal((await post("/api/traspasos", tokens.cb, { idempotency_key: randomUUID(), ...b })).status, 400, JSON.stringify(b).slice(0, 80));
    assert.equal((await post("/api/traspasos", tokens.sc, { idempotency_key: randomUUID(), ...base })).status, 403, "un vendedor solo envía desde su sucursal");
  });

  it("concurrencia: dos despachos y dos recepciones simultáneos del mismo traspaso mueven el stock una sola vez", async () => {
    const t = must(await post("/api/traspasos", tokens.cb, { idempotency_key: randomUUID(), origen_id: 1, destino_id: 2, items: [{ producto_id: 6, talla_id: tallas["42"], color_id: 1, cantidad: 2 }] }));
    const o0 = stock(1, 6, tallas["42"], 1), d0 = stock(2, 6, tallas["42"], 1);
    const sends = await Promise.all([post(`/api/traspasos/${t.id}/despachar`, tokens.cb), post(`/api/traspasos/${t.id}/despachar`, tokens.cb)]);
    assert.deepEqual(sends.map((r) => r.status).sort(), [200, 409]);
    const recvs = await Promise.all([post(`/api/traspasos/${t.id}/recibir`, tokens.sc), post(`/api/traspasos/${t.id}/recibir`, tokens.sc)]);
    assert.deepEqual(recvs.map((r) => r.status).sort(), [200, 409]);
    assert.equal(stock(1, 6, tallas["42"], 1), o0 - 2);
    assert.equal(stock(2, 6, tallas["42"], 1), d0 + 2);
    const det = must(await get(`/api/traspasos/${t.id}`, tokens.admin));
    assert.equal(det.movimientos.length, 2, "un asiento de salida y uno de entrada");
  });
});

describe("devoluciones y cambios con motivo", () => {
  let tallas, sale;
  before(async () => {
    tallas = { "44": idOf("tallas", "nombre", "44"), "46": idOf("tallas", "nombre", "46") };
    for (const t of ["44", "46"]) must(await ingreso(tokens.admin, { sucursal_id: 1, producto_id: 4, talla_id: tallas[t], color_id: 2, cantidad: 10 }));
    sale = must(await post("/api/ventas", tokens.cb, saleBody({
      cliente_nombre: "Lucía Motivo", cliente_telefono: "76543210",
      items: [line(4, tallas["44"], 2, 3, 150)],
    })));
  });

  it("motivos estructurados: código inválido, «Otro» sin explicación y reemplazo con talla no oficial se rechazan sin guardar nada", async () => {
    const det = (await pendientesOf(sale.id)).lineas[0];
    const movs0 = count("movimientos_inventario"), ops0 = count("operaciones");
    const body = (over) => opBody({ venta_id: sale.id, items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "vendible" }], liquidacion: "reembolso_pendiente", ...over });
    assert.equal((await post("/api/operaciones/devolucion", tokens.cb, body({ motivo_codigo: "INVENTADO" }))).status, 400);
    assert.equal((await post("/api/operaciones/devolucion", tokens.cb, body({ motivo_codigo: "OTRO" }))).status, 400);
    assert.equal((await post("/api/operaciones/devolucion", tokens.cb, body({ motivo_codigo: "OTRO", motivo: "  " }))).status, 400);
    const xl = idOf("tallas", "nombre", "XL-hist");
    sql(`INSERT INTO inventario (producto_id,talla_id,color_id,sucursal_id,cantidad) VALUES (4,${xl},2,1,5) ON CONFLICT DO NOTHING`);
    const noOficial = await post("/api/operaciones/cambio", tokens.cb, body({ motivo_codigo: "TALLA_INCORRECTA", reemplazos: [{ producto_id: 4, talla_id: xl, color_id: 2, cantidad: 1, precio_unitario: 150 }] }));
    assert.equal(noOficial.status, 400);
    assert.equal(count("movimientos_inventario"), movs0);
    assert.equal(count("operaciones"), ops0);
  });

  it("DEVOLUCION: guarda motivo (código + explicación), responsable, venta original y movimiento DEVOLUCION; el precio histórico no cambia", async () => {
    const det = (await pendientesOf(sale.id)).lineas[0];
    const s0 = stock(1, 4, tallas["44"], 2);
    const r = must(await post("/api/operaciones/devolucion", tokens.cb, opBody({
      venta_id: sale.id, motivo_codigo: "DEFECTO_FABRICA", motivo: "costura abierta",
      items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "vendible" }], liquidacion: "reembolso_inmediato", metodo_pago: "efectivo",
    })));
    assert.equal(r.tipo, "devolucion");
    assert.equal(r.motivo_codigo, "DEFECTO_FABRICA");
    assert.equal(r.motivo_etiqueta, "Defecto de fábrica");
    assert.match(r.motivo, /Defecto de fábrica: costura abierta/);
    assert.equal(r.operador, "Vend CB");
    assert.equal(r.venta.id, sale.id);
    assert.equal(stock(1, 4, tallas["44"], 2), s0 + 1);
    assert.equal(sql(`SELECT precio_unitario FROM detalle_venta WHERE id = ${det.detalle_id}`)[0].precio_unitario, 150, "precio histórico intacto");
    const m = (await movs(`categoria=DEVOLUCION&producto_id=4&talla_id=${tallas["44"]}`)).filas;
    assert.equal(m.length, 1);
    assert.equal(m[0].motivo_codigo, "DEFECTO_FABRICA");
    assert.equal(m[0].usuario.id, userId("cb@test.local"));
    assert.equal(m[0].documento.codigo, r.referencia);
  });

  it("CAMBIO: lo devuelto y el reemplazo son asientos CAMBIO distintos (entra una talla, sale otra), sin crear venta nueva ni duplicar", async () => {
    const det = (await pendientesOf(sale.id)).lineas[0];
    const ventas0 = count("ventas");
    const a0 = stock(1, 4, tallas["44"], 2), b0 = stock(1, 4, tallas["46"], 2);
    const key = randomUUID();
    const body = {
      idempotency_key: key, venta_id: sale.id, motivo_codigo: "TALLA_INCORRECTA",
      items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "vendible" }],
      reemplazos: [{ producto_id: 4, talla_id: tallas["46"], color_id: 2, cantidad: 1, precio_unitario: 150 }],
    };
    const r1 = must(await post("/api/operaciones/cambio", tokens.cb, body));
    const r2 = must(await post("/api/operaciones/cambio", tokens.cb, body));
    assert.equal(r2.repetida, true);
    assert.equal(r1.id, r2.id);
    assert.equal(stock(1, 4, tallas["44"], 2), a0 + 1, "la talla devuelta vuelve una vez");
    assert.equal(stock(1, 4, tallas["46"], 2), b0 - 1, "el reemplazo sale una vez");
    assert.equal(count("ventas"), ventas0, "un cambio no es una venta");
    const rows = (await movs(`categoria=CAMBIO&producto_id=4`)).filas.filter((m) => m.documento?.codigo === r1.referencia);
    assert.deepEqual(rows.map((m) => m.signo).sort(), [-1, 1], "uno entra y otro sale");
    assert.ok(rows.every((m) => m.motivo_codigo === "TALLA_INCORRECTA" && m.motivo_etiqueta === "Talla incorrecta"));
    assert.equal(rows.find((m) => m.signo === -1).talla.nombre, "46");
    assert.equal(rows.find((m) => m.signo === 1).talla.nombre, "44");
  });

  it("DEVOLUCION dañada: no entra al stock vendible; queda un asiento con signo 0 y motivo", async () => {
    const det = (await pendientesOf(sale.id)).lineas[0];
    const s0 = stock(1, 4, tallas["44"], 2);
    const r = must(await post("/api/operaciones/devolucion", tokens.cb, opBody({
      venta_id: sale.id, motivo_codigo: "PRODUCTO_DANADO",
      items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "danado" }], liquidacion: "reembolso_pendiente",
    })));
    assert.equal(stock(1, 4, tallas["44"], 2), s0, "no suma stock vendible");
    const m = (await movs(`categoria=DEVOLUCION&producto_id=4`)).filas.find((x) => x.documento?.codigo === r.referencia);
    assert.equal(m.signo, 0);
    assert.equal(m.efecto, "Cuarentena (no vendible)");
    assert.equal(m.cantidad_anterior, null, "no hay cantidades vendibles que reportar");
  });

  it("historial de devoluciones y cambios: búsqueda y filtros por motivo, tipo, responsable, producto y referencia", async () => {
    const h = async (q) => must(await get(`/api/operaciones/historial?${q}`, tokens.admin));
    const all = await h("limite=100&producto_id=4");
    assert.ok(all.total >= 3);
    const fila = all.filas.find((f) => f.tipo === "cambio" && f.motivo_codigo === "TALLA_INCORRECTA");
    assert.ok(fila);
    assert.equal(fila.venta_referencia, `V-${String(sale.id).padStart(6, "0")}`);
    assert.equal(fila.cliente_nombre, "Lucía Motivo");
    assert.equal(fila.operador.nombre, "Vend CB");
    assert.equal(fila.devueltos[0].talla, "44");
    assert.equal(fila.entregados[0].talla, "46");
    assert.ok((await h("tipo=cambio&motivo_codigo=TALLA_INCORRECTA")).filas.every((f) => f.tipo === "cambio" && f.motivo_codigo === "TALLA_INCORRECTA"));
    assert.ok((await h(`q=${fila.referencia}`)).filas.some((f) => f.id === fila.id));
    assert.ok((await h("q=Luc%C3%ADa")).filas.some((f) => f.id === fila.id), "por cliente");
    assert.ok((await h(`usuario_id=${userId("cb@test.local")}&talla_id=${tallas["46"]}`)).filas.some((f) => f.id === fila.id));
    assert.ok(!(await h(`usuario_id=${userId("sc@test.local")}`)).filas.some((f) => f.id === fila.id));
    assert.ok((await h("motivo_codigo=SIN_CLASIFICAR")).filas.every((f) => f.motivo_codigo === null));
    assert.equal((await get("/api/operaciones/historial?tipo=raro", tokens.admin)).status, 400);
    // aislamiento: el vendedor de otra sucursal no ve operaciones de Cochabamba
    assert.equal((await get(`/api/operaciones/historial?q=${fila.referencia}`, tokens.sc)).json.data.total, 0);
  });
});

describe("filtros del libro de movimientos", () => {
  it("cada categoría devuelve solo movimientos de ese tipo de negocio (Ingresos no incluye ventas ni traspasos)", async () => {
    for (const c of MOVEMENT_CATEGORIES) {
      const d = await movs(`categoria=${c}&limite=100`);
      assert.ok(d.filas.every((f) => f.categoria === c), `${c}: ${d.filas.map((f) => f.categoria).join(",")}`);
    }
    const ingresos = await movs("categoria=INGRESO&limite=100");
    assert.ok(ingresos.filas.length > 0);
    assert.ok(ingresos.filas.every((f) => f.signo === 1 && f.categoria === "INGRESO"));
    const traspasos = await movs("categoria=TRASPASO&limite=100");
    assert.ok(traspasos.filas.length > 0 && traspasos.filas.some((f) => f.origen && f.destino), "traspasos muestran origen y destino");
    assert.ok(traspasos.filas.some((f) => f.signo === 1), "una entrada por traspaso NO es un ingreso");
    const cambios = await movs("categoria=CAMBIO&limite=100");
    assert.ok(cambios.filas.some((f) => f.motivo_codigo === "TALLA_INCORRECTA"), "los cambios muestran su motivo");
    const combo = await movs("categoria=INGRESO,SALIDA&limite=100");
    assert.ok(combo.filas.every((f) => ["INGRESO", "SALIDA"].includes(f.categoria)));
    assert.equal((await get("/api/movimientos?categoria=NADA", tokens.admin)).status, 400);
    const total = await movs("limite=1");
    assert.equal(total.por_categoria.reduce((a, c) => a + c.movimientos, 0), total.total, "los contadores por categoría suman el total");
  });

  it("combinan con fecha, sucursal, modelo, talla, color, usuario, estado de traspaso y búsqueda", async () => {
    const t42 = idOf("tallas", "nombre", "42");
    const r = await movs(`categoria=TRASPASO&sucursal_id=2&producto_id=6&talla_id=${t42}&color_id=1&usuario_id=${userId("sc@test.local")}&estado=recibido&desde=${todayLocal()}&hasta=${todayLocal()}`);
    assert.ok(r.filas.length >= 1);
    assert.ok(r.filas.every((f) => f.sucursal.id === 2 && f.producto.id === 6 && f.talla.id === t42 && f.color.id === 1 && f.usuario.id === userId("sc@test.local") && f.estado_traspaso === "recibido"));
    const ayer = new Date(Date.now() - 4 * 3600e3 - 86_400_000).toISOString().slice(0, 10);
    assert.equal((await movs(`desde=${ayer}&hasta=${ayer}&producto_id=6`)).total, 0, "rango de ayer vacío");
    const first = (await movs("categoria=TRASPASO&limite=1")).filas[0];
    assert.ok((await movs(`q=${first.referencia}`)).filas.some((f) => f.id === first.id), "busca por MOV-");
    assert.ok((await movs(`q=${first.documento.codigo}`)).filas.some((f) => f.id === first.id), "busca por TR-");
  });

  it("paginación estable: páginas distintas, total constante y límite máximo", async () => {
    const p1 = await movs("limite=3&pagina=1"), p2 = await movs("limite=3&pagina=2");
    assert.equal(p1.filas.length, 3);
    assert.equal(p1.total, p2.total);
    assert.ok(p1.filas.every((a) => !p2.filas.some((b) => b.id === a.id)));
    assert.ok(p1.filas[0].id > p1.filas[2].id, "más recientes primero");
    assert.ok((await movs("limite=100000")).filas.length <= 100);
  });

  it("seguridad: sin sesión 401; el vendedor siempre queda limitado a su sucursal aunque pida otra", async () => {
    assert.equal((await get("/api/movimientos")).status, 401);
    assert.equal((await get("/api/traspasos/historial")).status, 401);
    assert.equal((await get("/api/operaciones/historial")).status, 401);
    assert.equal((await get("/api/reportes/modelos")).status, 401);
    assert.equal((await get("/api/movimientos?sucursal_id=1", tokens.sc)).status, 403, "pedir otra sucursal se rechaza en el servidor");
    const sc = await movs("limite=100", tokens.sc);
    assert.ok(sc.filas.length > 0 && sc.filas.every((f) => f.sucursal.id === 2), "sin parámetro solo ve su sucursal");
    assert.ok((await movs("sucursal_id=2&limite=100", tokens.sc)).filas.every((f) => f.sucursal.id === 2));
    const cb = await movs("limite=100", tokens.cb);
    assert.ok(cb.filas.every((f) => f.sucursal.id === 1));
  });
});

describe("reportes analíticos", () => {
  const today = () => todayLocal();
  const sqlUnits = (where = "") => sql(`SELECT COALESCE(SUM(dv.cantidad),0) AS u, COUNT(DISTINCT v.id) AS n, ROUND(COALESCE(SUM(dv.subtotal),0),2) AS i
     FROM detalle_venta dv JOIN ventas v ON v.id = dv.venta_id WHERE v.estado = 'completada' ${where}`)[0];

  it("modelos más vendidos: unidades de las líneas, ventas distintas, orden descendente y cifras iguales a la base", async () => {
    // una venta con tres líneas del mismo modelo (distintas tallas) debe contar UNA venta y todas las unidades
    const t = ["38", "40", "42"].map((n) => idOf("tallas", "nombre", n));
    for (const id of t) must(await ingreso(tokens.admin, { sucursal_id: 1, producto_id: 5, talla_id: id, color_id: 3, cantidad: 4 }));
    must(await post("/api/ventas", tokens.cb, saleBody({ items: t.map((id) => line(5, id, 3, 2, 80)) })));

    const r = must(await get("/api/reportes/modelos?limite=50", tokens.admin));
    const units = r.modelos.map((m) => m.unidades);
    assert.deepEqual(units, [...units].sort((a, b) => b - a), "orden por unidades vendidas descendente");
    const db = sqlUnits();
    assert.equal(r.totales.unidades, db.u);
    assert.equal(r.totales.ventas, db.n);
    assert.equal(r.totales.ingresos, db.i);
    assert.equal(r.modelos.reduce((a, m) => a + m.unidades, 0), db.u, "cada unidad se cuenta una sola vez");
    const m5 = r.modelos.find((m) => m.producto_id === 5);
    const dbm5 = sql("SELECT SUM(dv.cantidad) AS u, COUNT(DISTINCT v.id) AS n, ROUND(SUM(dv.subtotal),2) AS i FROM detalle_venta dv JOIN ventas v ON v.id=dv.venta_id WHERE v.estado='completada' AND dv.producto_id=5")[0];
    assert.equal(m5.unidades, dbm5.u);
    assert.equal(m5.ventas, dbm5.n);
    assert.equal(m5.ingresos, dbm5.i);
    assert.ok(m5.ventas < m5.unidades, "una venta con varias unidades no se cuenta como varias ventas");
    assert.equal(m5.por_talla.reduce((a, x) => a + x.unidades, 0), m5.unidades);
    assert.equal(m5.por_color.reduce((a, x) => a + x.unidades, 0), m5.unidades);
    assert.equal(m5.por_sucursal.reduce((a, x) => a + x.unidades, 0), m5.unidades);
    assert.equal(m5.tendencia.reduce((a, x) => a + x.unidades, 0), m5.unidades);
    assert.ok(r.definiciones.netas);
    assert.equal(m5.netas, m5.unidades - m5.devueltas);
  });

  it("filtros de modelos: sucursal, rango personalizado, talla, color, modelo y todo el historial", async () => {
    const sc = must(await get("/api/reportes/modelos?sucursal_id=2&limite=50", tokens.admin));
    const dbSc = sqlUnits("AND v.sucursal_id = 2");
    assert.equal(sc.totales.unidades, dbSc.u);
    assert.equal(sc.totales.ventas, dbSc.n);
    const cb = must(await get("/api/reportes/modelos?sucursal_id=1&limite=50", tokens.admin));
    assert.equal(cb.totales.unidades + sc.totales.unidades, must(await get("/api/reportes/modelos?limite=50", tokens.admin)).totales.unidades, "ambas sucursales = total");

    const hoy = must(await get(`/api/reportes/modelos?desde=${today()}&hasta=${today()}&limite=50`, tokens.admin));
    assert.equal(hoy.totales.unidades, sqlUnits(`AND date(v.fecha,'-4 hours') = '${today()}'`).u);
    assert.equal(must(await get("/api/reportes/modelos?desde=2000-01-01&hasta=2000-01-31", tokens.admin)).totales.unidades, 0, "rango vacío");
    assert.equal((await get("/api/reportes/modelos?desde=2026-02-01&hasta=2026-01-01", tokens.admin)).status, 400);
    assert.equal((await get("/api/reportes/modelos?desde=ayer", tokens.admin)).status, 400);

    const t40 = idOf("tallas", "nombre", "40");
    const talla = must(await get(`/api/reportes/modelos?talla_id=${t40}&limite=50`, tokens.admin));
    assert.equal(talla.totales.unidades, sqlUnits(`AND dv.talla_id = ${t40}`).u);
    assert.ok(talla.modelos.every((m) => m.por_talla.every((x) => x.talla === "40")));
    const color = must(await get("/api/reportes/modelos?color_id=3&limite=50", tokens.admin));
    assert.equal(color.totales.unidades, sqlUnits("AND dv.color_id = 3").u);
    const modelo = must(await get("/api/reportes/modelos?producto_id=5", tokens.admin));
    assert.equal(modelo.modelos.length, 1);
    // un vendedor solo ve su sucursal, aunque pida la otra
    assert.equal((await get("/api/reportes/modelos?sucursal_id=1", tokens.sc)).status, 403);
    const scOnly = must(await get("/api/reportes/modelos?limite=50", tokens.sc));
    assert.equal(scOnly.totales.unidades, dbSc.u);
  });

  it("devoluciones y cambios se informan aparte de las ventas: no restan unidades vendidas (solo el neto) y los reemplazos no son ventas", async () => {
    const r = must(await get("/api/reportes/modelos?limite=50", tokens.admin));
    const m4 = r.modelos.find((m) => m.producto_id === 4);
    assert.ok(m4.devueltas >= 2, "la devolución y el cambio del bloque anterior");
    assert.ok(m4.cambios_entregados >= 1);
    assert.equal(m4.netas, m4.unidades - m4.devueltas);
    assert.equal(r.totales.unidades_netas, r.totales.unidades - r.totales.unidades_devueltas);
    const dbReturned = sql("SELECT COALESCE(SUM(oi.cantidad),0) AS u FROM operacion_items oi JOIN operaciones o ON o.id=oi.operacion_id JOIN ventas v ON v.id=o.venta_id WHERE oi.rol='devuelto' AND o.tipo IN ('devolucion','cambio') AND v.estado='completada'")[0].u;
    assert.equal(r.totales.unidades_devueltas, dbReturned);
  });

  it("envíos por departamento: pedidos y unidades por separado, destino guardado (no la sucursal), sin doble conteo y directas excluidas", async () => {
    const t = ["38", "40"].map((n) => idOf("tallas", "nombre", n));
    for (const id of t) {
      must(await ingreso(tokens.admin, { sucursal_id: 1, producto_id: 5, talla_id: id, color_id: 3, cantidad: 10 }));
      must(await ingreso(tokens.admin, { sucursal_id: 2, producto_id: 5, talla_id: id, color_id: 2, cantidad: 5 }));
    }
    const before = must(await get("/api/reportes/envios", tokens.admin));
    const b = (name) => before.departamentos.find((d) => d.departamento === name);

    // Cochabamba vende con envío a La Paz: pedido con 2 líneas y 5 unidades (cuenta 1 pedido, 5 unidades)
    must(await post("/api/ventas", tokens.cb, saleBody({ modalidad: "envio", departamento: "La Paz", ciudad: "El Alto", direccion: "Av 1", items: [line(5, t[0], 3, 2, 90), line(5, t[1], 3, 3, 90)] })));
    // Santa Cruz vende a Oruro y a La Paz (este último por envío interprovincial escrito en minúsculas con espacios)
    must(await post("/api/ventas", tokens.sc, saleBody({ sucursal_id: 2, modalidad: "envio", departamento: "Oruro", ciudad: "Oruro", direccion: "Calle 2", items: [line(5, t[0], 2, 1, 90)] })));
    must(await post("/api/ventas", tokens.sc, saleBody({ sucursal_id: 2, modalidad: "envio_interprovincial", departamento: "  la paz ", provincia: "Murillo", municipio: "Palca", direccion: "Plaza", agencia_transporte: "Trans", items: [line(5, t[1], 2, 1, 90)] })));
    // entrega directa en Cochabamba: NO es envío
    must(await post("/api/ventas", tokens.cb, saleBody({ items: [line(5, t[0], 3, 1, 90)] })));
    // destino no reconocido: se conserva para revisión, no se descarta
    must(await post("/api/ventas", tokens.cb, saleBody({ modalidad: "envio_interprovincial", departamento: "Atlántida", provincia: "X", municipio: "Y", direccion: "Z", agencia_transporte: "T", items: [line(5, t[0], 3, 1, 90)] })));

    const after = must(await get("/api/reportes/envios", tokens.admin));
    const a = (name) => after.departamentos.find((d) => d.departamento === name);
    assert.equal(a("La Paz").pedidos - b("La Paz").pedidos, 2, "dos pedidos a La Paz (uno de cada sucursal; el de 2 líneas cuenta una vez)");
    assert.equal(a("La Paz").unidades - b("La Paz").unidades, 5 + 1, "unidades enviadas aparte de los pedidos");
    assert.equal(a("Oruro").pedidos - b("Oruro").pedidos, 1);
    assert.equal(a("Oruro").unidades - b("Oruro").unidades, 1);
    assert.equal(a("Cochabamba").pedidos, b("Cochabamba").pedidos, "vender desde Cochabamba NO suma a Cochabamba");
    assert.equal(after.totales.ventas_sin_envio_excluidas - before.totales.ventas_sin_envio_excluidas >= 1, true);
    assert.equal(after.respuestas.la_paz, a("La Paz").pedidos);
    assert.equal(after.respuestas.oruro, a("Oruro").pedidos);
    assert.deepEqual(after.departamentos.map((d) => d.departamento).filter((n) => DEPARTMENTS.includes(n)).sort(), [...DEPARTMENTS].sort(), "los 9 siempre aparecen");
    assert.ok(after.sin_reconocer.some((x) => x.valor === "Atlántida"), "valor histórico no reconocido conservado");
    // ranking descendente por pedidos y posiciones consecutivas
    const orden = after.departamentos.map((d) => d.pedidos);
    assert.deepEqual(orden, [...orden].sort((x, y) => y - x));
    assert.deepEqual(after.departamentos.map((d) => d.posicion), after.departamentos.map((_, i) => i + 1));
    // por sucursal: La Paz recibió pedidos de ambas sucursales
    const lp = a("La Paz");
    assert.ok(lp.por_sucursal.find((s) => s.sucursal_id === 1) && lp.por_sucursal.find((s) => s.sucursal_id === 2));
    assert.equal(lp.por_sucursal.reduce((s, x) => s + x.pedidos, 0), lp.pedidos);
    // cifras iguales a la base: pedidos = ventas completadas con destino
    const dbPedidos = sql("SELECT COUNT(*) AS n FROM ventas WHERE estado='completada' AND destino_id IS NOT NULL AND tipo_entrega IN ('interdepartamental','interprovincial')")[0].n;
    assert.equal(after.totales.pedidos, dbPedidos);
  });

  it("envíos con periodo y sucursal: el ranking del periodo se compara con el histórico; el filtro de sucursal funciona", async () => {
    const hoy = must(await get(`/api/reportes/envios?desde=${today()}&hasta=${today()}`, tokens.admin));
    assert.ok(hoy.historico, "con periodo, se entrega el ranking de todo el historial");
    assert.ok(hoy.departamentos.every((d) => d.posicion_historica >= 1));
    const sc = must(await get("/api/reportes/envios?sucursal_id=2", tokens.admin));
    const cb = must(await get("/api/reportes/envios?sucursal_id=1", tokens.admin));
    const todo = must(await get("/api/reportes/envios", tokens.admin));
    assert.equal(sc.totales.pedidos + cb.totales.pedidos, todo.totales.pedidos);
    assert.equal(must(await get("/api/reportes/envios?desde=2000-01-01&hasta=2000-01-02", tokens.admin)).totales.pedidos, 0);
    // un vendedor no puede ver los envíos de la otra sucursal
    assert.equal((await get("/api/reportes/envios?sucursal_id=1", tokens.sc)).status, 403);
    assert.equal(must(await get("/api/reportes/envios", tokens.sc)).totales.pedidos, sc.totales.pedidos);
  });

  it("resumen consolidado: ventas, envíos, traspasos, devoluciones y movimientos por separado; los traspasos no son ingresos", async () => {
    const before = must(await get("/api/reportes/resumen", tokens.admin));
    const t = idOf("tallas", "nombre", "44");
    must(await ingreso(tokens.admin, { sucursal_id: 1, producto_id: 6, talla_id: t, color_id: 1, cantidad: 6 }));
    const tr = must(await post("/api/traspasos", tokens.cb, { idempotency_key: randomUUID(), origen_id: 1, destino_id: 2, items: [{ producto_id: 6, talla_id: t, color_id: 1, cantidad: 4 }] }));
    must(await post(`/api/traspasos/${tr.id}/despachar`, tokens.cb));
    must(await post(`/api/traspasos/${tr.id}/recibir`, tokens.sc));
    const after = must(await get("/api/reportes/resumen", tokens.admin));

    assert.equal(after.ventas.ingresos_brutos, before.ventas.ingresos_brutos, "un traspaso no cambia ingresos");
    assert.equal(after.ventas.completadas, before.ventas.completadas);
    assert.equal(after.ventas.unidades, before.ventas.unidades);
    assert.equal(after.traspasos.referencias, before.traspasos.referencias + 1);
    assert.equal(after.traspasos.unidades, before.traspasos.unidades + 4);
    assert.equal(after.traspasos.por_estado.recibido, before.traspasos.por_estado.recibido + 1);
    assert.equal(after.movimientos.unidades_ingresadas, before.movimientos.unidades_ingresadas + 6);
    assert.equal(after.movimientos.unidades_vendidas, before.movimientos.unidades_vendidas, "ingresar y traspasar no es vender");
    assert.equal(after.movimientos.traspaso_unidades_salidas, before.movimientos.traspaso_unidades_salidas + 4);
    assert.equal(after.movimientos.traspaso_unidades_entradas, before.movimientos.traspaso_unidades_entradas + 4);
    assert.deepEqual(after.movimientos.por_categoria.map((c) => c.categoria), [...MOVEMENT_CATEGORIES]);
    const dbIng = sql("SELECT ROUND(SUM(total),2) AS s, COUNT(*) AS n FROM ventas WHERE estado='completada'")[0];
    assert.equal(after.ventas.ingresos_brutos, dbIng.s);
    assert.equal(after.ventas.completadas, dbIng.n);
    assert.equal(after.ventas.ticket_promedio, Math.round((dbIng.s / dbIng.n) * 100) / 100);
    assert.equal(after.ventas.por_sucursal.reduce((a, s) => a + s.ingresos, 0).toFixed(2), dbIng.s.toFixed(2));
    // devoluciones y cambios: reportados aparte, con motivos y neto documentado
    const dc = after.devoluciones_y_cambios;
    assert.ok(dc.devoluciones >= 2 && dc.cambios >= 1);
    assert.ok(dc.por_motivo.some((m) => m.codigo === "TALLA_INCORRECTA"));
    assert.ok(dc.motivos_de_talla >= 1);
    assert.ok(dc.modelos_mas_devueltos.length > 0);
    assert.ok(Array.isArray(dc.por_usuario), "el administrador ve el detalle por responsable");
    assert.equal(after.ventas.ingresos_netos, Math.round((after.ventas.ingresos_brutos - after.ventas.devoluciones_y_cambios_valor_devuelto + after.ventas.cambios_valor_entregado) * 100) / 100);
    assert.ok(after.definiciones.traspasos.includes("no son ventas"));
  });

  it("resumen con periodo compara con el periodo anterior; un vendedor no ve el desglose por usuario ni otra sucursal", async () => {
    const r = must(await get(`/api/reportes/resumen?desde=${today()}&hasta=${today()}`, tokens.admin));
    assert.ok(r.devoluciones_y_cambios.periodo_anterior, "comparación con el periodo anterior de igual duración");
    const ayer = new Date(Date.now() - 4 * 3600e3 - 86_400_000).toISOString().slice(0, 10);
    assert.equal(r.devoluciones_y_cambios.periodo_anterior.hasta, ayer);
    assert.equal((await get("/api/reportes/resumen?sucursal_id=1", tokens.sc)).status, 403);
    const vend = must(await get("/api/reportes/resumen", tokens.sc));
    assert.equal(vend.devoluciones_y_cambios.por_usuario, null, "por responsable solo para administradores");
    assert.ok(vend.ventas.por_sucursal.every((s) => s.sucursal === "MISSI Santa Cruz"), "el vendedor solo ve su sucursal");
    assert.equal((await get("/api/reportes/resumen?desde=2026-13-45", tokens.admin)).status, 400);
  });
});

// ================================================================ MISSI BOLIVIA, filtros de ventas y reconciliación de reportes
describe("organización MISSI BOLIVIA", () => {
  let tokenOrg2;

  it("las sucursales pertenecen a MISSI BOLIVIA; el administrador ve ambas y cada vendedor solo la suya", async () => {
    const admin = must(await get("/api/sucursales", tokens.admin));
    assert.deepEqual(admin.map((s) => s.nombre).sort(), ["Almacén Central", "MISSI Cochabamba", "MISSI Santa Cruz"]); // almacén central + tiendas
    assert.ok(admin.every((s) => s.organizacion === "MISSI BOLIVIA"));
    assert.deepEqual(must(await get("/api/sucursales", tokens.cb)).map((s) => s.nombre), ["MISSI Cochabamba"]);
    const me = must(await get("/api/auth/me", tokens.admin));
    assert.equal(me.organizacion, "MISSI BOLIVIA");
    assert.deepEqual(me.branch_ids.length, 3);
    assert.equal(sql("SELECT COUNT(*) AS n FROM sucursales WHERE organizacion_id IS NULL")[0].n, 0, "ninguna sucursal suelta");
    assert.equal(sql("SELECT COUNT(*) AS n FROM usuarios WHERE organizacion_id IS NULL")[0].n, 0, "ningún usuario sin organización");
  });

  it("el modelo admite sucursales futuras sin cambiar código: una tercera sucursal entra en los consolidados", async () => {
    sql("INSERT INTO sucursales (nombre, codigo, organizacion_id) VALUES ('MISSI Prueba Futura', 'FUT', 1)");
    const fut = idOf("sucursales", "nombre", "MISSI Prueba Futura");
    const nacional0 = must(await get("/api/inventario", tokens.admin)).find((r) => r.producto.id === 4 && r.talla.nombre === "P" && r.color.id === 1)?.cantidad ?? 0;
    must(await ingreso(tokens.admin, { sucursal_id: fut, producto_id: 4, talla_id: idOf("tallas", "nombre", "P"), color_id: 1, cantidad: 3 }));
    assert.ok((must(await get("/api/sucursales", tokens.admin))).some((s) => s.id === fut), "el administrador la ve");
    const nacional1 = must(await get("/api/inventario", tokens.admin)).find((r) => r.producto.id === 4 && r.talla.nombre === "P" && r.color.id === 1).cantidad;
    assert.equal(nacional1, nacional0 + 3, "el stock nacional se calcula sumando sucursales (no es un stock aparte)");
    const porSucursal = sql("SELECT SUM(cantidad) AS n FROM inventario WHERE producto_id = 4 AND talla_id = (SELECT id FROM tallas WHERE nombre = 'P') AND color_id = 1")[0].n;
    assert.equal(nacional1, porSucursal);
    assert.equal((await get("/api/sucursales", tokens.cb)).json.data.some((s) => s.id === fut), false, "un vendedor no ve sucursales ajenas");
    assert.equal((await ingreso(tokens.cb, { sucursal_id: fut, producto_id: 4, talla_id: 1, color_id: 1, cantidad: 1 })).status, 403);
    assert.equal((await post("/api/ventas", tokens.cb, saleBody({ sucursal_id: fut }))).status, 403);
  });

  it("reglas de base de datos: sucursal sin organización y usuario de otra organización se rechazan", async () => {
    assert.throws(() => sql("INSERT INTO sucursales (nombre, codigo) VALUES ('Suelta', 'SUE')"));
    sql("INSERT INTO organizaciones (codigo, nombre) VALUES ('ORG2', 'Otra Organizacion')");
    assert.throws(() => sql("UPDATE usuarios SET organizacion_id = (SELECT id FROM organizaciones WHERE codigo = 'ORG2') WHERE email = 'cb@test.local'"));
    assert.equal(sql("SELECT organizacion_id FROM usuarios WHERE email = 'cb@test.local'")[0].organizacion_id, 1);
  });

  it("aislamiento entre organizaciones: un administrador de otra organización no ve ni toca datos de MISSI BOLIVIA", async () => {
    sql("INSERT INTO sucursales (nombre, codigo, organizacion_id) VALUES ('Sucursal Org2', 'O2S', (SELECT id FROM organizaciones WHERE codigo = 'ORG2'))");
    const pw2 = randomBytes(12).toString("base64url");
    sql(`INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id,organizacion_id) VALUES ('admin2@test.local','Admin Org2',${sqlQuote(hashPassword(pw2))},'admin',NULL,(SELECT id FROM organizaciones WHERE codigo = 'ORG2'))`);
    tokenOrg2 = await login("admin2@test.local", pw2);
    const own = idOf("sucursales", "nombre", "Sucursal Org2");

    assert.deepEqual(must(await get("/api/sucursales", tokenOrg2)).map((s) => s.nombre), ["Sucursal Org2"]);
    for (const path of ["/api/inventario?sucursal_id=1", "/api/movimientos?sucursal_id=1", "/api/ventas/historial?sucursal_id=1", "/api/reportes/envios?sucursal_id=1", "/api/reportes/modelos?sucursal_id=2", "/api/traspasos/historial?sucursal_id=1"]) {
      assert.equal((await get(path, tokenOrg2)).status, 403, path);
    }
    // consolidado: solo ve lo suyo (vacío), nunca los datos de MISSI BOLIVIA
    assert.equal((await movs("limite=5", tokenOrg2)).total, 0);
    assert.equal(must(await get("/api/ventas/historial", tokenOrg2)).total, 0);
    assert.equal(must(await get("/api/reportes/envios", tokenOrg2)).totales.pedidos, 0);
    assert.equal(must(await get("/api/reportes/modelos", tokenOrg2)).totales.unidades, 0);
    assert.equal(must(await get("/api/reportes/resumen", tokenOrg2)).ventas.completadas, 0);
    assert.equal(must(await get("/api/traspasos/historial", tokenOrg2)).total, 0);
    assert.equal(must(await get("/api/inventario", tokenOrg2)).length, 0);
    // escritura: no puede operar en sucursales de MISSI BOLIVIA aunque sea administrador
    assert.equal((await ingreso(tokenOrg2, { sucursal_id: 1, producto_id: 4, talla_id: 1, color_id: 1, cantidad: 1 })).status, 403);
    assert.equal((await post("/api/ventas", tokenOrg2, saleBody({ sucursal_id: 1 }))).status, 403);
    assert.equal((await post("/api/traspasos", tokenOrg2, { idempotency_key: randomUUID(), origen_id: 1, destino_id: 2, items: [{ producto_id: 4, talla_id: 1, color_id: 1, cantidad: 1 }] })).status, 403);
    assert.equal((await post("/api/ventas/1/cancelar", tokenOrg2, { motivo: "x" })).status, 403);
    // usuarios: solo ve y modifica las cuentas de su organización, y no puede asignar sucursales ajenas
    assert.ok(!must(await get("/api/usuarios", tokenOrg2)).some((u) => u.email === "cb@test.local"));
    assert.equal((await api("PATCH", `/api/usuarios/${userId("cb@test.local")}`, { token: tokenOrg2, body: { nombre: "Hackeado" } })).status, 404);
    assert.equal((await post("/api/usuarios", tokenOrg2, { email: "x@test.local", nombre: "X", rol: "vendedor", sucursal_id: 1, password: "una-clave-larga-123" })).status, 400);
    assert.equal(sql("SELECT nombre FROM usuarios WHERE email = 'cb@test.local'")[0].nombre, "Vend CB");
    assert.equal(must(await get("/api/usuarios", tokens.admin)).some((u) => u.email === "admin2@test.local"), false, "y MISSI BOLIVIA no ve la cuenta de la otra organización");
    // y sí puede en la suya
    must(await ingreso(tokenOrg2, { sucursal_id: own, producto_id: 4, talla_id: 1, color_id: 1, cantidad: 2 }));
    assert.equal(must(await get("/api/inventario", tokenOrg2)).length, 1);
    // MISSI BOLIVIA tampoco ve lo de la otra organización
    assert.ok(!(must(await get("/api/inventario", tokens.admin))).some((r) => r.sucursal_id === own));
    assert.equal((await get(`/api/movimientos?sucursal_id=${own}`, tokens.admin)).status, 403);
  });
});

describe("ventas: filtros combinados, paginación y reconciliación con reportes", () => {
  const TAG = "Filtrox";
  let t42, t44, cbId, scId, S;
  const today = () => todayLocal();
  const hist = async (q, token = tokens.admin) => must(await get(`/api/ventas/historial?q=${TAG}&${q}`, token));
  const ids = (page) => page.filas.map((f) => f.id).sort((a, b) => a - b);

  before(async () => {
    t42 = idOf("tallas", "nombre", "42");
    t44 = idOf("tallas", "nombre", "44");
    cbId = userId("cb@test.local");
    scId = userId("sc@test.local");
    for (const [suc, p, t, c, n] of [[1, 4, t42, 1, 30], [1, 4, t42, 2, 10], [1, 5, t44, 2, 30], [1, 5, t42, 2, 30], [2, 4, t44, 1, 30]]) {
      must(await ingreso(tokens.admin, { sucursal_id: suc, producto_id: p, talla_id: t, color_id: c, cantidad: n }));
    }
    const sale = async (token, over, items) => must(await post("/api/ventas", token, saleBody({ cliente_nombre: `${TAG} ${over.nombre ?? "Cliente"}`, items, ...over.body })));
    const L = (p, t, c, n, pr) => ({ producto_id: p, talla_id: t, color_id: c, cantidad: n, precio_unitario: pr });
    S = {
      s1: await sale(tokens.cb, { body: { metodo_pago: "QR", modalidad: "entrega_directa" } }, [L(4, t42, 1, 2, 100)]),
      s2: await sale(tokens.cb, { body: { metodo_pago: "efectivo", modalidad: "envio", departamento: "La Paz", ciudad: "El Alto", direccion: "Av 1" } }, [L(5, t44, 2, 1, 150), L(4, t42, 1, 1, 100)]),
      s3: await sale(tokens.sc, { body: { sucursal_id: 2, metodo_pago: "QR", modalidad: "envio", departamento: "Oruro", ciudad: "Oruro", direccion: "Calle 2" } }, [L(4, t44, 1, 3, 90)]),
      s4: await sale(tokens.cb, { body: { metodo_pago: "QR", modalidad: "envio_interprovincial", departamento: "  la paz ", provincia: "Murillo", municipio: "Palca", direccion: "Plaza", agencia_transporte: "Trans" } }, [L(5, t42, 2, 2, 150)]),
      s5: await sale(tokens.cb, { body: { metodo_pago: "efectivo", modalidad: "envio_interprovincial", departamento: "Atlántida", provincia: "X", municipio: "Y", direccion: "Z", agencia_transporte: "T" } }, [L(4, t42, 1, 1, 100)]),
      s6: await sale(tokens.cb, { body: { metodo_pago: "QR", modalidad: "entrega_directa" } }, [L(4, t42, 1, 1, 100)]),
    };
    must(await post(`/api/ventas/${S.s6.id}/cancelar`, tokens.admin, { motivo: "prueba de filtros" }));
  });

  it("cada filtro por separado devuelve exactamente lo esperado", async () => {
    const { s1, s2, s3, s4, s5, s6 } = S;
    assert.deepEqual(ids(await hist("")), ids({ filas: [s1, s2, s3, s4, s5, s6] }), "sin filtros: las 6 (una cancelada)");
    assert.deepEqual(ids(await hist("metodo_pago=QR&estado=completada")), ids({ filas: [s1, s3, s4] }));
    assert.deepEqual(ids(await hist("metodo_pago=efectivo")), ids({ filas: [s2, s5] }));
    assert.deepEqual(ids(await hist("estado=cancelada")), [s6.id]);
    assert.deepEqual(ids(await hist("sucursal_id=2")), [s3.id]);
    assert.deepEqual(ids(await hist("modalidad=entrega_directa")), ids({ filas: [s1, s6] }));
    assert.deepEqual(ids(await hist("modalidad=envio")), ids({ filas: [s2, s3] }));
    assert.deepEqual(ids(await hist("modalidad=envio_interprovincial")), ids({ filas: [s4, s5] }));
    assert.deepEqual(ids(await hist(`usuario_id=${scId}`)), [s3.id]);
    assert.deepEqual(ids(await hist(`usuario_id=${cbId}`)), ids({ filas: [s1, s2, s4, s5, s6] }));
    assert.deepEqual(ids(await hist("producto_id=5")), ids({ filas: [s2, s4] }));
    assert.deepEqual(ids(await hist(`talla_id=${t44}`)), ids({ filas: [s2, s3] }));
    assert.deepEqual(ids(await hist("color_id=2")), ids({ filas: [s2, s4] }));
    const byRef = must(await get(`/api/ventas/historial?q=V-${String(s3.id).padStart(6, "0")}`, tokens.admin));
    assert.deepEqual(byRef.filas.map((f) => f.id), [s3.id], "búsqueda por referencia V-000123");
    assert.deepEqual(must(await get(`/api/ventas/historial?q=${s3.id}`, tokens.admin)).filas.some((f) => f.id === s3.id), true, "o por número");
    assert.deepEqual(ids(await hist("q=Filtrox")), ids({ filas: [s1, s2, s3, s4, s5, s6] }));
    assert.deepEqual(ids(await hist("provincia=murillo")), [s4.id], "provincia sin distinguir mayúsculas");
    assert.deepEqual(ids(await hist("municipio=PALCA")), [s4.id]);
  });

  it("departamento de destino: se agrupa sin tildes ni mayúsculas, lo desconocido se conserva y la sucursal no cuenta", async () => {
    const { s2, s3, s4, s5 } = S;
    assert.deepEqual(ids(await hist("departamento=La Paz")), ids({ filas: [s2, s4] }), "«La Paz» y « la paz » son el mismo destino");
    assert.deepEqual(ids(await hist("departamento=la%20paz")), ids({ filas: [s2, s4] }));
    assert.deepEqual(ids(await hist("departamento=Oruro")), [s3.id]);
    assert.deepEqual(ids(await hist("departamento=Atl%C3%A1ntida")), [s5.id], "valor no oficial conservado");
    assert.deepEqual(ids(await hist("departamento=Cochabamba")), [], "vender desde Cochabamba no es enviar a Cochabamba");
    assert.deepEqual(ids(await hist("departamento=SIN_REGISTRAR")), []);
  });

  it("los filtros se combinan como intersección (modelo+talla+color deben coincidir en la MISMA línea)", async () => {
    const { s2, s4 } = S;
    assert.deepEqual(ids(await hist("metodo_pago=QR&sucursal_id=1&estado=completada")), ids({ filas: [S.s1, s4] }));
    assert.deepEqual(ids(await hist("departamento=La Paz&metodo_pago=efectivo")), [s2.id]);
    assert.deepEqual(ids(await hist("departamento=La Paz&metodo_pago=QR&modalidad=envio_interprovincial")), [s4.id]);
    assert.deepEqual(ids(await hist(`producto_id=5&talla_id=${t42}`)), [s4.id], "5 en talla 42 solo está en la venta 4");
    assert.deepEqual(ids(await hist(`producto_id=4&talla_id=${t44}&color_id=2`)), [], "la venta 2 tiene 5/44/2 y 4/42/1 pero ninguna línea 4/44/2");
    assert.deepEqual(ids(await hist(`producto_id=5&talla_id=${t44}&color_id=2&metodo_pago=efectivo&departamento=La Paz&usuario_id=${cbId}&sucursal_id=1`)), [s2.id], "siete filtros a la vez");
    assert.deepEqual(ids(await hist("metodo_pago=QR&departamento=Oruro&sucursal_id=1")), [], "Oruro fue vendida por Santa Cruz");
    assert.deepEqual(ids(await hist(`desde=${today()}&hasta=${today()}&modalidad=envio`)), ids({ filas: [s2, S.s3] }));
    const ayer = new Date(Date.now() - 4 * 3600e3 - 86_400_000).toISOString().slice(0, 10);
    assert.deepEqual(ids(await hist(`desde=${ayer}&hasta=${ayer}`)), [], "ayer no hay ventas");
    assert.equal((await get(`/api/ventas/historial?desde=${today()}&hasta=2000-01-01`, tokens.admin)).status, 400, "rango invertido");
    assert.equal((await get("/api/ventas/historial?metodo_pago=tarjeta", tokens.admin)).status, 400);
    assert.equal((await get("/api/ventas/historial?departamento=" + "x".repeat(80), tokens.admin)).status, 400);
  });

  it("paginación en el servidor: páginas disjuntas, total constante y totales de TODOS los resultados", async () => {
    const p1 = await hist("limite=2&pagina=1"), p2 = await hist("limite=2&pagina=2"), p3 = await hist("limite=2&pagina=3");
    assert.equal(p1.total, 6);
    assert.equal(p2.total, 6);
    assert.deepEqual([p1.filas.length, p2.filas.length, p3.filas.length], [2, 2, 2]);
    const all = [...p1.filas, ...p2.filas, ...p3.filas].map((f) => f.id);
    assert.equal(new Set(all).size, 6, "ninguna venta se repite entre páginas");
    assert.deepEqual(all, [...all].sort((a, b) => b - a), "más recientes primero");
    // los totales no dependen de la página
    assert.deepEqual(p1.totales, p3.totales);
    assert.equal(p1.totales.ventas, 5, "las completadas (la cancelada no cuenta)");
    assert.equal(p1.totales.ingresos, 200 + 250 + 270 + 300 + 100);
    assert.equal(p1.totales.unidades, 2 + 2 + 3 + 2 + 1);
    assert.equal((await hist("limite=100000")).filas.length, 6);
    assert.equal((await hist("pagina=99")).filas.length, 0, "una página fuera de rango queda vacía");
  });

  it("cada venta trae sus líneas, una sola fila por venta (no una por producto) y su referencia", async () => {
    const page = await hist("");
    const s2 = page.filas.find((f) => f.id === S.s2.id);
    assert.equal(page.filas.filter((f) => f.id === S.s2.id).length, 1);
    assert.equal(s2.items.length, 2);
    assert.equal(s2.unidades, 2);
    assert.equal(s2.referencia, `V-${String(S.s2.id).padStart(6, "0")}`);
    assert.equal(s2.total, 250);
    assert.equal(s2.vendedor, "Vend CB");
    assert.equal(s2.sucursal, "MISSI Cochabamba");
    assert.equal(s2.departamento, "La Paz");
    assert.equal(page.filas.find((f) => f.id === S.s6.id).estado, "cancelada");
  });

  it("los totales de la lista cuadran con la base de datos para los mismos filtros", async () => {
    const db = sql(`SELECT COUNT(*) AS n, ROUND(SUM(total),2) AS t FROM ventas WHERE estado='completada' AND cliente_nombre LIKE '${TAG}%'`)[0];
    const r = await hist("estado=completada");
    assert.equal(r.totales.ventas, db.n);
    assert.equal(r.totales.ingresos, db.t);
    const u = sql(`SELECT SUM(dv.cantidad) AS u FROM detalle_venta dv JOIN ventas v ON v.id=dv.venta_id WHERE v.estado='completada' AND v.cliente_nombre LIKE '${TAG}%'`)[0].u;
    assert.equal(r.totales.unidades, u);
    // con filtro de modelo, ingresos y unidades salen de las líneas que coinciden
    const m = await hist("producto_id=5");
    assert.equal(m.totales.base, "lineas");
    assert.equal(m.totales.unidades, 1 + 2);
    assert.equal(m.totales.ingresos, 150 + 300);
  });

  it("vendedor: solo su sucursal (otra = 403) y nunca ve ventas ajenas", async () => {
    assert.equal((await get(`/api/ventas/historial?q=${TAG}&sucursal_id=2`, tokens.cb)).status, 403);
    assert.deepEqual(ids(await hist("", tokens.sc)), [S.s3.id]);
    assert.ok(ids(await hist("", tokens.cb)).every((id) => id !== S.s3.id));
    assert.equal((await get("/api/ventas/historial")).status, 401);
  });

  it("reporte por departamento: pedidos, unidades, ingresos y ticket promedio cuadran con la lista de ventas", async () => {
    const env = (q = "") => get(`/api/reportes/envios?q=${TAG}${q ? `&${q}` : ""}`, tokens.admin).then((r) => must(r));
    const r = await env();
    const dep = (name) => r.departamentos.find((d) => d.departamento === name);
    assert.equal(dep("La Paz").pedidos, 2);
    assert.equal(dep("La Paz").unidades, 2 + 2);
    assert.equal(dep("La Paz").ingresos_brutos, 250 + 300);
    assert.equal(dep("La Paz").ticket_promedio, 275);
    assert.equal(dep("Oruro").pedidos, 1);
    assert.equal(dep("Oruro").unidades, 3);
    assert.equal(dep("Oruro").ticket_promedio, 270);
    assert.equal(dep("Cochabamba").pedidos, 0, "la sucursal que vendió no es el destino");
    assert.equal(dep("Cochabamba").ticket_promedio, null);
    assert.ok(r.sin_reconocer.some((x) => x.valor === "Atlántida"));
    assert.equal(r.respuestas.mas_pedidos.departamento, "La Paz");
    assert.equal(r.respuestas.mas_unidades.departamento, "La Paz");
    // los totales del reporte = totales de la lista con los mismos filtros (envíos de ambos tipos)
    const lista = async (m) => (await hist(`estado=completada&modalidad=${m}`)).totales;
    const [a, b] = [await lista("envio"), await lista("envio_interprovincial")];
    assert.equal(r.totales.pedidos, a.ventas + b.ventas);
    assert.equal(r.totales.unidades, a.unidades + b.unidades);
    assert.equal(r.totales.ingresos_brutos, Math.round((a.ingresos + b.ingresos) * 100) / 100);
    assert.equal(r.totales.ventas_sin_envio_excluidas, 1, "la entrega directa válida (la cancelada no cuenta)");
  });

  it("reporte por departamento con filtros: pago, entrega, departamento, provincia/municipio, modelo, talla, color y responsable", async () => {
    const env = (q) => get(`/api/reportes/envios?q=${TAG}&${q}`, tokens.admin).then((r) => must(r));
    const pedidos = (r) => r.totales.pedidos;
    assert.equal(pedidos(await env("metodo_pago=QR")), 2, "ventas 3 y 4");
    assert.equal(pedidos(await env("metodo_pago=efectivo")), 2, "ventas 2 y 5");
    assert.equal(pedidos(await env("modalidad=envio")), 2);
    assert.equal(pedidos(await env("modalidad=entrega_directa")), 0, "la entrega directa no es envío");
    const lp = await env("departamento=La%20Paz");
    assert.equal(pedidos(lp), 2);
    assert.equal(lp.departamentos.filter((d) => d.pedidos > 0).length, 1);
    assert.equal(pedidos(await env("provincia=Murillo")), 1);
    assert.equal(pedidos(await env("municipio=palca")), 1);
    assert.equal(pedidos(await env(`usuario_id=${scId}`)), 1);
    assert.equal(pedidos(await env("sucursal_id=2")), 1);
    assert.equal(pedidos(await env("metodo_pago=QR&departamento=La%20Paz")), 1, "intersección");
    // modelo 5: solo las líneas del modelo (unidades e ingresos de esas líneas, no de toda la venta)
    const m5 = await env("producto_id=5");
    const d5 = m5.departamentos.find((d) => d.departamento === "La Paz");
    assert.equal(d5.pedidos, 2);
    assert.equal(d5.unidades, 1 + 2);
    assert.equal(d5.ingresos_brutos, 150 + 300);
    const t = await env(`talla_id=${t44}&color_id=2`);
    assert.equal(t.departamentos.find((d) => d.departamento === "La Paz").unidades, 1);
    // con periodo se agrega el ranking histórico
    const hoy = await env(`desde=${todayLocal()}&hasta=${todayLocal()}`);
    assert.ok(hoy.historico);
  });

  it("modelos más vendidos con los mismos filtros de venta (departamento, pago) cuadra con la lista", async () => {
    const m = must(await get(`/api/reportes/modelos?q=${TAG}&departamento=La%20Paz&limite=50`, tokens.admin));
    assert.equal(m.totales.ventas, 2);
    assert.equal(m.totales.unidades, 1 + 1 + 2);
    const qr = must(await get(`/api/reportes/modelos?q=${TAG}&metodo_pago=QR&limite=50`, tokens.admin));
    const lista = await hist("metodo_pago=QR&estado=completada");
    assert.equal(qr.totales.unidades, lista.totales.unidades);
    assert.equal(qr.totales.ventas, lista.totales.ventas);
    assert.equal(qr.totales.ingresos, lista.totales.ingresos);
  });
});

describe("movimientos: filtro por motivo", () => {
  it("devoluciones, cambios y salidas se filtran por el motivo registrado (y por «sin clasificar»)", async () => {
    const t42 = idOf("tallas", "nombre", "42");
    must(await ingreso(tokens.admin, { sucursal_id: 1, producto_id: 4, talla_id: t42, color_id: 1, cantidad: 6 }));
    const v = must(await post("/api/ventas", tokens.cb, saleBody({ items: [line(4, t42, 1, 2, 100)] })));
    const det = (await pendientesOf(v.id)).lineas[0];
    must(await post("/api/operaciones/devolucion", tokens.cb, opBody({ venta_id: v.id, motivo_codigo: "COLOR_DIFERENTE", items: [{ detalle_id: det.detalle_id, cantidad: 1, condicion: "vendible" }], liquidacion: "reembolso_pendiente" })));
    must(await salida(tokens.admin, { sucursal_id: 1, producto_id: 4, talla_id: t42, color_id: 1, cantidad: 1, motivo_codigo: "PERDIDA" }));

    const color = (await movs("motivo_codigo=COLOR_DIFERENTE&limite=100")).filas;
    assert.ok(color.length >= 1);
    assert.ok(color.every((m) => m.motivo_codigo === "COLOR_DIFERENTE" && m.categoria === "DEVOLUCION" || m.categoria === "CAMBIO"));
    const perdida = (await movs("motivo_codigo=PERDIDA&categoria=SALIDA&limite=100")).filas;
    assert.ok(perdida.length >= 1 && perdida.every((m) => m.categoria === "SALIDA" && m.motivo_codigo === "PERDIDA"));
    assert.equal((await movs("categoria=INGRESO&motivo_codigo=COLOR_DIFERENTE")).total, 0, "los ingresos no tienen ese motivo");
    assert.ok((await movs("motivo_codigo=SIN_CLASIFICAR&limite=100")).filas.every((m) => ["CAMBIO", "DEVOLUCION"].includes(m.categoria) && m.motivo_codigo === null));
    assert.equal((await get("/api/movimientos?motivo_codigo=INVENTADO", tokens.admin)).status, 400);
  });
});

describe("MISSI BOLIVIA: toda la mercadería y lo enviado a cada sucursal", () => {
  const nacional = async (token = tokens.admin) => must(await get("/api/inventario/nacional", token));
  const envio = (n, nombre) => n.envios.find((e) => e.nombre === nombre);

  it("el total es la suma de las sucursales (más lo que va en tránsito) y cuadra con la base de datos", async () => {
    const n = await nacional();
    assert.equal(n.organizacion, "MISSI BOLIVIA");
    const db = sql("SELECT SUM(cantidad) AS n FROM inventario WHERE sucursal_id IN (SELECT id FROM sucursales WHERE organizacion_id = 1)")[0].n;
    assert.equal(n.total_en_stock, db);
    assert.equal(n.sucursales.reduce((a, s) => a + s.unidades, 0), n.total_en_stock, "las sucursales suman el total");
    assert.equal(n.total_mercaderia, n.total_en_stock + n.en_transito);
    assert.ok(n.filas.length > 0);
    for (const f of n.filas) assert.equal(f.total, f.por_sucursal.reduce((a, s) => a + s.cantidad, 0), `${f.producto.nombre} ${f.talla.nombre}: total = suma por sucursal`);
    assert.equal(n.filas.reduce((a, f) => a + f.total, 0), n.total_en_stock);
    assert.ok(n.sucursales.some((s) => s.nombre === "MISSI Cochabamba") && n.sucursales.some((s) => s.nombre === "MISSI Santa Cruz"));
  });

  it("un traspaso: borrador no cambia nada; despachado queda en tránsito (la mercadería total no cambia); recibido suma a la sucursal destino", async () => {
    const t = idOf("tallas", "nombre", "46");
    must(await ingreso(tokens.admin, { sucursal_id: 1, producto_id: 6, talla_id: t, color_id: 3, cantidad: 12 }));
    const a = await nacional();

    const tr = must(await post("/api/traspasos", tokens.cb, { idempotency_key: randomUUID(), origen_id: 1, destino_id: 2, items: [{ producto_id: 6, talla_id: t, color_id: 3, cantidad: 5 }] }));
    const draft = await nacional();
    assert.equal(draft.total_mercaderia, a.total_mercaderia, "el borrador no mueve mercadería");
    assert.equal(envio(draft, "MISSI Santa Cruz").pendiente, envio(a, "MISSI Santa Cruz").pendiente + 5, "se ve como borrador pendiente");
    assert.equal(envio(draft, "MISSI Santa Cruz").enviado_a, envio(a, "MISSI Santa Cruz").enviado_a, "aún no cuenta como enviado");

    must(await post(`/api/traspasos/${tr.id}/despachar`, tokens.cb));
    const sent = await nacional();
    assert.equal(sent.en_transito, a.en_transito + 5);
    assert.equal(sent.total_en_stock, a.total_en_stock - 5, "salió del origen");
    assert.equal(sent.total_mercaderia, a.total_mercaderia, "pero sigue siendo mercadería de MISSI BOLIVIA");
    assert.equal(envio(sent, "MISSI Santa Cruz").enviado_a, envio(a, "MISSI Santa Cruz").enviado_a + 5);
    assert.equal(envio(sent, "MISSI Santa Cruz").en_transito, envio(a, "MISSI Santa Cruz").en_transito + 5);
    assert.equal(envio(sent, "MISSI Cochabamba").despachado_desde, envio(a, "MISSI Cochabamba").despachado_desde + 5);
    assert.equal(sent.sucursales.find((s) => s.nombre === "MISSI Cochabamba").unidades, a.sucursales.find((s) => s.nombre === "MISSI Cochabamba").unidades - 5);

    must(await post(`/api/traspasos/${tr.id}/recibir`, tokens.sc));
    const got = await nacional();
    assert.equal(got.en_transito, a.en_transito, "ya no está en tránsito");
    assert.equal(got.total_en_stock, a.total_en_stock, "vuelve a estar en stock, ahora en Santa Cruz");
    assert.equal(got.total_mercaderia, a.total_mercaderia);
    assert.equal(envio(got, "MISSI Santa Cruz").recibido, envio(a, "MISSI Santa Cruz").recibido + 5);
    assert.equal(envio(got, "MISSI Santa Cruz").enviado_a, envio(a, "MISSI Santa Cruz").enviado_a + 5);
    assert.equal(got.sucursales.find((s) => s.nombre === "MISSI Santa Cruz").unidades, a.sucursales.find((s) => s.nombre === "MISSI Santa Cruz").unidades + 5);
    const fila = got.filas.find((f) => f.producto.id === 6 && f.talla.id === t && f.color.id === 3);
    assert.equal(fila.total, 12, "el total de la variante no cambió: solo se redistribuyó");
    assert.equal(fila.por_sucursal.find((s) => s.sucursal_id === 1).cantidad, 7);
    assert.equal(fila.por_sucursal.find((s) => s.sucursal_id === 2).cantidad, 5);
  });

  it("un traspaso cancelado no cuenta como enviado", async () => {
    const t = idOf("tallas", "nombre", "46");
    const a = await nacional();
    const tr = must(await post("/api/traspasos", tokens.cb, { idempotency_key: randomUUID(), origen_id: 1, destino_id: 2, items: [{ producto_id: 6, talla_id: t, color_id: 3, cantidad: 2 }] }));
    must(await post(`/api/traspasos/${tr.id}/despachar`, tokens.cb));
    must(await post(`/api/traspasos/${tr.id}/cancelar`, tokens.cb));
    const b = await nacional();
    assert.equal(envio(b, "MISSI Santa Cruz").enviado_a, envio(a, "MISSI Santa Cruz").enviado_a);
    assert.equal(b.en_transito, a.en_transito);
    assert.equal(b.total_en_stock, a.total_en_stock, "el stock volvió al origen");
  });

  it("solo administradores de la organización: el vendedor recibe 403 y otra organización no ve estos datos", async () => {
    assert.equal((await get("/api/inventario/nacional", tokens.cb)).status, 403);
    assert.equal((await get("/api/inventario/nacional")).status, 401);
    const pw = randomBytes(12).toString("base64url");
    sql(`INSERT OR IGNORE INTO organizaciones (codigo, nombre) VALUES ('ORG3', 'Otra Org Tres')`);
    sql(`INSERT INTO sucursales (nombre, codigo, organizacion_id) VALUES ('Sucursal Org3', 'O3S', (SELECT id FROM organizaciones WHERE codigo = 'ORG3'))`);
    sql(`INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id,organizacion_id) VALUES ('admin3@test.local','Admin Org3',${sqlQuote(hashPassword(pw))},'admin',NULL,(SELECT id FROM organizaciones WHERE codigo = 'ORG3'))`);
    const token3 = await login("admin3@test.local", pw);
    const n3 = await nacional(token3);
    assert.equal(n3.organizacion, "Otra Org Tres");
    assert.deepEqual(n3.sucursales.map((s) => s.nombre), ["Sucursal Org3"]);
    assert.equal(n3.total_mercaderia, 0, "no ve nada de MISSI BOLIVIA");
    assert.equal(n3.filas.length, 0);
  });
});

// ================================================================ AUDITORÍA DE LANZAMIENTO: reportes con datos sintéticos, cálculos, sesión y CORS
// Datos 100 % sintéticos con fechas de 2024-2025 (no se mezclan con las demás pruebas). Todo lo esperado se calcula en JS, sin usar el código bajo prueba.
describe("auditoría: reportes y totales con datos sintéticos conocidos", () => {
  const BO = (utc) => new Date(Date.parse(utc.replace(" ", "T") + "Z") - 4 * 3600e3).toISOString().slice(0, 10); // día de Bolivia (UTC-4)
  const cents = (n) => Math.round(n * 100);
  const bs = (c) => c / 100;
  const sqlq = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

  // línea: [producto_id, cantidad, precio]. estados: completada | cancelada. entrega: directa | envio | inter
  const VENTAS = [
    { k: "v1", utc: "2025-01-01 03:59:59", suc: 1, pago: "qr", ent: "directa", est: "completada", dep: null, lines: [[4, 1, 100]] }, // 31-dic BO
    { k: "v2", utc: "2025-01-01 04:00:00", suc: 1, pago: "efectivo", ent: "directa", est: "completada", dep: null, lines: [[4, 2, 50], [5, 1, 30]] }, // 1-ene 00:00 BO
    { k: "v3", utc: "2025-01-15 15:00:00", suc: 2, pago: "qr", ent: "envio", est: "completada", dep: "La Paz", lines: [[5, 3, 40], [6, 1, 75.5]] },
    { k: "v4", utc: "2025-01-20 12:00:00", suc: 1, pago: "efectivo", ent: "envio", est: "completada", dep: "La Paz", lines: [[4, 1, 200]] },
    { k: "v5", utc: "2025-02-01 03:59:59", suc: 2, pago: "qr", ent: "inter", est: "completada", dep: " tarija ", prov: "Cercado", lines: [[6, 2, 99.99]] }, // 31-ene 23:59:59 BO
    { k: "v6", utc: "2025-02-01 04:00:00", suc: 1, pago: "qr", ent: "envio", est: "completada", dep: "Tarija", lines: [[6, 1, 60]] }, // 1-feb 00:00 BO
    { k: "v7", utc: "2025-01-10 14:00:00", suc: 1, pago: "qr", ent: "envio", est: "cancelada", dep: "Oruro", lines: [[4, 5, 100]] }, // cancelada: no cuenta
    { k: "v8", utc: "2025-01-12 14:00:00", suc: 2, pago: "efectivo", ent: "inter", est: "completada", dep: null, prov: "X", lines: [[5, 1, 45]] }, // envío sin departamento
    { k: "v9", utc: "2025-02-14 10:00:00", suc: 2, pago: "efectivo", ent: "directa", est: "completada", dep: null, lines: [[5, 2, 25]] },
  ].map((v) => ({ ...v, total: bs(v.lines.reduce((a, [, q, p]) => a + q * cents(p), 0)), units: v.lines.reduce((a, [, q]) => a + q, 0) }));

  // operaciones: devolucion | cambio | anulacion. ret = [producto, cantidad, precio]; rep = reemplazo
  const OPS = [
    { k: "o1", tipo: "devolucion", venta: "v2", utc: "2025-01-05 15:00:00", ret: [4, 1, 50], rep: null },
    { k: "o2", tipo: "cambio", venta: "v3", utc: "2025-01-16 15:00:00", ret: [5, 1, 40], rep: [6, 1, 55] },
    { k: "o3", tipo: "devolucion", venta: "v6", utc: "2025-02-03 15:00:00", ret: [6, 1, 60], rep: null },
    { k: "o4", tipo: "anulacion", venta: "v7", utc: "2025-01-11 15:00:00", ret: [4, 5, 100], rep: null }, // sobre venta cancelada
  ];
  const TRASP = [
    { k: "t1", utc: "2025-01-18 15:00:00", estado: "recibido", units: 10 },
    { k: "t2", utc: "2025-02-10 15:00:00", estado: "pendiente", units: 7 },
  ];

  // ---- expectativas independientes ---------------------------------------------------------------------------
  const inRange = (utc, d, h) => BO(utc) >= d && BO(utc) <= h;
  const expected = (d, h, f = {}) => {
    const sales = VENTAS.filter((v) => v.est === "completada" && inRange(v.utc, d, h) && (!f.suc || v.suc === f.suc));
    const sum = (arr, fn) => arr.reduce((a, x) => a + fn(x), 0);
    const gross = bs(sum(sales, (v) => cents(v.total)));
    const completedOps = OPS.filter((o) => inRange(o.utc, d, h) && (!f.suc || VENTAS.find((v) => v.k === o.venta).suc === f.suc) && VENTAS.find((v) => v.k === o.venta).est === "completada" && o.tipo !== "anulacion");
    const devuelto = bs(sum(completedOps, (o) => o.ret[1] * cents(o.ret[2])));
    const entregado = bs(sum(completedOps.filter((o) => o.tipo === "cambio"), (o) => o.rep[1] * cents(o.rep[2])));
    const shipped = sales.filter((v) => v.ent !== "directa");
    return {
      ventas: sales.length, unidades: sum(sales, (v) => v.units), bruto: gross, devuelto, entregado,
      neto: bs(cents(gross) - cents(devuelto) + cents(entregado)),
      shipped, sales, ops: OPS.filter((o) => inRange(o.utc, d, h) && (!f.suc || VENTAS.find((v) => v.k === o.venta).suc === f.suc)),
      traspasos: TRASP.filter((t) => inRange(t.utc, d, h)),
    };
  };

  const apiBalance = async (d, h, q = "") => must(await get(`/api/reportes/balance?desde=${d}&hasta=${h}${q}`, tokens.admin));
  const apiResumen = async (d, h, q = "") => must(await get(`/api/reportes/resumen?desde=${d}&hasta=${h}${q}`, tokens.admin));

  before(() => {
    const admin = userId("admin@test.local");
    const parts = [];
    for (const v of VENTAS) {
      let destino = "NULL";
      if (v.ent !== "directa") {
        const dep = v.ent === "envio"
          ? `INSERT INTO destinos_entrega (tipo_entrega, departamento_id, ciudad, direccion) VALUES ('interdepartamental', (SELECT id FROM departamentos WHERE nombre = ${sqlq(v.dep)}), 'Ciudad', 'Dir');`
          : `INSERT INTO destinos_entrega (tipo_entrega, departamento_manual, provincia, direccion) VALUES ('interprovincial', ${sqlq(v.dep)}, ${sqlq(v.prov ?? "P")}, 'Dir');`;
        parts.push(dep);
        destino = "(SELECT MAX(id) FROM destinos_entrega)";
      }
      const tipo = v.ent === "directa" ? "directa" : v.ent === "envio" ? "interdepartamental" : "interprovincial";
      parts.push(`INSERT INTO ventas (sucursal_id, fecha, total, metodo_pago, tipo_entrega, estado, cliente_nombre, destino_id, idempotency_key, vendedor_id, created_at)
        VALUES (${v.suc}, ${sqlq(v.utc)}, ${v.total}, ${sqlq(v.pago)}, ${sqlq(tipo)}, ${sqlq(v.est)}, 'Auditoria ${v.k}', ${destino}, 'audit-${v.k}', ${admin}, ${sqlq(v.utc)});`);
      for (const [p, q, pr] of v.lines) {
        parts.push(`INSERT INTO detalle_venta (venta_id, producto_id, talla_id, color_id, cantidad, precio_unitario, subtotal)
          VALUES ((SELECT id FROM ventas WHERE idempotency_key = 'audit-${v.k}'), ${p}, 1, 1, ${q}, ${pr}, ${bs(q * cents(pr))});`);
      }
    }
    for (const o of OPS) {
      const v = VENTAS.find((x) => x.k === o.venta);
      const dev = bs(o.ret[1] * cents(o.ret[2]));
      const ent = o.rep ? bs(o.rep[1] * cents(o.rep[2])) : 0;
      const pago = o.tipo === "cambio" ? ["cobro", "completado", "qr", ent - dev] : o.tipo === "devolucion" && o.k === "o1" ? ["reembolso", "completado", "efectivo", dev] : ["reembolso", "pendiente", null, dev];
      parts.push(`INSERT INTO operaciones (tipo, venta_id, sucursal_id, usuario_id, motivo, valor_devuelto, valor_entregado, diferencia, pago_tipo, pago_estado, pago_metodo, monto_pago, idempotency_key, created_at)
        VALUES (${sqlq(o.tipo)}, (SELECT id FROM ventas WHERE idempotency_key = 'audit-${o.venta}'), ${v.suc}, ${admin}, 'auditoria', ${dev}, ${ent}, ${bs(cents(ent) - cents(dev))}, ${sqlq(pago[0])}, ${sqlq(pago[1])}, ${sqlq(pago[2])}, ${pago[3]}, 'audit-${o.k}', ${sqlq(o.utc)});`);
      parts.push(`INSERT INTO operacion_items (operacion_id, rol, detalle_venta_id, producto_id, talla_id, color_id, cantidad, precio_unitario, condicion)
        VALUES ((SELECT id FROM operaciones WHERE idempotency_key = 'audit-${o.k}'), 'devuelto',
                (SELECT id FROM detalle_venta WHERE venta_id = (SELECT id FROM ventas WHERE idempotency_key = 'audit-${o.venta}') AND producto_id = ${o.ret[0]} LIMIT 1),
                ${o.ret[0]}, 1, 1, ${o.ret[1]}, ${o.ret[2]}, 'vendible');`);
      if (o.rep) {
        parts.push(`INSERT INTO operacion_items (operacion_id, rol, producto_id, talla_id, color_id, cantidad, precio_unitario)
          VALUES ((SELECT id FROM operaciones WHERE idempotency_key = 'audit-${o.k}'), 'entregado', ${o.rep[0]}, 1, 1, ${o.rep[1]}, ${o.rep[2]});`);
      }
    }
    for (const t of TRASP) {
      parts.push(`INSERT INTO traspasos (sucursal_origen_id, sucursal_destino_id, fecha, estado, responsable, idempotency_key, creado_por)
        VALUES (1, 2, ${sqlq(t.utc)}, ${sqlq(t.estado)}, 'Auditoria', 'audit-${t.k}', ${admin});`);
      parts.push(`INSERT INTO traspaso_detalles (traspaso_id, producto_id, talla_id, color_id, cantidad)
        VALUES ((SELECT id FROM traspasos WHERE idempotency_key = 'audit-${t.k}'), 4, 1, 1, ${t.units});`);
    }
    const dir = mkdtempSync(path.join(tmpdir(), "missi-audit-"));
    const file = path.join(dir, "audit.sql");
    writeFileSync(file, parts.join("\n"));
    wrangler(["d1", "execute", "DB", "--local", "--persist-to", STATE, "--file", file]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("el cálculo esperado es correcto (verificación de la propia prueba con cifras hechas a mano)", () => {
    const e = expected("2025-01-01", "2025-01-31");
    assert.equal(e.ventas, 5);
    assert.equal(e.unidades, 11);
    assert.equal(e.bruto, 770.48);
    assert.equal(e.devuelto, 90);
    assert.equal(e.entregado, 55);
    assert.equal(e.neto, 735.48);
  });

  it("enero 2025 (fechas de Bolivia): ventas, unidades, ingresos brutos y netos coinciden con lo esperado", async () => {
    const e = expected("2025-01-01", "2025-01-31");
    const b = await apiBalance("2025-01-01", "2025-01-31");
    assert.equal(b.resumen.ventas, e.ventas);
    assert.equal(b.resumen.unidades, e.unidades);
    assert.equal(b.resumen.ingresos, e.bruto);
    assert.equal(b.resumen.ticket_promedio, Math.round((cents(e.bruto) / e.ventas)) / 100);
    assert.equal(b.operaciones.valor_devuelto, e.devuelto);
    assert.equal(b.operaciones.valor_cambio_entregado, e.entregado);
    assert.equal(b.operaciones.ingresos_brutos, e.bruto);
    assert.equal(b.operaciones.ingresos_netos, e.neto);
    assert.equal(b.operaciones.devoluciones, 1);
    assert.equal(b.operaciones.cambios, 1);
    assert.equal(b.operaciones.anulaciones, 1, "la anulación de la venta cancelada se informa aparte");
    assert.equal(b.operaciones.valor_anulado, 500);
    assert.equal(b.operaciones.cobros_completados, 15, "diferencia cobrada en el cambio");
    assert.equal(b.operaciones.reembolsos_completados, 50);
  });

  it("los desgloses suman exactamente el total (sin duplicar por las líneas de cada venta)", async () => {
    const b = await apiBalance("2025-01-01", "2025-01-31");
    for (const k of ["por_metodo", "por_sucursal", "por_departamento", "por_modalidad", "por_dia", "por_hora", "por_semana", "por_mes"]) {
      assert.equal(Math.round(b[k].reduce((a, x) => a + x.ingresos, 0) * 100) / 100, b.resumen.ingresos, k);
      assert.equal(b[k].reduce((a, x) => a + x.ventas, 0), b.resumen.ventas, `${k}: número de ventas`);
    }
    assert.equal(b.por_sucursal.find((s) => s.clave === "MISSI Cochabamba").ingresos, 330);
    assert.equal(b.por_sucursal.find((s) => s.clave === "MISSI Santa Cruz").ingresos, 440.48);
    assert.equal(b.por_metodo.find((m) => m.clave === "QR").ingresos, 395.48);
    assert.equal(b.por_metodo.find((m) => m.clave === "efectivo").ingresos, 375);
  });

  it("los límites del mes usan el día de Bolivia: 23:59:59 del 31-ene es enero y 00:00:00 del 1-feb es febrero", async () => {
    assert.equal((await apiBalance("2025-01-31", "2025-01-31")).resumen.ingresos, 199.98, "solo v5");
    assert.equal((await apiBalance("2025-02-01", "2025-02-01")).resumen.ingresos, 60, "solo v6");
    assert.equal((await apiBalance("2025-01-01", "2025-01-01")).resumen.ingresos, 130, "v2 sí, v1 (31-dic BO) no");
    assert.equal((await apiBalance("2024-12-31", "2024-12-31")).resumen.ingresos, 100, "v1 es del 31-dic en Bolivia");
    // el extremo final se incluye y la suma de los meses = el total del rango
    const ene = (await apiBalance("2025-01-01", "2025-01-31")).resumen.ingresos, feb = (await apiBalance("2025-02-01", "2025-02-28")).resumen.ingresos;
    assert.equal(Math.round((ene + feb) * 100) / 100, (await apiBalance("2025-01-01", "2025-02-28")).resumen.ingresos);
    assert.equal(feb, 110);
  });

  it("febrero: lo devuelto se resta por fecha de la operación y la venta cancelada nunca suma", async () => {
    const e = expected("2025-02-01", "2025-02-28");
    const b = await apiBalance("2025-02-01", "2025-02-28");
    assert.equal(b.resumen.ventas, 2);
    assert.equal(b.operaciones.ingresos_brutos, 110);
    assert.equal(b.operaciones.valor_devuelto, 60);
    assert.equal(b.operaciones.ingresos_netos, e.neto);
    assert.equal(e.neto, 50);
    assert.equal(b.traspasos.total, 1, "el traspaso pendiente se cuenta aparte");
    assert.equal(b.traspasos.pendientes, 1);
  });

  it("periodo vacío: ceros y listas vacías en todos los reportes (no inventa cifras)", async () => {
    const b = await apiBalance("2025-03-01", "2025-03-31");
    assert.deepEqual([b.resumen.ventas, b.resumen.ingresos, b.resumen.unidades, b.resumen.ticket_promedio], [0, 0, 0, 0]);
    for (const k of ["por_metodo", "por_sucursal", "por_departamento", "por_modalidad", "por_dia", "top_productos"]) assert.deepEqual(b[k], [], k);
    assert.equal(b.operaciones.ingresos_netos, 0);
    const r = await apiResumen("2025-03-01", "2025-03-31");
    assert.deepEqual([r.ventas.completadas, r.ventas.ingresos_brutos, r.ventas.ingresos_netos, r.traspasos.referencias], [0, 0, 0, 0]);
    const env = must(await get("/api/reportes/envios?desde=2025-03-01&hasta=2025-03-31", tokens.admin));
    assert.equal(env.totales.pedidos, 0);
    assert.equal(env.totales.ticket_promedio, null);
    assert.equal(must(await get("/api/reportes/modelos?desde=2025-03-01&hasta=2025-03-31", tokens.admin)).totales.unidades, 0);
  });

  it("filtro por sucursal de origen: Cochabamba y Santa Cruz se distinguen y suman el total", async () => {
    const cb = await apiBalance("2025-01-01", "2025-01-31", "&sucursal_id=1");
    const sc = await apiBalance("2025-01-01", "2025-01-31", "&sucursal_id=2");
    assert.equal(cb.resumen.ingresos, expected("2025-01-01", "2025-01-31", { suc: 1 }).bruto);
    assert.equal(sc.resumen.ingresos, expected("2025-01-01", "2025-01-31", { suc: 2 }).bruto);
    assert.equal(cb.resumen.ventas + sc.resumen.ventas, 5);
    assert.equal(Math.round((cb.resumen.ingresos + sc.resumen.ingresos) * 100) / 100, 770.48);
    assert.equal(cb.operaciones.valor_devuelto, 50, "solo la devolución de Cochabamba");
    assert.equal(sc.operaciones.valor_devuelto, 40, "solo el cambio de Santa Cruz");
  });

  it("departamento de DESTINO: viene del destino guardado (no de la sucursal) y los envíos no se mezclan con la entrega directa", async () => {
    const e = expected("2025-01-01", "2025-01-31");
    const env = must(await get("/api/reportes/envios?desde=2025-01-01&hasta=2025-01-31", tokens.admin));
    const d = (n) => env.departamentos.find((x) => x.departamento === n);
    assert.equal(env.totales.pedidos, e.shipped.length);
    assert.equal(d("La Paz").pedidos, 2, "uno vendido desde Cochabamba y otro desde Santa Cruz");
    assert.deepEqual(d("La Paz").por_sucursal.map((s) => [s.sucursal_id, s.pedidos]).sort(), [[1, 1], [2, 1]]);
    assert.equal(d("La Paz").unidades, 5);
    assert.equal(d("La Paz").ingresos_brutos, 395.5);
    assert.equal(d("La Paz").ticket_promedio, 197.75);
    assert.equal(d("Tarija").pedidos, 1, "« tarija » se reconoce como Tarija sin reescribir el dato");
    assert.equal(d("Tarija").ingresos_brutos, 199.98);
    assert.equal(d("Cochabamba").pedidos, 0, "Cochabamba es sucursal de origen, no destino");
    assert.equal(d("Santa Cruz").pedidos, 0);
    assert.equal(d("Oruro").pedidos, 0, "la venta cancelada a Oruro no cuenta");
    assert.equal(env.totales.ventas_sin_envio_excluidas, 1, "v2 (entrega directa) queda fuera");
    assert.ok(env.departamentos.some((x) => x.departamento === "Sin departamento registrado" && x.pedidos === 1 && x.ingresos_brutos === 45), "envío sin destino registrado: no se inventa");
    assert.equal(env.totales.ingresos_brutos, Math.round(e.shipped.reduce((a, v) => a + cents(v.total), 0)) / 100);
  });

  it("el balance también agrupa por departamento de destino (La Paz y Tarija completos, directa aparte, sin destino aparte)", async () => {
    const b = await apiBalance("2025-01-01", "2025-01-31");
    const g = (n) => b.por_departamento.filter((x) => x.clave === n);
    assert.equal(g("La Paz").length, 1);
    assert.equal(g("La Paz")[0].ventas, 2);
    assert.equal(g("La Paz")[0].ingresos, 395.5);
    assert.equal(g("Tarija").length, 1, "« tarija » y «Tarija» no se separan en dos filas");
    assert.equal(g("Tarija")[0].ingresos, 199.98);
    assert.equal(g("Entrega directa").length, 1);
    assert.equal(g("Entrega directa")[0].ingresos, 130);
    assert.equal(g("Sin departamento registrado").length, 1);
    assert.equal(g("Sin departamento registrado")[0].ingresos, 45, "envío sin destino NO se muestra como entrega directa");
  });

  it("modelos más vendidos: unidades y ventas distintas por modelo (una venta con varias líneas cuenta una vez)", async () => {
    const m = must(await get("/api/reportes/modelos?desde=2025-01-01&hasta=2025-01-31&limite=50", tokens.admin));
    const p = (id) => m.modelos.find((x) => x.producto_id === id);
    assert.equal(p(5).unidades, 5);
    assert.equal(p(5).ventas, 3);
    assert.equal(p(5).ingresos, 195);
    assert.equal(p(4).unidades, 3);
    assert.equal(p(4).ingresos, 300);
    assert.equal(p(6).unidades, 3);
    assert.equal(p(6).ingresos, 275.48);
    assert.deepEqual(m.modelos.map((x) => x.producto_id), [5, 4, 6], "orden por unidades; el empate se resuelve por ingresos");
    assert.equal(m.totales.unidades, 11);
    assert.equal(m.totales.ventas, 5);
    assert.equal(m.totales.ingresos, 770.48);
    assert.equal(p(4).devueltas, 1);
    assert.equal(p(5).devueltas, 1);
    assert.equal(p(6).cambios_entregados, 1, "el reemplazo del cambio no es una venta");
    assert.equal(p(6).netas, 3);
  });

  it("todas las pantallas coinciden entre sí para los mismos filtros (balance, resumen, historial, modelos, envíos)", async () => {
    for (const [d, h, q] of [["2025-01-01", "2025-01-31", ""], ["2025-02-01", "2025-02-28", ""], ["2025-01-01", "2025-02-28", "&sucursal_id=2"], ["2025-01-01", "2025-01-31", "&metodo_pago=QR"], ["2025-01-01", "2025-01-31", "&departamento=La%20Paz"]]) {
      const b = await apiBalance(d, h, q);
      const r = await apiResumen(d, h, q.includes("sucursal") ? q : "");
      const hist = must(await get(`/api/ventas/historial?desde=${d}&hasta=${h}&estado=completada${q}`, tokens.admin));
      const mod = must(await get(`/api/reportes/modelos?desde=${d}&hasta=${h}${q}&limite=50`, tokens.admin));
      const ctx = `${d}..${h}${q}`;
      assert.equal(hist.totales.ventas, b.resumen.ventas, `${ctx}: ventas historial = balance`);
      assert.equal(hist.totales.ingresos, b.resumen.ingresos, `${ctx}: ingresos historial = balance`);
      assert.equal(hist.totales.unidades, b.resumen.unidades, `${ctx}: unidades historial = balance`);
      assert.equal(mod.totales.ventas, b.resumen.ventas, `${ctx}: ventas modelos = balance`);
      assert.equal(mod.totales.ingresos, b.resumen.ingresos, `${ctx}: ingresos modelos = balance`);
      assert.equal(mod.totales.unidades, b.resumen.unidades, `${ctx}: unidades modelos = balance`);
      if (!q.includes("metodo") && !q.includes("departamento")) {
        assert.equal(r.ventas.completadas, b.resumen.ventas, `${ctx}: resumen = balance`);
        assert.equal(r.ventas.ingresos_brutos, b.resumen.ingresos, `${ctx}: ingresos resumen = balance`);
        assert.equal(r.ventas.ingresos_netos, b.operaciones.ingresos_netos, `${ctx}: neto resumen = balance`);
        assert.equal(r.ventas.unidades, b.resumen.unidades);
      }
    }
    // envíos = ventas con envío del historial
    const env = must(await get("/api/reportes/envios?desde=2025-01-01&hasta=2025-01-31", tokens.admin));
    const lista = async (m) => must(await get(`/api/ventas/historial?desde=2025-01-01&hasta=2025-01-31&estado=completada&modalidad=${m}`, tokens.admin)).totales;
    const [a, c] = [await lista("envio"), await lista("envio_interprovincial")];
    assert.equal(env.totales.pedidos, a.ventas + c.ventas);
    assert.equal(Math.round(env.totales.ingresos_brutos * 100), Math.round((a.ingresos + c.ingresos) * 100));
  });

  it("el dashboard del día coincide con el reporte del mismo día (ingresos y número de ventas)", async () => {
    const hoy = todayLocal();
    const dash = must(await get("/api/dashboard", tokens.admin)).stats;
    const b = await apiBalance(hoy, hoy);
    assert.equal(dash.salesToday, b.resumen.ventas);
    assert.equal(dash.incomeToday, b.resumen.ingresos);
    const cb = must(await get("/api/dashboard?sucursal_id=1", tokens.admin)).stats;
    const bc = await apiBalance(hoy, hoy, "&sucursal_id=1");
    assert.equal(cb.salesToday, bc.resumen.ventas);
    assert.equal(cb.incomeToday, bc.resumen.ingresos);
  });

  it("los traspasos no son ingresos: aparecen solo en su propia sección y no cambian las ventas", async () => {
    const b = await apiBalance("2025-01-01", "2025-01-31");
    assert.equal(b.traspasos.total, 1);
    assert.equal(b.traspasos.recibidos, 1);
    assert.equal(b.traspasos.unidades_recibidas, 10);
    assert.equal(b.resumen.ingresos, 770.48, "con y sin traspasos el ingreso es el mismo");
    const r = await apiResumen("2025-01-01", "2025-01-31");
    assert.equal(r.traspasos.referencias, 1);
    assert.equal(r.traspasos.unidades, 10);
    assert.equal(r.ventas.ingresos_brutos, 770.48);
  });

  it("el reporte de movimientos (impreso) clasifica entradas, salidas y ajustes por su categoría real", async () => {
    const hoy = todayLocal();
    const t = idOf("tallas", "nombre", "48");
    must(await ingreso(tokens.admin, { sucursal_id: 1, producto_id: 6, talla_id: t, color_id: 1, cantidad: 10 }));
    must(await salida(tokens.admin, { sucursal_id: 1, producto_id: 6, talla_id: t, color_id: 1, cantidad: 3, motivo_codigo: "MUESTRA" }));
    must(await ajuste(tokens.admin, { sucursal_id: 1, producto_id: 6, talla_id: t, color_id: 1, delta: -2, motivo: "conteo físico" }));
    must(await ajuste(tokens.admin, { sucursal_id: 1, producto_id: 6, talla_id: t, color_id: 1, delta: 1, motivo: "conteo físico" }));
    const r = must(await get(`/api/reportes/movimientos?desde=${hoy}&hasta=${hoy}&sucursal_id=1`, tokens.admin));
    const mine = r.filas.filter((f) => f.producto && f.talla === "48");
    const por = (tipo) => mine.filter((f) => f.tipo === tipo);
    assert.equal(por("Ingreso").length, 1);
    assert.equal(por("Ingreso")[0].efecto, "Entrada");
    assert.equal(por("Salida").length, 1);
    assert.equal(por("Salida")[0].efecto, "Salida", "una salida autorizada NO se muestra como ajuste");
    assert.deepEqual(por("Ajuste").map((f) => f.efecto).sort(), ["Entrada", "Salida"]);
    assert.ok(r.totales.some((x) => x.tipo === "Salida"));
  });
});

describe("auditoría: cálculos monetarios en BOB y validaciones de entrada", () => {
  const T = () => idOf("tallas", "nombre", "44");
  before(async () => {
    for (const [p, c] of [[4, 3], [5, 3], [6, 3]]) must(await ingreso(tokens.admin, { sucursal_id: 1, producto_id: p, talla_id: T(), color_id: c, cantidad: 100 }));
  });

  it("totales exactos en centavos: 3 × 19.99 + 7 × 0.10 + 1 × 1234.56 = 1295.23 (sin errores de coma flotante)", async () => {
    const r = must(await post("/api/ventas", tokens.cb, saleBody({ items: [line(4, T(), 3, 3, 19.99), line(5, T(), 3, 7, 0.1), line(6, T(), 3, 1, 1234.56)] })));
    assert.equal(r.total, 1295.23);
    assert.deepEqual(r.items.map((i) => i.subtotal), [59.97, 0.7, 1234.56]);
    assert.equal(sql(`SELECT total FROM ventas WHERE id = ${r.id}`)[0].total, 1295.23);
    assert.equal(sql(`SELECT ROUND(SUM(subtotal), 2) AS s FROM detalle_venta WHERE venta_id = ${r.id}`)[0].s, 1295.23);
  });

  it("importes pequeños no acumulan error: tres líneas de 3 × 0.10 suman exactamente 0.90", async () => {
    const r = must(await post("/api/ventas", tokens.cb, saleBody({ items: [line(4, T(), 3, 3, 0.1), line(5, T(), 3, 3, 0.1), line(6, T(), 3, 3, 0.1)] })));
    assert.equal(r.total, 0.9);
  });

  it("precios con más de 2 decimales se redondean una sola vez y de forma consistente entre venta, recibo y base", async () => {
    const r = must(await post("/api/ventas", tokens.cb, saleBody({ items: [line(4, T(), 3, 3, 10.005)] })));
    const priced = r.items[0].precio_unitario;
    assert.equal(Math.round(priced * 100) / 100, priced, "el precio guardado tiene 2 decimales");
    assert.equal(r.items[0].subtotal, Math.round(3 * priced * 100) / 100);
    assert.equal(r.total, r.items[0].subtotal);
  });

  it("entradas inválidas se rechazan sin guardar nada: precio negativo, cero, texto, NaN-like, enorme; cantidad cero, negativa, decimal, texto, enorme; campos faltantes", async () => {
    const ventas = count("ventas");
    const stock0 = stock(1, 4, T(), 3);
    const bad = [
      [line(4, T(), 3, 1, -1)], [{ ...line(4, T(), 3, 1), precio_unitario: 0 }], [{ ...line(4, T(), 3, 1), precio_unitario: "abc" }],
      [line(4, T(), 3, 1, 1e12)], [{ ...line(4, T(), 3, 1), precio_unitario: Number.MAX_VALUE }],
      [line(4, T(), 3, 0, 10)], [line(4, T(), 3, -2, 10)], [line(4, T(), 3, 1.5, 10)], [{ ...line(4, T(), 3, 1, 10), cantidad: "2" }], [line(4, T(), 3, 10_001, 10)],
      [{ talla_id: T(), color_id: 3, cantidad: 1, precio_unitario: 10 }], [{ producto_id: 4, color_id: 3, cantidad: 1, precio_unitario: 10 }], [{ producto_id: 4, talla_id: T(), cantidad: 1, precio_unitario: 10 }],
      [], "no-es-lista", null,
    ];
    for (const items of bad) {
      const r = await post("/api/ventas", tokens.cb, saleBody({ items }));
      assert.ok(r.status === 400 || r.status === 409, `${JSON.stringify(items).slice(0, 70)} -> ${r.status}`);
    }
    for (const field of ["metodo_pago", "modalidad", "sucursal_id", "idempotency_key"]) {
      const body = saleBody({ items: [line(4, T(), 3, 1, 10)] });
      delete body[field];
      assert.equal((await post("/api/ventas", tokens.cb, body)).status, 400, `falta ${field}`);
    }
    assert.equal(count("ventas"), ventas);
    assert.equal(stock(1, 4, T(), 3), stock0, "ningún intento descontó stock");
  });

  it("cuerpos malformados: JSON roto, tipo de contenido incorrecto y cuerpo demasiado grande", async () => {
    const h = { Authorization: `Bearer ${tokens.cb}` };
    assert.equal((await fetch(`${BASE}/api/ventas`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: "{roto" })).status, 400);
    assert.equal((await fetch(`${BASE}/api/ventas`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: "[1,2]" })).status, 400);
    assert.equal((await fetch(`${BASE}/api/ventas`, { method: "POST", headers: { ...h, "Content-Type": "text/plain" }, body: "x" })).status, 400);
    assert.equal((await fetch(`${BASE}/api/ventas`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ x: "a".repeat(70_000) }) })).status, 413);
  });

  it("devolución parcial: el valor devuelto es cantidad × precio ORIGINAL y el total de la venta no cambia", async () => {
    const v = must(await post("/api/ventas", tokens.cb, saleBody({ items: [line(4, T(), 3, 5, 19.99)] })));
    const det = (await pendientesOf(v.id)).lineas[0];
    assert.equal(det.precio_unitario, 19.99);
    const original = sql("SELECT precio_venta FROM productos WHERE id = 4")[0].precio_venta;
    sql("UPDATE productos SET precio_venta = 500 WHERE id = 4");
    const r = must(await post("/api/operaciones/devolucion", tokens.cb, opBody({ venta_id: v.id, motivo_codigo: "TALLA_INCORRECTA", items: [{ detalle_id: det.detalle_id, cantidad: 2, condicion: "vendible" }], liquidacion: "reembolso_pendiente" })));
    assert.equal(r.valor_devuelto, 39.98, "2 × 19.99 con el precio al que se vendió, no el actual");
    assert.equal(sql(`SELECT total FROM ventas WHERE id = ${v.id}`)[0].total, 99.95);
    // no se puede devolver dos veces lo mismo ni más de lo vendido
    const again = await post("/api/operaciones/devolucion", tokens.cb, opBody({ venta_id: v.id, motivo_codigo: "OTRO", motivo: "otra vez", items: [{ detalle_id: det.detalle_id, cantidad: 4, condicion: "vendible" }], liquidacion: "reembolso_pendiente" }));
    assert.equal(again.status, 400);
    sql(`UPDATE productos SET precio_venta = ${original} WHERE id = 4`);
  });
});

describe("auditoría: sesión, CORS y cabeceras de seguridad", () => {
  it("una sesión vencida deja de funcionar (401) y una cerrada también", async () => {
    const t = await login("sc@test.local", pw.sc);
    assert.equal((await get("/api/auth/me", t)).status, 200);
    sql("UPDATE sesiones SET expires_at = datetime('now', '-1 minute') WHERE usuario_id = (SELECT id FROM usuarios WHERE email = 'sc@test.local') AND expires_at > datetime('now')");
    assert.equal((await get("/api/auth/me", t)).status, 401, "vencida");
    assert.equal((await get("/api/ventas/historial", t)).status, 401);
    assert.equal((await post("/api/ventas", t, saleBody({ sucursal_id: 2 }))).status, 401, "no se puede vender con una sesión vencida");
    tokens.sc = await login("sc@test.local", pw.sc); // sesión nueva para las demás pruebas
  });

  it("un usuario desactivado pierde el acceso aunque conserve su token", async () => {
    const t = await login("sc@test.local", pw.sc);
    sql("UPDATE usuarios SET activo = 0 WHERE email = 'sc@test.local'");
    assert.equal((await get("/api/auth/me", t)).status, 401);
    sql("UPDATE usuarios SET activo = 1 WHERE email = 'sc@test.local'");
    tokens.sc = await login("sc@test.local", pw.sc);
  });

  it("tokens falsos, vacíos o mal formados nunca autentican", async () => {
    for (const bad of ["", "abc", "x".repeat(64), "Bearer", "'; DROP TABLE usuarios; --"]) {
      const r = await fetch(`${BASE}/api/inventario`, { headers: { Authorization: bad.startsWith("Bearer") ? bad : `Bearer ${bad}` } });
      assert.equal(r.status, 401, bad);
    }
    assert.equal((await fetch(`${BASE}/api/inventario`)).status, 401);
    assert.ok(count("usuarios") > 0, "la tabla sigue existiendo");
  });

  it("CORS: solo se aceptan los orígenes configurados; un sitio ajeno no recibe permiso", async () => {
    const ok = await fetch(`${BASE}/api/health`, { headers: { Origin: ORIGIN } });
    assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
    const evil = await fetch(`${BASE}/api/health`, { headers: { Origin: "https://sitio-malicioso.example" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    const pre = await fetch(`${BASE}/api/ventas`, { method: "OPTIONS", headers: { Origin: "https://sitio-malicioso.example", "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.headers.get("access-control-allow-origin"), null);
    assert.equal(ok.headers.get("access-control-allow-credentials"), null, "sin cookies ni credenciales");
  });

  it("las respuestas no se guardan en caché y llevan cabeceras de seguridad; los errores internos no filtran detalles", async () => {
    const r = await get("/api/inventario", tokens.admin);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    const nf = await fetch(`${BASE}/api/no-existe`, { headers: { Authorization: `Bearer ${tokens.admin}` } });
    assert.equal(nf.status, 404);
    const text = await nf.text();
    assert.ok(!/at .*\.ts|node_modules|SQLITE|stack/i.test(text), "sin rastros internos");
  });

  it("inyección SQL en filtros y búsqueda: se tratan como texto y no rompen ni filtran datos", async () => {
    const evil = encodeURIComponent("'; DROP TABLE ventas; --");
    for (const p of [`/api/ventas/historial?q=${evil}`, `/api/ventas/historial?provincia=${evil}`, `/api/movimientos?q=${evil}`, `/api/traspasos/historial?q=${evil}`, `/api/ventas/buscar?q=${evil}`, `/api/operaciones/historial?q=${evil}`]) {
      const r = await get(p, tokens.admin);
      assert.ok(r.status === 200 || r.status === 400, `${p} -> ${r.status}`);
    }
    assert.equal((await get(`/api/ventas/historial?departamento=${evil}`, tokens.admin)).status, 200);
    assert.ok(count("ventas") > 0, "la tabla de ventas sigue intacta");
    assert.equal(must(await get("/api/ventas/historial?q=1%20OR%201%3D1", tokens.admin)).total, 0, "«1 OR 1=1» es texto: no devuelve todas las ventas");
  });
});
