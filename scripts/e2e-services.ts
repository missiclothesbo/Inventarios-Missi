/**
 * Prueba de integración de la CAPA DE SERVICIOS de React contra la API LOCAL (Worker + D1 local).
 * Usa exactamente las funciones que usan las pantallas. Ver scripts/run-e2e-local.md.
 * Credenciales por entorno: E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD (no se imprimen).
 */
import { api } from "../src/lib/api";
import { setSession, type SessionUser } from "../src/lib/session";
import { getBranches } from "../src/services/branches.service";
import { getDashboardData } from "../src/services/dashboard.service";
import { getInventory } from "../src/services/inventory.service";
import { addStock, createProduct, getColors, getProducts, getSizes } from "../src/services/product.service";
import { getReportsData } from "../src/services/reports.service";
import {
  cancelSale, createSale, formatDestination, getSaleDetails, getSales,
} from "../src/services/sales.service";
import {
  cancelTransfer, createTransfer, dispatchTransfer, getTransferItems, getTransfers, receiveTransfer,
} from "../src/services/transfers.service";

let ok = 0;
let bad = 0;
function check(cond: boolean, msg: string) {
  if (cond) ok++;
  else bad++;
  console.log(cond ? "  ok  " : "  FAIL", msg);
}

const login = await api.post<{ token: string; user: SessionUser }>("/api/auth/login", {
  identifier: process.env.E2E_ADMIN_EMAIL,
  password: process.env.E2E_ADMIN_PASSWORD,
});
setSession(login.token, login.user);
check(login.user.rol === "admin", "login admin y token guardado en la sesión");

console.log("Catálogo y sucursales");
const branches = await getBranches();
check(branches.length === 2 && branches[0].es_central === true && typeof branches[0].codigo === "string", "sucursales con codigo y es_central (booleano)");
const [products, sizes, colors] = await Promise.all([getProducts(), getSizes(), getColors()]);
check(sizes.map((s) => s.nombre).includes("3G") && sizes.map((s) => s.nombre).includes("4G") && sizes.map((s) => s.nombre).includes("48"), "tallas 3G, 4G y numéricas hasta 48");
check(products.some((p) => p.nombre === "Hebilla bota recta" && p.estado === true), "modelo Hebilla bota recta");
check(colors.some((c) => c.nombre === "Beige"), "color Beige");

console.log("Inventario");
const cb = branches.find((b) => b.es_central)!;
const sc = branches.find((b) => !b.es_central)!;
const invCb = await getInventory(cb.id);
const invSc = await getInventory(sc.id);
const invAll = await getInventory(null);
const sum = (rows: { cantidad: number }[]) => rows.reduce((a, r) => a + r.cantidad, 0);
check(sum(invCb) === 27 && sum(invSc) === 0, `stock importado: Cochabamba ${sum(invCb)} / Santa Cruz ${sum(invSc)}`);
check(sum(invAll) === sum(invCb) + sum(invSc) && invAll.every((r) => r.sucursal_id === null), "consolidado = suma de sucursales");

console.log("Venta completa (envío interprovincial)");
const item = invCb.find((r) => r.cantidad >= 2)!;
const before = item.cantidad;
const key = crypto.randomUUID();
const saleInput = {
  sucursal_id: cb.id, metodo_pago: "QR" as const, modalidad: "envio_interprovincial" as const,
  departamento: "", ciudad: "", provincia: "Nor Chichas", municipio: "", direccion: "",
  agencia_transporte: "", referencias: "frente a la iglesia", cliente_nombre: "Ana", cliente_telefono: "70000000",
  items: [{ producto_id: item.producto.id, talla_id: item.talla.id, color_id: item.color.id, cantidad: 2, precio_unitario: 150 }],
  idempotency_key: key,
};
const saleId = await createSale(saleInput);
const again = await createSale(saleInput);
check(saleId === again, "reintento con la misma clave devuelve la misma venta");
const after = (await getInventory(cb.id)).find((r) => r.id === item.id)!.cantidad;
check(after === before - 2, `stock ${before} -> ${after} (una sola vez)`);
const sales = await getSales(cb.id, 10);
const sale = sales.find((s) => s.id === saleId)!;
check(sale.total === 300 && sale.metodo_pago === "QR" && sale.modalidad === "envio_interprovincial", "venta con total, pago y modalidad");
check(formatDestination(sale).includes("Nor Chichas"), "destino visible: " + formatDestination(sale));
check(typeof sale.fecha === "string" && !Number.isNaN(new Date(sale.fecha).getTime()), "fecha ISO válida");
const lines = await getSaleDetails(saleId);
check(lines.length === 1 && lines[0].precio_unitario === 150 && lines[0].subtotal === 300, "detalle guarda el precio unitario real");

console.log("Ventas históricas importadas");
const legacy = (await getSales(cb.id, 50)).filter((s) => s.id <= 2);
check(legacy.length === 2 && legacy.every((s) => s.metodo_pago === null && s.modalidad === null && s.estado === "completada"), "2 ventas de Supabase conservadas, sin inventar pago ni modalidad");
check(formatDestination(legacy[0]) === "Sin registrar", "destino histórico = Sin registrar");

console.log("Traspaso");
const stockCb = (id: number) => getInventory(cb.id).then((r) => r.find((x) => x.id === id)!.cantidad);
const tId = await createTransfer({
  origen_id: cb.id, destino_id: sc.id, responsable: "Juan", notas: "prueba",
  items: [{ producto_id: item.producto.id, talla_id: item.talla.id, color_id: item.color.id, cantidad: 1 }],
  idempotency_key: crypto.randomUUID(),
});
const s0 = await stockCb(item.id);
await dispatchTransfer(tId);
check((await stockCb(item.id)) === s0 - 1, "despachar descuenta del origen");
await receiveTransfer(tId);
const inSc = (await getInventory(sc.id)).find((r) => r.producto.id === item.producto.id && r.talla.id === item.talla.id && r.color.id === item.color.id);
check(inSc?.cantidad === 1, "recibir suma al destino");
const tr = (await getTransfers()).find((t) => t.id === tId)!;
check(tr.estado === "recibido" && tr.origen_id === cb.id && tr.destino_id === sc.id && tr.responsable === "Juan", "estado y campos del traspaso");
check((await getTransferItems()).some((i) => i.traspaso_id === tId && i.cantidad === 1), "detalle del traspaso");
let rejected = false;
try { await receiveTransfer(tId); } catch (e) { rejected = e instanceof Error && /enviado/.test(e.message); }
check(rejected, "doble recepción rechazada con mensaje en español");
const t2 = await createTransfer({ origen_id: cb.id, destino_id: sc.id, responsable: "Juan", notas: "", items: [{ producto_id: item.producto.id, talla_id: item.talla.id, color_id: item.color.id, cantidad: 1 }], idempotency_key: crypto.randomUUID() });
await cancelTransfer(t2);
check((await getTransfers()).find((t) => t.id === t2)?.estado === "cancelado", "cancelar traspaso pendiente");

console.log("Cancelar venta, ingreso de stock y producto");
const beforeCancel = await stockCb(item.id);
await cancelSale(saleId, "prueba de cancelación");
check((await stockCb(item.id)) === beforeCancel + 2, "cancelar repone el stock");
await addStock({ sucursal_id: sc.id, producto_id: item.producto.id, talla_id: item.talla.id, color_id: item.color.id, cantidad: 4 });
check((await getInventory(sc.id)).find((r) => r.producto.id === item.producto.id && r.talla.id === item.talla.id && r.color.id === item.color.id)?.cantidad === 5, "addStock suma 4 en Santa Cruz");
const newP = await createProduct("Modelo E2E " + Date.now(), 99);
check(newP.estado === true && newP.precio_venta === 99, "createProduct devuelve el modelo con precio");

console.log("Reportes y dashboard");
const rep = await getReportsData({ desde: "", hasta: "", sucursalId: null, metodoPago: "", departamento: "", modalidad: "" });
const expected = rep.sales.reduce((a, s) => a + s.total, 0);
check(Math.abs(rep.balance.resumen.ingresos - expected) < 0.005, `ingresos ${rep.balance.resumen.ingresos} = suma de ventas listadas`);
check(rep.balance.resumen.ventas === rep.sales.length && rep.sales.every((s) => s.estado === "completada"), "la venta cancelada no cuenta");
check(rep.balance.por_departamento.some((d) => d.clave === "Entrega directa / sin destino"), "desglose por departamento incluye ventas históricas");
check(rep.balance.traspasos.recibidos >= 1, "traspasos reportados aparte");
const pot = await getReportsData({ desde: "", hasta: "", sucursalId: null, metodoPago: "QR", departamento: "Potosí", modalidad: "envio_interprovincial" });
check(pot.balance.resumen.ventas === 0, "filtros combinados (la venta de Potosí fue cancelada)");
const dash = await getDashboardData(cb.id);
check(typeof dash.stats.totalStock === "number" && Array.isArray(dash.recentSales), "dashboard por sucursal");

console.log(`\n${ok} ok, ${bad} fallos`);
process.exit(bad ? 1 : 0);
