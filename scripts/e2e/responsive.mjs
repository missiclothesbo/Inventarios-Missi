// Recorrido de extremo a extremo en navegador real (EMULACIÓN de tamaños de pantalla; no sustituye una prueba en teléfonos reales).
// Solo se ejecuta contra una API LOCAL aislada: se niega a correr contra cualquier otro servidor.
//
// Requisitos (una sola vez, sin tocar package.json):  npm i --no-save playwright-core   (y Microsoft Edge o Chrome instalado)
// Uso (PowerShell), con una API de pruebas en otro puerto y estado aislado:
//   $env:E2E_API="http://127.0.0.1:8791"; $env:E2E_WEB="http://localhost:5174"
//   $env:E2E_USER="admin@ux.local"; $env:E2E_PASS="<contraseña>"; $env:E2E_SEED="1"
//   node scripts/e2e/responsive.mjs
// Opcionales: E2E_BROWSER (ruta del ejecutable), E2E_OUT (carpeta de capturas), E2E_AXE (ruta a axe.min.js para accesibilidad).
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const API = process.env.E2E_API ?? "http://127.0.0.1:8791";
const WEB = process.env.E2E_WEB ?? "http://localhost:5174";
const USER = process.env.E2E_USER ?? "";
const PASS = process.env.E2E_PASS ?? "";
const OUT = process.env.E2E_OUT ?? path.resolve("e2e-resultados");
const BROWSER = process.env.E2E_BROWSER ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const AXE = process.env.E2E_AXE ?? "";

// Protección: jamás contra un servidor que no sea local.
for (const [name, url] of [["E2E_API", API], ["E2E_WEB", WEB]]) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost"].includes(host)) {
    console.error(`${name} debe apuntar a localhost o 127.0.0.1 (recibido: ${host}). No se ejecuta nada.`);
    process.exit(2);
  }
}
if (!USER || !PASS) {
  console.error("Define E2E_USER y E2E_PASS (cuenta de administrador de la base de PRUEBAS).");
  process.exit(2);
}

const { chromium } = await import("playwright-core");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  [320, 568], [360, 800], [375, 812], [390, 844], [412, 915], [768, 1024], [1440, 900],
];

const results = [];
const check = (viewport, area, ok, detail) => {
  results.push({ viewport, area, ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${viewport} · ${area}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------- datos de prueba por la API (solo con E2E_SEED=1)
async function call(method, p, token, body, headers = {}) {
  const res = await fetch(API + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json)}`);
  return json.data;
}
const login = async () => (await call("POST", "/api/auth/login", null, { identifier: USER, password: PASS })).token;
const admin = await login();
const sizes = Object.fromEntries((await call("GET", "/api/tallas", admin)).map((t) => [t.nombre, t.id]));
const products = await call("GET", "/api/productos", admin);

if (process.env.E2E_SEED === "1") {
  const ing = (suc, p, t, c, n) => call("POST", "/api/inventario/agregar", admin, { sucursal_id: suc, producto_id: p, talla_id: sizes[t], color_id: c, cantidad: n }, { "Idempotency-Key": randomUUID() });
  for (const [p, t, c] of [[4, "P", 1], [4, "M", 1], [5, "40", 2], [6, "42", 1]]) { await ing(1, p, t, c, 20); await ing(2, p, t, c, 6); }
  // foto real (PNG 1×1) para comprobar que las imágenes cargan desde R2
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const up = await fetch(`${API}/api/productos/4/foto`, { method: "POST", headers: { Authorization: `Bearer ${admin}`, "Content-Type": "image/png" }, body: png });
  if (!up.ok) throw new Error(`subida de foto falló: ${up.status}`);
  const v = await call("POST", "/api/ventas", admin, { idempotency_key: randomUUID(), sucursal_id: 1, metodo_pago: "QR", modalidad: "envio", departamento: "La Paz", ciudad: "El Alto", direccion: "Av 1", cliente_nombre: "Cliente E2E", cliente_telefono: "71234567", items: [{ producto_id: 4, talla_id: sizes.P, color_id: 1, cantidad: 2, precio_unitario: 120 }, { producto_id: 5, talla_id: sizes["40"], color_id: 2, cantidad: 1, precio_unitario: 135 }] });
  const tr = await call("POST", "/api/traspasos", admin, { idempotency_key: randomUUID(), origen_id: 1, destino_id: 2, items: [{ producto_id: 4, talla_id: sizes.M, color_id: 1, cantidad: 3 }] });
  await call("POST", `/api/traspasos/${tr.id}/despachar`, admin);
  await call("POST", `/api/traspasos/${tr.id}/recibir`, admin);
  console.log(`datos de prueba creados (venta ${v.id}, traspaso ${tr.id})`);
}
const firstSale = (await call("GET", "/api/ventas/historial?limite=1", admin)).filas[0];
const productName = products.find((p) => p.id === 4)?.nombre ?? "";

// ---------------------------------------------------------------- navegador
const browser = await chromium.launch({ executablePath: BROWSER, headless: true });

async function overflow(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll("body *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && getComputedStyle(el).position !== "fixed" && r.right > vw + 1 && !el.closest(".overflow-x-auto, [data-allow-scroll]");
      })
      .slice(0, 3)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`);
    return { vw, sw: document.documentElement.scrollWidth, wide };
  });
}

async function targets(page) {
  return page.evaluate(() => {
    const out = { small: 0, tiny: 0, total: 0, examples: [] };
    for (const el of document.querySelectorAll("button, a[href], select, input:not([type=hidden]), textarea, [role=tab]")) {
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      if (el.classList.contains("sr-only") || el.closest(".sr-only")) continue; // radios reales ocultos: el área tocable es su etiqueta
      // un input dentro de una etiqueta (<label>) se toca por toda la etiqueta: se mide el área tocable real
      const r = (el.closest("label") ?? el).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.total++;
      const min = Math.min(r.width, r.height);
      if (min < 24) { out.tiny++; if (out.examples.length < 4) out.examples.push(`${el.tagName}[${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}] ${Math.round(r.width)}×${Math.round(r.height)}`); }
      else if (min < 40) out.small++;
    }
    return out;
  });
}

const pages = [
  { name: "Dashboard", path: "/", wait: "h1" },
  { name: "Inventario", path: "/inventario", wait: "h1:has-text('Inventario')" },
  { name: "Ventas", path: "/ventas", wait: "h1:has-text('Ventas')" },
  { name: "Cambios y devoluciones", path: "/cambios", wait: "h1" },
  { name: "Traspasos", path: "/traspasos", wait: "h1:has-text('Traspasos')" },
  { name: "Movimientos", path: "/movimientos", wait: "h1:has-text('Movimientos')" },
  { name: "Reportes", path: "/reportes", wait: "h1:has-text('Reportes')" },
  { name: "Usuarios", path: "/usuarios", wait: "h1" },
];

for (const [width, height] of VIEWPORTS) {
  const vp = `${width}x${height}`;
  const touch = width <= 768;
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: width <= 500, hasTouch: touch });
  const page = await ctx.newPage();
  const consoleErrors = [], apiFailures = [], reqFailed = [];
  console.log(`\n=== ${vp} ===`);

  // login: contraseña incorrecta (mensaje claro) y luego login SOLO con teclado
  await page.goto(WEB + "/");
  await page.fill("#login-identifier", USER);
  await page.fill("#login-password", `${PASS}-incorrecta`);
  await page.keyboard.press("Enter");
  await page.waitForSelector("[role=alert], .text-red-700, .text-red-600", { timeout: 8000 }).catch(() => {});
  const err = await page.locator("body").innerText();
  check(vp, "login con contraseña incorrecta", /incorrect|inválid|no se pudo|Correo, usuario/i.test(err), "muestra mensaje de error");

  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 140)); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 140)}`));
  page.on("response", (r) => { if (r.url().startsWith(API) && r.status() >= 400) apiFailures.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  page.on("requestfailed", (r) => reqFailed.push(`${r.method()} ${r.url().slice(0, 80)}`));
  page.on("dialog", (d) => d.accept());

  await page.fill("#login-identifier", USER);
  await page.fill("#login-password", PASS);
  await page.focus("#login-password");
  await page.keyboard.press("Enter"); // teclado: Enter envía el formulario
  await page.waitForFunction(() => sessionStorage.length > 0, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  check(vp, "login con teclado (Enter)", await page.evaluate(() => sessionStorage.length > 0), "sesión creada");
  apiFailures.length = 0; // el 401 de la contraseña incorrecta ya fue esperado

  for (const p of pages) {
    await page.goto(WEB + p.path);
    await page.waitForSelector(p.wait, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(700);
    const o = await overflow(page);
    check(vp, `${p.name}: sin scroll horizontal`, o.sw <= o.vw + 1 && o.wide.length === 0, `viewport ${o.vw}, scrollWidth ${o.sw}${o.wide.length ? " · " + o.wide.join("; ") : ""}`);
    if (touch) {
      const t = await targets(page);
      check(vp, `${p.name}: controles táctiles ≥ 24 px`, t.tiny === 0, `${t.total} controles; ${t.small} entre 24 y 40 px${t.examples.length ? " · " + t.examples.join("; ") : ""}`);
    }
    if (["Dashboard", "Inventario", "Ventas", "Reportes"].includes(p.name)) await page.screenshot({ path: path.join(OUT, `${p.name.replace(/\W+/g, "-")}-${width}.png`) });
  }

  // inventario: foto del producto cargada desde R2
  await page.goto(WEB + "/inventario");
  await page.waitForSelector("h1:has-text('Inventario')");
  await page.waitForTimeout(1200);
  const imgs = await page.evaluate(() => [...document.querySelectorAll("img")].filter((i) => i.offsetParent !== null).map((i) => ({ ok: i.complete && i.naturalWidth > 0, src: i.src.slice(-30) })));
  check(vp, "Inventario: fotos de producto", imgs.length > 0 && imgs.every((i) => i.ok), `${imgs.filter((i) => i.ok).length}/${imgs.length} imágenes cargadas`);

  // ventas: armar un carrito con teclado/clic, revisar y volver sin confirmar
  await page.goto(WEB + "/ventas");
  await page.waitForSelector("h1:has-text('Ventas')");
  await page.waitForTimeout(800);
  const card = page.locator('label:has(input[name="sale-product"])').first();
  if (await card.count()) {
    await card.click();
    await page.locator("#sale-sizes label:not(:has(input:disabled))").first().click();
    await page.locator("#sale-colors label").first().click();
    await page.getByRole("button", { name: "AGREGAR A LA VENTA" }).click();
    const lines = await page.locator("#sale-cart > li").count();
    check(vp, "Ventas: agregar producto al carrito", lines === 1, `${lines} línea(s)`);
    await page.getByRole("button", { name: "REALIZAR VENTA" }).click();
    await page.waitForSelector("text=Revisa la venta antes de guardarla");
    const o = await overflow(page);
    check(vp, "Ventas: revisión sin scroll horizontal", o.sw <= o.vw + 1 && o.wide.length === 0, `scrollWidth ${o.sw}`);
    await page.getByRole("button", { name: "VOLVER A EDITAR" }).click();
  } else check(vp, "Ventas: agregar producto al carrito", false, "no hay modelos con stock (use E2E_SEED=1)");

  // detalle de una venta (historial) y cambios/devoluciones
  await page.goto(WEB + "/ventas");
  await page.waitForSelector("text=Ventas recientes");
  await page.waitForTimeout(700);
  const toggle = page.getByRole("button", { name: "Ver detalle" }).first();
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(500);
    check(vp, "Ventas: detalle de una venta", /Destino|Cliente/.test(await page.locator("body").innerText()), "muestra destino/cliente");
  }
  if (firstSale) {
    await page.goto(WEB + "/cambios");
    await page.waitForSelector("input[type=search]");
    await page.fill("input[type=search]", `V-${String(firstSale.id).padStart(6, "0")}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    const body = await page.locator("body").innerText();
    check(vp, "Cambios: buscar una venta por su número", body.includes(String(firstSale.id)), "la encuentra");
  }

  // navegación por el menú (barra inferior en móvil, barra lateral en tablet/escritorio)
  const nav = page.locator("nav a:visible", { hasText: /^\s*Traspasos\s*$/ }).first();
  if (await nav.count()) { await nav.click(); await page.waitForTimeout(600); check(vp, "Menú: ir a Traspasos", page.url().endsWith("/traspasos"), page.url()); }
  else {
    const more = page.getByRole("button", { name: /Más/ }).first();
    if (await more.count()) { await more.click(); await page.waitForTimeout(300); const l = page.getByRole("link", { name: /Traspasos/ }).first(); if (await l.count()) { await l.click(); await page.waitForTimeout(600); check(vp, "Menú: ir a Traspasos (desde «Más»)", page.url().endsWith("/traspasos"), page.url()); } }
  }

  // accesibilidad automática (axe) solo si se indicó la ruta del archivo
  if (AXE && (width === 390 || width === 1440)) {
    for (const p of ["/", "/ventas", "/inventario", "/reportes"]) {
      await page.goto(WEB + p);
      await page.waitForTimeout(1200);
      await page.addScriptTag({ path: AXE });
      const res = await page.evaluate(async () => {
        const r = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
      });
      check(vp, `Accesibilidad (axe) ${p}`, !res.some((v) => v.impact === "critical"), res.length ? res.map((v) => `${v.id}:${v.impact}×${v.nodes}`).join(", ") : "sin violaciones");
    }
  }

  // foco visible con teclado en una pantalla con formularios
  await page.goto(WEB + "/ventas");
  await page.waitForTimeout(800);
  let visibleFocus = 0;
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    visibleFocus += await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return 0; const s = getComputedStyle(e); return (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none" ? 1 : 0; });
  }
  check(vp, "Teclado: el foco es visible al tabular", visibleFocus >= 4, `${visibleFocus}/6 pasos con indicador de foco`);

  // cerrar sesión
  let out = page.getByRole("button", { name: /Cerrar sesión/ }).first();
  if (!(await out.isVisible().catch(() => false))) { await page.getByRole("button", { name: /Más/ }).first().click().catch(() => {}); await page.waitForTimeout(300); out = page.getByRole("button", { name: /Cerrar sesión/ }).first(); }
  await out.click().catch(() => {});
  await page.waitForTimeout(1000);
  check(vp, "Cerrar sesión", await page.locator("#login-identifier").isVisible().catch(() => false), "vuelve al inicio de sesión");

  check(vp, "Consola: sin errores de JavaScript", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  check(vp, "Red: sin respuestas 4xx/5xx de la API en el recorrido", apiFailures.length === 0, apiFailures.slice(0, 4).join(" | "));
  check(vp, "Red: sin peticiones fallidas", reqFailed.length === 0, reqFailed.slice(0, 3).join(" | "));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
writeFileSync(path.join(OUT, "resultado.json"), JSON.stringify({ total: results.length, fallos: failed.length, results }, null, 2));
console.log(`\n${results.length - failed.length} ok, ${failed.length} fallos. Capturas y resultado.json en ${OUT}`);
process.exit(failed.length ? 1 : 0);
