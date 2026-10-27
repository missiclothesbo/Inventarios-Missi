// Pruebas de almacén central (MISSI BOLIVIA), lotes, recepciones y trazabilidad de traspasos y ventas.
// Base D1 LOCAL aislada (Miniflare) en .wrangler/test-lotes-state, puerto 8797. No toca la base de desarrollo
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
const STATE = ".wrangler/test-lotes-state";
const stateAbs = path.join(root, STATE);
const wranglerJs = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const PORT = 8797;
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
    `INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id) VALUES (${sqlQuote("admin@lotes.test")},'Admin Lotes',${sqlQuote(hashPassword(pw.admin))},'admin',NULL);`,
    `INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id) VALUES (${sqlQuote("cb@lotes.test")},'Vend CB',${sqlQuote(hashPassword(pw.cb))},'vendedor',1);`,
    `INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id) VALUES (${sqlQuote("sc@lotes.test")},'Vend SC',${sqlQuote(hashPassword(pw.sc))},'vendedor',2);`,
    "UPDATE productos SET precio_venta = 135 WHERE id = 1;",
  ].join("\n");
  const dir = mkdtempSync(path.join(tmpdir(), "missi-lotes-seed-"));
  const file = path.join(dir, "seed.sql");
  writeFileSync(file, seed);
  wrangler(["d1", "execute", "DB", "--local", "--persist-to", STATE, "--file", file]);
  rmSync(dir, { recursive: true, force: true });

  const logFd = openSync(path.join(tmpdir(), "missi-wrangler-lotes.log"), "w");
  server = spawn(process.execPath, [wranglerJs, "dev", "--local", "--port", String(PORT), "--inspector-port", "9237", "--persist-to", STATE], { cwd: root, stdio: ["ignore", logFd, logFd] });
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* aún arrancando */ }
    if (Date.now() - t0 > 90_000) throw new Error("wrangler dev no arrancó");
    await new Promise((res) => setTimeout(res, 500));
  }
  tokens.admin = await login("admin@lotes.test", pw.admin);
  tokens.cb = await login("cb@lotes.test", pw.cb);
  tokens.sc = await login("sc@lotes.test", pw.sc);
});

after(() => {
  if (server?.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  try { rmSync(stateAbs, { recursive: true, force: true }); } catch { /* se limpia en la próxima ejecución */ }
});

// ---------------------------------------------------------------- ayudas
const hace = (dias, horas = 0) => new Date(Date.now() - dias * 86_400_000 - horas * 3_600_000).toISOString();
const id1 = (q) => sql(q)[0]?.id;
const lotsOf = (suc, p, t, c) =>
  sql(`SELECT id, COALESCE(lote_raiz_id, id) AS raiz, origen, cantidad_inicial, cantidad_restante, fecha_recepcion, fecha_llegada, lote_origen_id
         FROM lotes WHERE sucursal_id=${suc} AND producto_id=${p} AND talla_id=${t} AND color_id=${c} ORDER BY id`);
/** Total de la empresa para una variante: stock en todas las ubicaciones + lo que va en camino. */
const companyTotal = (p, t, c) =>
  sql(`SELECT (SELECT COALESCE(SUM(cantidad),0) FROM inventario WHERE producto_id=${p} AND talla_id=${t} AND color_id=${c})
            + (SELECT COALESCE(SUM(d.cantidad),0) FROM traspaso_detalles d JOIN traspasos tr ON tr.id = d.traspaso_id
                WHERE tr.estado = 'enviado' AND d.producto_id=${p} AND d.talla_id=${t} AND d.color_id=${c}) AS n`)[0].n;
/** Regla central: en cada ubicación y variante, la suma de lotes = stock. Devuelve las que no cuadran. */
const descuadres = () =>
  sql(`SELECT i.sucursal_id, i.producto_id, i.talla_id, i.color_id, i.cantidad,
              (SELECT COALESCE(SUM(l.cantidad_restante),0) FROM lotes l WHERE l.sucursal_id=i.sucursal_id AND l.producto_id=i.producto_id
                AND l.talla_id=i.talla_id AND l.color_id=i.color_id) AS lotes
         FROM inventario i
        WHERE i.cantidad <> (SELECT COALESCE(SUM(l.cantidad_restante),0) FROM lotes l WHERE l.sucursal_id=i.sucursal_id
                AND l.producto_id=i.producto_id AND l.talla_id=i.talla_id AND l.color_id=i.color_id)`);

const ctx = {};
before(() => {
  ctx.MBO = id1("SELECT id FROM sucursales WHERE tipo = 'almacen'");
  ctx.CB = 1;
  ctx.SC = 2;
  ctx.M = id1("SELECT id FROM tallas WHERE nombre = 'M'");
  ctx.G = id1("SELECT id FROM tallas WHERE nombre = 'G'");
  ctx.NEGRO = id1("SELECT id FROM colores WHERE nombre = 'Negro'");
  ctx.AZUL = id1("SELECT id FROM colores WHERE nombre = 'Azul'");
});
const recibir = (token, items, over = {}) =>
  post("/api/recepciones", token, {
    idempotency_key: randomUUID(), sucursal_id: ctx.MBO, fecha_recepcion: hace(3), proveedor: "Textiles Andinos", referencia: "F-001", items, ...over,
  });
const item = (p, t, c, n) => ({ producto_id: p, talla_id: t, color_id: c, cantidad: n });

describe("almacén central MISSI BOLIVIA", () => {
  it("existe como ubicación de tipo almacén, única; el administrador la ve y el vendedor no", async () => {
    assert.ok(ctx.MBO, "la migración crea el almacén");
    const admin = must(await get("/api/sucursales", tokens.admin));
    const mbo = admin.find((s) => s.id === ctx.MBO);
    assert.equal(mbo.nombre, "Almacén Central");
    assert.equal(mbo.es_central, true, "ubicación principal");
    assert.equal(admin.find((s) => s.id === ctx.CB).es_central, false);
    assert.ok(!admin.some((s) => /MISSI BOLIVIA/.test(s.nombre)), "ya no existe una ubicación MISSI BOLIVIA");
    assert.equal(mbo.es_almacen, true);
    assert.equal(admin.filter((s) => s.es_almacen).length, 1);
    assert.deepEqual(must(await get("/api/sucursales", tokens.cb)).map((s) => s.id), [ctx.CB]);
    // No puede haber un segundo almacén en la misma organización (índice único).
    assert.throws(() => sql("INSERT INTO sucursales (nombre, codigo, organizacion_id, tipo) VALUES ('Otro almacén', 'ALM2', 1, 'almacen')"), /UNIQUE/);
  });
});

describe("las tres ubicaciones operan: Almacén Central, Santa Cruz y Cochabamba", () => {
  it("el Almacén Central recibe mercadería, vende y traspasa; el inventario muestra la fecha y hora de ingreso", async () => {
    const fecha = hace(2, 5);
    must(await post("/api/recepciones", tokens.admin, { idempotency_key: randomUUID(), sucursal_id: ctx.MBO, fecha_recepcion: fecha, items: [item(3, ctx.M, ctx.NEGRO, 9)] }));
    // venta en el almacén
    must(await post("/api/ventas", tokens.admin, { idempotency_key: randomUUID(), sucursal_id: ctx.MBO, metodo_pago: "efectivo", modalidad: "entrega_directa", items: [{ ...item(3, ctx.M, ctx.NEGRO, 2), precio_unitario: 80 }] }));
    assert.equal(stock(ctx.MBO, 3, ctx.M, ctx.NEGRO), 7);
    // la fecha y hora de ingreso se ve en el inventario de la ubicación
    const fila = must(await get(`/api/inventario?sucursal_id=${ctx.MBO}`, tokens.admin)).find((r) => r.producto.id === 3 && r.talla.id === ctx.M && r.color.id === ctx.NEGRO);
    assert.equal(fila.ingreso.fecha, new Date(fecha).toISOString().slice(0, 19) + "Z");
    assert.equal(fila.ingreso.lotes, 1);
    // traspaso a las dos tiendas
    for (const destino of [ctx.CB, ctx.SC]) {
      const t = must(await post("/api/traspasos", tokens.admin, { idempotency_key: randomUUID(), origen_id: ctx.MBO, destino_id: destino, items: [item(3, ctx.M, ctx.NEGRO, 2)] }));
      must(await post(`/api/traspasos/${t.id}/despachar`, tokens.admin, {}));
      must(await post(`/api/traspasos/${t.id}/recibir`, tokens.admin, {}));
    }
    // en la tienda, la mercadería conserva la fecha de ingreso original (la del lote) y registra su llegada
    const tienda = must(await get(`/api/inventario?sucursal_id=${ctx.CB}`, tokens.admin)).find((r) => r.producto.id === 3);
    assert.ok(tienda.ingreso.fecha, "fecha de ingreso a la tienda");
    assert.equal(stock(ctx.MBO, 3, ctx.M, ctx.NEGRO), 3);
    assert.equal(descuadres().length, 0);
  });
  it("un vendedor asignado al almacén puede vender allí y solo allí", async () => {
    sql(`INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id) VALUES ('alm@lotes.test','Vend Almacén',(SELECT password_hash FROM usuarios WHERE email='cb@lotes.test'),'vendedor',${ctx.MBO})`);
    const token = await login("alm@lotes.test", pw.cb);
    assert.deepEqual(must(await get("/api/sucursales", token)).map((s) => s.id), [ctx.MBO]);
    must(await post("/api/ventas", token, { idempotency_key: randomUUID(), sucursal_id: ctx.MBO, metodo_pago: "QR", modalidad: "entrega_directa", items: [{ ...item(3, ctx.M, ctx.NEGRO, 1), precio_unitario: 80 }] }));
    assert.equal((await post("/api/ventas", token, { idempotency_key: randomUUID(), sucursal_id: ctx.CB, metodo_pago: "QR", modalidad: "entrega_directa", items: [{ ...item(3, ctx.M, ctx.NEGRO, 1), precio_unitario: 80 }] })).status, 403);
    assert.equal(descuadres().length, 0);
  });
});

describe("recepciones y lotes", () => {
  it("1) recibir 10 unidades crea un lote con su fecha y hora real y suma el stock", async () => {
    const fecha = hace(3);
    const r = must(await recibir(tokens.admin, [item(1, ctx.M, ctx.NEGRO, 10)], { fecha_recepcion: fecha }));
    assert.match(r.referencia_recepcion, /^REC-\d{6}$/);
    assert.equal(r.total_unidades, 10);
    assert.equal(r.lotes.length, 1);
    assert.equal(stock(ctx.MBO, 1, ctx.M, ctx.NEGRO), 10);
    const [lote] = lotsOf(ctx.MBO, 1, ctx.M, ctx.NEGRO);
    assert.equal(lote.cantidad_inicial, 10);
    assert.equal(lote.cantidad_restante, 10);
    assert.equal(lote.origen, "recepcion");
    assert.equal(lote.fecha_recepcion, fecha.slice(0, 19).replace("T", " "), "fecha real guardada en UTC");
    ctx.lotA1 = lote.id;
    const mov = sql(`SELECT categoria, signo, referencia_tipo, referencia_id, usuario_id FROM movimientos_inventario WHERE id = (SELECT movimiento_id FROM lote_movimientos WHERE lote_id = ${lote.id})`)[0];
    assert.deepEqual([mov.categoria, mov.signo, mov.referencia_tipo, mov.referencia_id], ["INGRESO", 1, "recepcion", r.id]);
    assert.ok(mov.usuario_id, "responsable registrado");
  });

  it("2) la misma talla y color recibida otro día es OTRO lote", async () => {
    must(await recibir(tokens.admin, [item(1, ctx.M, ctx.NEGRO, 5)], { fecha_recepcion: hace(1) }));
    const lots = lotsOf(ctx.MBO, 1, ctx.M, ctx.NEGRO);
    assert.equal(lots.length, 2);
    assert.ok(lots[0].fecha_recepcion < lots[1].fecha_recepcion);
    assert.notEqual(lots[0].raiz, lots[1].raiz, "códigos de lote distintos");
    assert.equal(stock(ctx.MBO, 1, ctx.M, ctx.NEGRO), 15);
    ctx.lotA2 = lots[1].id;
  });

  it("3) una recepción con varias prendas registra un lote por talla/color", async () => {
    const r = must(await recibir(tokens.admin, [item(1, ctx.G, ctx.NEGRO, 4), item(2, ctx.M, ctx.AZUL, 6), item(2, ctx.G, ctx.AZUL, 2)], { proveedor: "Confecciones Sur", referencia: "G-77" }));
    assert.equal(r.lotes.length, 3);
    assert.equal(r.total_unidades, 12);
    assert.equal(stock(ctx.MBO, 1, ctx.G, ctx.NEGRO), 4);
    assert.equal(stock(ctx.MBO, 2, ctx.M, ctx.AZUL), 6);
    assert.equal(stock(ctx.MBO, 2, ctx.G, ctx.AZUL), 2);
    const lot = must(await get(`/api/lotes?recepcion_id=${r.id}`, tokens.admin)).filas;
    assert.equal(lot.length, 3);
    assert.ok(lot.every((l) => l.proveedor === "Confecciones Sur" && l.referencia === "G-77" && l.recepcion.codigo === r.referencia_recepcion));
  });

  it("8a) repetir la misma recepción (misma clave) no suma dos veces", async () => {
    const key = randomUUID();
    const body = { items: [item(2, ctx.M, ctx.NEGRO, 3)], idempotency_key: key };
    const a = must(await recibir(tokens.admin, body.items, { idempotency_key: key }));
    const b = must(await recibir(tokens.admin, body.items, { idempotency_key: key }));
    assert.equal(a.id, b.id);
    assert.equal(b.repetida, true);
    assert.equal(stock(ctx.MBO, 2, ctx.M, ctx.NEGRO), 3);
    assert.equal(lotsOf(ctx.MBO, 2, ctx.M, ctx.NEGRO).length, 1);
  });

  it("validaciones: fecha futura, líneas repetidas, cantidad 0, talla no oficial y ubicación ajena", async () => {
    assert.equal((await recibir(tokens.admin, [item(1, ctx.M, ctx.NEGRO, 1)], { fecha_recepcion: new Date(Date.now() + 3_600_000).toISOString() })).status, 400);
    assert.equal((await recibir(tokens.admin, [item(1, ctx.M, ctx.NEGRO, 1), item(1, ctx.M, ctx.NEGRO, 2)])).status, 400);
    assert.equal((await recibir(tokens.admin, [item(1, ctx.M, ctx.NEGRO, 0)])).status, 400);
    assert.equal((await recibir(tokens.admin, [item(1, ctx.M, ctx.NEGRO, 1)], { fecha_recepcion: "26/10/2026" })).status, 400);
    const historica = id1("SELECT id FROM tallas WHERE oficial_pantalon = 0 LIMIT 1");
    if (historica) assert.equal((await recibir(tokens.admin, [item(1, historica, ctx.NEGRO, 1)])).status, 400);
    assert.equal((await recibir(tokens.admin, [item(1, ctx.M, ctx.NEGRO, 1)], { sucursal_id: 999 })).status, 403);
    assert.equal(stock(ctx.MBO, 1, ctx.M, ctx.NEGRO), 15, "nada se guardó");
  });
});

describe("traspasos desde el almacén con lotes", () => {
  const nuevo = (destino, n, over = {}) =>
    post("/api/traspasos", tokens.admin, { idempotency_key: randomUUID(), origen_id: ctx.MBO, destino_id: destino, items: [item(1, ctx.M, ctx.NEGRO, n)], ...over });

  it("4-5) el almacén crea traspasos a Cochabamba y Santa Cruz; el borrador no cambia el stock", async () => {
    const antes = stock(ctx.MBO, 1, ctx.M, ctx.NEGRO);
    ctx.trCB = must(await nuevo(ctx.CB, 12));
    ctx.trSC = must(await nuevo(ctx.SC, 2));
    assert.equal(stock(ctx.MBO, 1, ctx.M, ctx.NEGRO), antes, "un borrador no reserva ni descuenta");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM lote_movimientos WHERE traspaso_id IN (${ctx.trCB.id}, ${ctx.trSC.id})`)[0].n, 0);
  });

  it("6) despachar descuenta del origen UNA vez, de los lotes más antiguos (FIFO)", async () => {
    const total = companyTotal(1, ctx.M, ctx.NEGRO);
    must(await post(`/api/traspasos/${ctx.trCB.id}/despachar`, tokens.admin, {}));
    assert.equal((await post(`/api/traspasos/${ctx.trCB.id}/despachar`, tokens.admin, {})).status, 409, "no se despacha dos veces");
    assert.equal(stock(ctx.MBO, 1, ctx.M, ctx.NEGRO), 3);
    const [viejo, nuevoLote] = lotsOf(ctx.MBO, 1, ctx.M, ctx.NEGRO);
    assert.equal(viejo.cantidad_restante, 0, "el lote más antiguo sale primero (10)");
    assert.equal(nuevoLote.cantidad_restante, 3, "y luego 2 del siguiente");
    assert.equal(companyTotal(1, ctx.M, ctx.NEGRO), total, "en camino no crea ni pierde mercadería");
  });

  it("7) recibir suma al destino UNA vez sin crear mercadería; el lote conserva fecha y código", async () => {
    const total = companyTotal(1, ctx.M, ctx.NEGRO);
    must(await post(`/api/traspasos/${ctx.trCB.id}/recibir`, tokens.admin, {}));
    assert.equal((await post(`/api/traspasos/${ctx.trCB.id}/recibir`, tokens.admin, {})).status, 409, "no se recibe dos veces");
    assert.equal(stock(ctx.CB, 1, ctx.M, ctx.NEGRO), 12);
    assert.equal(companyTotal(1, ctx.M, ctx.NEGRO), total, "recibir es mover, no crear");
    const hijos = lotsOf(ctx.CB, 1, ctx.M, ctx.NEGRO);
    assert.equal(hijos.length, 2);
    const origen = lotsOf(ctx.MBO, 1, ctx.M, ctx.NEGRO);
    assert.deepEqual(hijos.map((h) => h.raiz), origen.map((o) => o.raiz), "mismo código de lote que en el almacén");
    assert.deepEqual(hijos.map((h) => h.fecha_recepcion), origen.map((o) => o.fecha_recepcion), "misma fecha de recepción");
    assert.deepEqual(hijos.map((h) => h.cantidad_inicial), [10, 2]);
    assert.ok(hijos.every((h) => h.origen === "traspaso" && h.fecha_llegada));
    const det = must(await get(`/api/traspasos/${ctx.trCB.id}`, tokens.admin));
    assert.ok(det.lotes.some((l) => l.tipo === "salida") && det.lotes.some((l) => l.tipo === "entrada"));
  });

  it("cancelar un traspaso despachado devuelve cada unidad a su lote de origen", async () => {
    must(await post(`/api/traspasos/${ctx.trSC.id}/despachar`, tokens.admin, {}));
    assert.equal(stock(ctx.MBO, 1, ctx.M, ctx.NEGRO), 1);
    must(await post(`/api/traspasos/${ctx.trSC.id}/cancelar`, tokens.admin, {}));
    assert.equal(stock(ctx.MBO, 1, ctx.M, ctx.NEGRO), 3);
    const lots = lotsOf(ctx.MBO, 1, ctx.M, ctx.NEGRO);
    assert.equal(lots.length, 2, "no se crean lotes nuevos: vuelve a los mismos");
    assert.equal(lots[1].cantidad_restante, 3);
    assert.equal(stock(ctx.SC, 1, ctx.M, ctx.NEGRO), 0);
  });

  it("9a) stock insuficiente: el despacho no deja nada negativo ni a medias", async () => {
    const t = must(await nuevo(ctx.SC, 50));
    assert.equal((await post(`/api/traspasos/${t.id}/despachar`, tokens.admin, {})).status, 409);
    assert.equal(sql(`SELECT estado FROM traspasos WHERE id = ${t.id}`)[0].estado, "pendiente");
    assert.equal(stock(ctx.MBO, 1, ctx.M, ctx.NEGRO), 3);
    assert.equal(sql(`SELECT COUNT(*) AS n FROM lote_movimientos WHERE traspaso_id = ${t.id}`)[0].n, 0);
  });
});

describe("ventas y devoluciones con lotes", () => {
  const venta = (token, n, over = {}) =>
    post("/api/ventas", token, {
      idempotency_key: randomUUID(), sucursal_id: ctx.CB, metodo_pago: "efectivo", modalidad: "entrega_directa",
      items: [{ ...item(1, ctx.M, ctx.NEGRO, n), precio_unitario: 150 }], ...over,
    });

  it("10) una venta descuenta UNA vez del lote más antiguo de la sucursal y queda enlazada a la línea", async () => {
    const key = randomUUID();
    const v = must(await venta(tokens.cb, 2, { idempotency_key: key }));
    const again = must(await venta(tokens.cb, 2, { idempotency_key: key }));
    assert.equal(again.id, v.id, "reintento = misma venta");
    assert.equal(stock(ctx.CB, 1, ctx.M, ctx.NEGRO), 10);
    const [viejo, reciente] = lotsOf(ctx.CB, 1, ctx.M, ctx.NEGRO);
    assert.equal(viejo.cantidad_restante, 8, "sale del lote recibido hace 3 días");
    assert.equal(reciente.cantidad_restante, 2);
    const link = sql(`SELECT lm.cantidad, lm.detalle_venta_id, dv.venta_id, lm.movimiento_id FROM lote_movimientos lm JOIN detalle_venta dv ON dv.id = lm.detalle_venta_id
                       WHERE lm.referencia_tipo = 'venta' AND lm.referencia_id = ${v.id}`);
    assert.equal(link.length, 1);
    assert.deepEqual([link[0].cantidad, link[0].venta_id], [2, v.id]);
    assert.ok(link[0].movimiento_id, "enlazado al asiento del libro");
    ctx.venta = v;
  });

  it("9b) una venta sin stock suficiente no descuenta nada", async () => {
    const r = await venta(tokens.cb, 99);
    assert.equal(r.status, 409);
    assert.equal(stock(ctx.CB, 1, ctx.M, ctx.NEGRO), 10);
  });

  it("una devolución vuelve al MISMO lote del que salió", async () => {
    const detalle = must(await get(`/api/ventas/${ctx.venta.id}/detalle-completo`, tokens.cb));
    const linea = detalle.lineas[0];
    const r = await post("/api/operaciones/devolucion", tokens.cb, {
      idempotency_key: randomUUID(), venta_id: ctx.venta.id, motivo: "Talla", motivo_codigo: "TALLA_INCORRECTA",
      items: [{ detalle_id: linea.detalle_id, cantidad: 1, condicion: "vendible" }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const [viejo] = lotsOf(ctx.CB, 1, ctx.M, ctx.NEGRO);
    assert.equal(viejo.cantidad_restante, 9);
    assert.equal(lotsOf(ctx.CB, 1, ctx.M, ctx.NEGRO).length, 2, "no se crea un lote nuevo");
  });

  it("11) reporte de lotes: fecha de recepción, días, vendidas, restantes y primera venta reales", async () => {
    const { filas } = must(await get(`/api/lotes?sucursal_id=${ctx.CB}&producto_id=1&talla_id=${ctx.M}&color_id=${ctx.NEGRO}`, tokens.admin));
    const viejo = filas.find((l) => l.cantidad_inicial === 10);
    assert.match(viejo.codigo, /^L-\d{6}$/);
    assert.ok(viejo.fecha_recepcion.endsWith("Z"));
    assert.equal(viejo.dias_en_inventario, 3, "recibido hace 3 días");
    assert.equal(viejo.vendidas, 1, "2 vendidas − 1 devuelta");
    assert.equal(viejo.cantidad_restante, 9);
    assert.equal(viejo.estado, "parcialmente_vendido");
    assert.ok(viejo.primera_venta);
    assert.equal(viejo.dias_hasta_primera_venta, 3);
    assert.equal(viejo.promedio_diario, 0.33);
    const reciente = filas.find((l) => l.cantidad_inicial === 2);
    assert.equal(reciente.vendidas, 0);
    assert.equal(reciente.primera_venta, null, "sin ventas no se inventa una duración");
    assert.equal(reciente.dias_hasta_primera_venta, null);
    assert.equal(reciente.promedio_diario, null);
    assert.equal(reciente.estado, "en_stock");
    // En el almacén, el lote viejo quedó en 0 porque se traspasó entero: "traspasado", no "vendido".
    const mbo = must(await get(`/api/lotes?sucursal_id=${ctx.MBO}&producto_id=1&talla_id=${ctx.M}&color_id=${ctx.NEGRO}`, tokens.admin)).filas;
    assert.equal(mbo.find((l) => l.codigo === viejo.codigo).estado, "traspasado");
    const det = must(await get(`/api/lotes/${viejo.id}`, tokens.admin));
    assert.ok(det.ubicaciones.length >= 2, "historia del lote en el almacén y en la tienda");
    assert.ok(det.historial.some((h) => h.venta && h.venta.id === ctx.venta.id));
  });

  it("12) filtros: fecha de recepción, ubicación, variante, estado y movimientos por lote", async () => {
    const hoy = new Date(Date.now() - 4 * 3_600_000).toISOString().slice(0, 10);
    const ayer = new Date(Date.now() - 4 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
    const recientes = must(await get(`/api/lotes?sucursal_id=${ctx.MBO}&desde=${ayer}&hasta=${hoy}`, tokens.admin)).filas;
    assert.ok(recientes.length > 0 && recientes.every((l) => l.fecha_recepcion && l.fecha_recepcion.slice(0, 10) >= ayer));
    const viejos = must(await get(`/api/lotes?sucursal_id=${ctx.MBO}&hasta=${new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)}`, tokens.admin)).filas;
    assert.ok(viejos.every((l) => !recientes.some((r) => r.id === l.id)));
    const azul = must(await get(`/api/lotes?color_id=${ctx.AZUL}`, tokens.admin)).filas;
    assert.ok(azul.length >= 2 && azul.every((l) => l.color.id === ctx.AZUL));
    const enStock = must(await get(`/api/lotes?estado=en_stock&sucursal_id=${ctx.CB}`, tokens.admin)).filas;
    assert.ok(enStock.every((l) => l.estado === "en_stock"));
    const lote = lotsOf(ctx.CB, 1, ctx.M, ctx.NEGRO)[0].raiz;
    const movs = must(await get(`/api/movimientos?lote=${lote}&limite=100`, tokens.admin)).filas;
    assert.ok(movs.length >= 4, "ingreso, traspaso salida/entrada, venta y devolución");
    assert.ok(movs.every((m) => m.lotes.some((l) => l.id === lote)));
    const ventas = must(await get(`/api/movimientos?lote=${lote}&categoria=VENTA`, tokens.admin)).filas;
    assert.ok(ventas.length >= 1 && ventas.every((m) => m.categoria === "VENTA"));
    const porCodigo = must(await get(`/api/lotes?q=L-${String(lote).padStart(6, "0")}`, tokens.admin)).filas;
    assert.ok(porCodigo.length >= 2 && porCodigo.every((l) => l.raiz_id === lote));
  });

  it("13) permisos: un vendedor no registra recepciones ni ve ni mueve otra sucursal (aunque llame a la API)", async () => {
    assert.equal((await recibir(tokens.cb, [item(1, ctx.M, ctx.NEGRO, 1)], { sucursal_id: ctx.CB })).status, 403);
    assert.equal((await get(`/api/lotes?sucursal_id=${ctx.MBO}`, tokens.cb)).status, 403);
    const propios = must(await get("/api/lotes", tokens.cb)).filas;
    assert.ok(propios.length > 0 && propios.every((l) => l.sucursal.id === ctx.CB));
    const ajeno = sql(`SELECT id FROM lotes WHERE sucursal_id = ${ctx.MBO} LIMIT 1`)[0].id;
    assert.equal((await get(`/api/lotes/${ajeno}`, tokens.cb)).status, 404);
    const t = must(await post("/api/traspasos", tokens.admin, { idempotency_key: randomUUID(), origen_id: ctx.MBO, destino_id: ctx.SC, items: [item(2, ctx.M, ctx.AZUL, 1)] }));
    assert.equal((await post(`/api/traspasos/${t.id}/despachar`, tokens.cb, {})).status, 403);
    assert.equal((await post(`/api/traspasos/${t.id}/despachar`, tokens.sc, {})).status, 403, "el destino no despacha");
    must(await post(`/api/traspasos/${t.id}/despachar`, tokens.admin, {}));
    assert.equal((await post(`/api/traspasos/${t.id}/recibir`, tokens.cb, {})).status, 403, "solo el destino recibe");
    must(await post(`/api/traspasos/${t.id}/recibir`, tokens.sc, {}));
    assert.equal(stock(ctx.SC, 2, ctx.M, ctx.AZUL), 1);
  });
});

describe("stock sin lote y regla lotes = stock", () => {
  it("15) stock cargado por fuera (script o importación) recibe un lote de fecha desconocida; nunca se inventa la fecha", async () => {
    sql(`INSERT INTO inventario (producto_id, talla_id, color_id, sucursal_id, cantidad) VALUES (5, ${ctx.M}, ${ctx.NEGRO}, ${ctx.SC}, 7)`);
    const [l] = lotsOf(ctx.SC, 5, ctx.M, ctx.NEGRO);
    assert.equal(l.origen, "conciliacion");
    assert.equal(l.cantidad_restante, 7);
    assert.equal(l.fecha_recepcion, null);
    const fila = must(await get(`/api/lotes?sucursal_id=${ctx.SC}&producto_id=5`, tokens.admin)).filas[0];
    assert.equal(fila.dias_en_inventario, null, "fecha desconocida: sin días inventados");
    // Bajar el stock por fuera, sin descontar lotes, se rechaza.
    assert.throws(() => sql(`UPDATE inventario SET cantidad = 2 WHERE sucursal_id = ${ctx.SC} AND producto_id = 5 AND talla_id = ${ctx.M} AND color_id = ${ctx.NEGRO}`), /lotes/);
    assert.equal(stock(ctx.SC, 5, ctx.M, ctx.NEGRO), 7);
    // La venta consume primero ese lote (fecha desconocida = más antiguo).
    must(await post("/api/ventas", tokens.sc, { idempotency_key: randomUUID(), sucursal_id: ctx.SC, metodo_pago: "QR", modalidad: "entrega_directa", items: [{ ...item(5, ctx.M, ctx.NEGRO, 2), precio_unitario: 99 }] }));
    assert.equal(lotsOf(ctx.SC, 5, ctx.M, ctx.NEGRO)[0].cantidad_restante, 5);
  });

  it("el historial de lotes no se puede editar ni borrar", () => {
    assert.throws(() => sql("UPDATE lotes SET cantidad_inicial = 999 WHERE id = 1"), /no se pueden modificar/);
    assert.throws(() => sql("DELETE FROM lotes WHERE id = 1"), /no se puede borrar/);
    assert.throws(() => sql("UPDATE lote_movimientos SET cantidad = 999 WHERE id = 1"), /no se puede modificar/);
    assert.throws(() => sql("DELETE FROM recepciones WHERE id = 1"), /no se puede borrar/);
  });

  it("al final de todo: en cada ubicación y variante la suma de lotes = stock, y cada salida está enlazada al libro", () => {
    assert.deepEqual(descuadres(), []);
    assert.equal(sql("SELECT COUNT(*) AS n FROM lote_movimientos WHERE movimiento_id IS NULL AND referencia_tipo NOT IN ('saldo_inicial', 'conciliacion')")[0].n, 0);
    assert.equal(sql("SELECT COUNT(*) AS n FROM lotes WHERE cantidad_restante < 0 OR cantidad_restante > cantidad_inicial")[0].n, 0);
  });
});

describe("escenario del negocio: lote de 20, vendidas 12, quedan 8", () => {
  const venderCB = (n) =>
    post("/api/ventas", tokens.cb, { idempotency_key: randomUUID(), sucursal_id: ctx.CB, metodo_pago: "efectivo", modalidad: "entrega_directa", items: [{ ...item(4, ctx.G, ctx.AZUL, n), precio_unitario: 100 }] });
  const lote = async () => must(await get(`/api/lotes?sucursal_id=${ctx.CB}&producto_id=4&talla_id=${ctx.G}&color_id=${ctx.AZUL}`, tokens.admin)).filas;

  it("8) sin ventas: 0 vendidas, tiempo transcurrido y NO figura como agotado", async () => {
    must(await post("/api/recepciones", tokens.admin, { idempotency_key: randomUUID(), sucursal_id: ctx.CB, fecha_recepcion: hace(7), items: [item(4, ctx.G, ctx.AZUL, 20)] }));
    const [l] = await lote();
    assert.deepEqual([l.cantidad_inicial, l.vendidas, l.cantidad_restante, l.estado], [20, 0, 20, "en_stock"]);
    assert.equal(l.dias_en_inventario, 7);
    assert.equal(l.primera_venta, null);
  });

  it("8) 12 vendidas y 8 restantes: parcialmente vendido, con 7 días y primera venta", async () => {
    must(await venderCB(12));
    const [l] = await lote();
    assert.deepEqual([l.cantidad_inicial, l.vendidas, l.cantidad_restante, l.estado], [20, 12, 8, "parcialmente_vendido"]);
    assert.equal(l.dias_en_inventario, 7);
    assert.ok(l.primera_venta);
    assert.equal(l.traspasadas, 0);
  });

  it("9) al venderse las 8 restantes: 0 restantes y agotado", async () => {
    must(await venderCB(8));
    const [l] = await lote();
    assert.deepEqual([l.cantidad_inicial, l.vendidas, l.cantidad_restante, l.estado], [20, 20, 0, "agotado"]);
  });

  it("5) cada ubicación tiene su propio historial: entradas y salidas numéricas por ubicación y por día", async () => {
    const hoy = new Date(Date.now() - 4 * 3_600_000).toISOString().slice(0, 10);
    const cb = must(await get(`/api/movimientos?sucursal_id=${ctx.CB}&desde=${hoy}&hasta=${hoy}&limite=1`, tokens.admin));
    const mbo = must(await get(`/api/movimientos?sucursal_id=${ctx.MBO}&desde=${hoy}&hasta=${hoy}&limite=1`, tokens.admin));
    const esperado = (suc) => sql(`SELECT COALESCE(SUM(CASE WHEN signo=1 THEN cantidad END),0) e, COALESCE(SUM(CASE WHEN signo=-1 THEN cantidad END),0) s FROM movimientos_inventario WHERE sucursal_id=${suc} AND date(created_at,'-4 hours')='${hoy}'`)[0];
    assert.deepEqual([cb.entradas, cb.salidas], [esperado(ctx.CB).e, esperado(ctx.CB).s]);
    assert.deepEqual([mbo.entradas, mbo.salidas], [esperado(ctx.MBO).e, esperado(ctx.MBO).s]);
    assert.ok(cb.entradas >= 20 && cb.salidas >= 20, "incluye la recepción y las ventas de este escenario");
    assert.notDeepEqual([cb.entradas, cb.salidas], [mbo.entradas, mbo.salidas], "cada ubicación lleva su propia cuenta");
    // filtro por producto
    const p4 = must(await get(`/api/movimientos?sucursal_id=${ctx.CB}&producto_id=4&limite=50`, tokens.admin));
    assert.ok(p4.filas.length >= 3 && p4.filas.every((m) => m.producto.id === 4));
    assert.equal(descuadres().length, 0);
  });
});

describe("traspasos: no se puede despachar lo que el origen no tiene", () => {
  it("despachar una talla y color sin fila de stock en el origen = 409 y nada cambia", async () => {
    // Santa Cruz (2) nunca tuvo el modelo 1, talla 1, color 1.
    assert.equal(stock(2, 1, 1, 1), 0);
    const t = must(await post("/api/traspasos", tokens.admin, { idempotency_key: randomUUID(), origen_id: 2, destino_id: 1, items: [{ producto_id: 1, talla_id: 1, color_id: 1, cantidad: 3 }] }));
    const destinoAntes = stock(1, 1, 1, 1);
    const despacho = await post(`/api/traspasos/${t.id}/despachar`, tokens.admin, {});
    assert.equal(despacho.status, 409, `despachar sin stock debe fallar: ${JSON.stringify(despacho.json)}`);
    assert.equal(sql(`SELECT estado FROM traspasos WHERE id = ${t.id}`)[0].estado, "pendiente");
    assert.equal(sql(`SELECT COUNT(*) AS n FROM movimientos_inventario WHERE referencia_tipo = 'traspaso' AND referencia_id = ${t.id}`)[0].n, 0);
    assert.equal(stock(1, 1, 1, 1), destinoAntes);
  });
});
