// Importa el respaldo de Supabase (backups/<marca>/supabase/*.json) a una base D1 LOCAL y la reconcilia.
//   node scripts/import-supabase.mjs <carpeta-respaldo>             -> valida el mapeo y genera local/import-supabase.sql
//   node scripts/import-supabase.mjs <carpeta-respaldo> --apply-local -> además lo aplica a la base LOCAL y reconcilia
// NUNCA aplica a la base remota. El SQL generado se puede revisar y, con aprobación, ejecutarse después.
// Es re-ejecutable: no duplica ventas (clave de idempotencia) ni suma stock dos veces (ON CONFLICT DO NOTHING).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sqlQuote } from "./hash.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const state = path.join(root, process.env.MISSI_LOCAL_STATE ?? ".wrangler/state");
const dir = process.argv[2];
if (!dir) throw new Error("Indica la carpeta del respaldo (backups/<marca>).");
const apply = process.argv.includes("--apply-local");

const read = (name) => JSON.parse(readFileSync(path.join(dir, "supabase", `${name}.json`), "utf8"));
const sb = {
  productos: read("productos"), tallas: read("tallas"), colores: read("colores"),
  inventario: read("inventario"), ventas: read("ventas"), detalle: read("detalle_venta"),
};

// Equivalencias APROBADAS (Supabase -> D1). Todo lo demás debe coincidir por nombre exacto.
const COLOR_MAP = { Capuchino: "Cappuccino", "Hoja seca": "Verde hoja seca", Pistacho: "Verde pistacho" };
const TALLA_MAP = { GGG: "3G", S: "P" }; // en D1 el rótulo oficial es 3G (migración 0008); Supabase usaba GGG y S (en D1: 3G y P)
// Supuesto documentado: en Supabase el stock existente se asignó a la sucursal 1 (Cochabamba) por la migración 001.
const SUCURSAL_NOMBRE = { 1: "MISSI Cochabamba" };

function d1(query) {
  const r = spawnSync(process.execPath, [wrangler, "d1", "execute", "DB", "--local", "--persist-to", state, "--json", "--command", query], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf("[")))[0].results;
}

// 1) Validar que cada nombre usado exista en D1 (nada se inventa ni se fusiona en silencio).
const names = {
  productos: new Set(d1("SELECT nombre FROM productos").map((r) => r.nombre)),
  tallas: new Set(d1("SELECT nombre FROM tallas").map((r) => r.nombre)),
  colores: new Set(d1("SELECT nombre FROM colores").map((r) => r.nombre)),
  sucursales: new Set(d1("SELECT nombre FROM sucursales").map((r) => r.nombre)),
};
const byId = (rows) => new Map(rows.map((r) => [r.id, r.nombre]));
const prodName = byId(sb.productos), tallaName = byId(sb.tallas), colorName = byId(sb.colores);
const problems = [];
const mapName = (kind, map, set, sbName, id) => {
  const target = map[sbName] ?? sbName;
  if (!set.has(target)) problems.push(`${kind} id=${id} "${sbName}" -> "${target}" NO existe en D1`);
  return target;
};

const inv = sb.inventario.map((r) => ({
  suc: SUCURSAL_NOMBRE[r.sucursal_id],
  prod: mapName("producto", {}, names.productos, prodName.get(r.producto_id), r.producto_id),
  talla: mapName("talla", TALLA_MAP, names.tallas, tallaName.get(r.talla_id), r.talla_id),
  color: mapName("color", COLOR_MAP, names.colores, colorName.get(r.color_id), r.color_id),
  qty: r.cantidad,
}));
for (const r of sb.inventario) if (!SUCURSAL_NOMBRE[r.sucursal_id]) problems.push(`inventario ${r.id}: sucursal_id ${r.sucursal_id} sin mapeo`);
for (const n of Object.values(SUCURSAL_NOMBRE)) if (!names.sucursales.has(n)) problems.push(`sucursal "${n}" no existe en D1`);

const det = sb.detalle.map((r) => ({
  id: r.id, venta: r.venta_id,
  prod: mapName("producto", {}, names.productos, prodName.get(r.producto_id), r.producto_id),
  talla: mapName("talla", TALLA_MAP, names.tallas, tallaName.get(r.talla_id), r.talla_id),
  color: mapName("color", COLOR_MAP, names.colores, colorName.get(r.color_id), r.color_id),
  qty: r.cantidad, price: Number(r.precio_unitario), sub: Number(r.subtotal),
}));

if (problems.length) {
  console.error("MAPEO INCOMPLETO, no se genera SQL:\n - " + problems.join("\n - "));
  process.exit(1);
}

// 2) Generar SQL idempotente. Los ids se resuelven por nombre (nunca se asume que coinciden).
const id = (table, name) => `(SELECT id FROM ${table} WHERE nombre = ${sqlQuote(name)})`;
const ts = (iso) => iso.replace("T", " ").replace(/\.\d+/, "").replace(/(\+00:00|Z)$/, "");
const out = ["-- Importación Supabase -> D1 (generado; idempotente). Respaldo origen: " + dir, "PRAGMA defer_foreign_keys = TRUE;"];

for (const r of inv) {
  const keys = `${id("productos", r.prod)}, ${id("tallas", r.talla)}, ${id("colores", r.color)}, ${id("sucursales", r.suc)}`;
  out.push(
    `INSERT INTO inventario (producto_id, talla_id, color_id, sucursal_id, cantidad) VALUES (${keys}, ${r.qty}) ON CONFLICT (producto_id, talla_id, color_id, sucursal_id) DO NOTHING;`,
    `INSERT INTO movimientos_inventario (sucursal_id, producto_id, talla_id, color_id, tipo, cantidad, referencia_tipo, observaciones)
       SELECT ${id("sucursales", r.suc)}, ${id("productos", r.prod)}, ${id("tallas", r.talla)}, ${id("colores", r.color)}, 'entrada', ${r.qty}, 'importacion_supabase', 'stock inicial importado'
        WHERE ${r.qty} > 0 AND NOT EXISTS (SELECT 1 FROM movimientos_inventario WHERE referencia_tipo = 'importacion_supabase'
          AND producto_id = ${id("productos", r.prod)} AND talla_id = ${id("tallas", r.talla)} AND color_id = ${id("colores", r.color)} AND sucursal_id = ${id("sucursales", r.suc)});`,
  );
}

// Ventas históricas: sin pago/modalidad (no se inventan). Se conserva id, fecha y total.
const sucCb = id("sucursales", "MISSI Cochabamba");
for (const v of sb.ventas) {
  out.push(
    `INSERT OR IGNORE INTO ventas (id, sucursal_id, fecha, total, metodo_pago, tipo_entrega, estado, idempotency_key)
       VALUES (${v.id}, ${sucCb}, ${sqlQuote(ts(v.fecha))}, ${Number(v.total)}, NULL, NULL, 'completada', ${sqlQuote("supabase-venta-" + v.id)});`,
  );
}
for (const d of det) {
  out.push(
    `INSERT OR IGNORE INTO detalle_venta (id, venta_id, producto_id, talla_id, color_id, cantidad, precio_unitario, subtotal)
       VALUES (${d.id}, ${d.venta}, ${id("productos", d.prod)}, ${id("tallas", d.talla)}, ${id("colores", d.color)}, ${d.qty}, ${d.price}, ${d.sub});`,
  );
}

const sqlFile = path.join(root, "local", "import-supabase.sql");
writeFileSync(sqlFile, out.join("\n") + "\n");
console.log(`SQL generado: ${sqlFile} (${out.length} sentencias)`);

if (!apply) process.exit(0);

// 3) Aplicar a la base LOCAL y reconciliar contra el respaldo.
const r = spawnSync(process.execPath, [wrangler, "d1", "execute", "DB", "--local", "--persist-to", state, "--file", sqlFile], { cwd: root, encoding: "utf8" });
if (r.status !== 0) throw new Error(r.stdout + r.stderr);
console.log("Importación aplicada a la base LOCAL.");

const expectUnits = inv.reduce((a, x) => a + x.qty, 0);
const expectSales = sb.ventas.reduce((a, v) => a + Number(v.total), 0);
const checks = [];
const check = (label, got, want) => { checks.push([label, got, want, got === want]); };

check("filas de inventario", d1("SELECT COUNT(*) n FROM inventario WHERE cantidad > 0")[0].n, inv.filter((x) => x.qty > 0).length);
check("unidades en inventario", d1("SELECT COALESCE(SUM(cantidad),0) n FROM inventario")[0].n, expectUnits);
check("unidades en Cochabamba", d1("SELECT COALESCE(SUM(i.cantidad),0) n FROM inventario i JOIN sucursales s ON s.id=i.sucursal_id WHERE s.nombre='MISSI Cochabamba'")[0].n, expectUnits);
check("unidades en Santa Cruz", d1("SELECT COALESCE(SUM(i.cantidad),0) n FROM inventario i JOIN sucursales s ON s.id=i.sucursal_id WHERE s.nombre='MISSI Santa Cruz'")[0].n, 0);
check("ventas importadas", d1("SELECT COUNT(*) n FROM ventas WHERE idempotency_key LIKE 'supabase-venta-%'")[0].n, sb.ventas.length);
check("total de ventas", Math.round(d1("SELECT COALESCE(SUM(total),0) n FROM ventas")[0].n * 100) / 100, Math.round(expectSales * 100) / 100);
check("líneas de detalle", d1("SELECT COUNT(*) n FROM detalle_venta")[0].n, sb.detalle.length);
check("subtotal de detalle", Math.round(d1("SELECT COALESCE(SUM(subtotal),0) n FROM detalle_venta")[0].n * 100) / 100, Math.round(det.reduce((a, x) => a + x.sub, 0) * 100) / 100);
check("inventario negativo", d1("SELECT COUNT(*) n FROM inventario WHERE cantidad < 0")[0].n, 0);

// Variante por variante
let variantsOk = true;
for (const x of inv) {
  const got = d1(`SELECT COALESCE(SUM(i.cantidad),0) n FROM inventario i WHERE i.producto_id=${id("productos", x.prod)} AND i.talla_id=${id("tallas", x.talla)} AND i.color_id=${id("colores", x.color)}`)[0].n;
  if (got !== x.qty) { variantsOk = false; console.error(`  variante distinta: ${x.prod}/${x.talla}/${x.color} esperado ${x.qty} obtenido ${got}`); }
}
checks.push(["variantes (producto/talla/color) idénticas", variantsOk, true, variantsOk]);

console.log("\nReconciliación:");
for (const [label, got, want, okk] of checks) console.log(`  ${okk ? "OK  " : "FALLA"} ${label}: ${got} (esperado ${want})`);
process.exit(checks.every((c) => c[3]) ? 0 : 1);
