// Pruebas de la validación de cuentas (pantalla Usuarios, solo administrador).
// Ejecutar: npm run test:unit
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as u from "../src/lib/usuarios.ts";

const ok = { ...u.EMPTY_USER, nombre: "Ana", email: " Ana@Correo.com ", username: "", rol: "vendedor", sucursalId: "1", password: "una-clave-larga", password2: "una-clave-larga" };

describe("alta de cuenta", () => {
  it("formulario válido: sin errores y payload normalizado", () => {
    assert.deepEqual(u.validateNewUser(ok), {});
    assert.deepEqual(u.newUserPayload(ok), { nombre: "Ana", email: "ana@correo.com", rol: "vendedor", sucursal_id: 1, password: "una-clave-larga" });
  });

  it("usuario opcional se normaliza; con @ o muy corto se rechaza", () => {
    assert.equal(u.newUserPayload({ ...ok, username: " Ana.CB " }).username, "ana.cb");
    assert.ok(u.validateNewUser({ ...ok, username: "a@b" }).username);
    assert.ok(u.validateNewUser({ ...ok, username: "ab" }).username);
  });

  it("vendedor sin sucursal, correo inválido, nombre vacío", () => {
    const e = u.validateNewUser({ ...ok, sucursalId: "", email: "sin-arroba", nombre: "  " });
    assert.ok(e.sucursalId && e.email && e.nombre);
  });

  it("administrador: sin sucursal en el payload", () => {
    const admin = { ...ok, rol: "admin", sucursalId: "2" };
    assert.deepEqual(u.validateNewUser(admin), {});
    assert.equal(u.newUserPayload(admin).sucursal_id, null);
  });

  it("contraseña: mínimo 12 y confirmación igual", () => {
    assert.match(u.passwordError("corta", "corta"), /12/);
    assert.match(u.passwordError("una-clave-larga", "otra-clave-larga"), /no coinciden/);
    assert.equal(u.passwordError("una-clave-larga", "una-clave-larga"), null);
  });
});

describe("edición de cuenta", () => {
  const original = { nombre: "Tu Nombre", username: "nadith", rol: "admin", sucursal_id: null };

  it("solo envía lo que cambió; nombre no toca permisos", () => {
    const r = u.editPatch(original, { nombre: "Nadith Navarro", username: "nadith", rol: "admin", sucursalId: "" });
    assert.deepEqual(r, { patch: { nombre: "Nadith Navarro" }, permisos: false });
    assert.deepEqual(u.editPatch(original, { nombre: "Tu Nombre", username: "NADITH", rol: "admin", sucursalId: "" }).patch, {});
  });

  it("cambio de rol o sucursal envía ambos y avisa que cambian permisos", () => {
    const vend = { nombre: "V", username: null, rol: "vendedor", sucursal_id: 1 };
    assert.deepEqual(u.editPatch(vend, { nombre: "V", username: "", rol: "vendedor", sucursalId: "2" }), { patch: { rol: "vendedor", sucursal_id: 2 }, permisos: true });
    assert.deepEqual(u.editPatch(vend, { nombre: "V", username: "", rol: "admin", sucursalId: "1" }), { patch: { rol: "admin", sucursal_id: null }, permisos: true });
  });

  it("quitar el usuario lo envía como null", () => {
    assert.deepEqual(u.editPatch(original, { nombre: "Tu Nombre", username: " ", rol: "admin", sucursalId: "" }).patch, { username: null });
  });

  it("validación de edición", () => {
    assert.ok(u.validateEdit({ nombre: "", username: "", rol: "vendedor", sucursalId: "" }).sucursalId);
    assert.deepEqual(u.validateEdit({ nombre: "Ana", username: "ana", rol: "admin", sucursalId: "" }), {});
  });
});

describe("fechas y protección de la pantalla", () => {
  it("CURRENT_TIMESTAMP de SQLite se interpreta como UTC", () => {
    assert.equal(u.sqliteUtcToIso("2026-10-19 03:15:00"), "2026-10-19T03:15:00Z");
    assert.equal(u.sqliteUtcToIso("2026-10-19T03:15:00Z"), "2026-10-19T03:15:00Z");
  });

  it("la ruta /usuarios está protegida y el menú la muestra solo al administrador", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    assert.match(app, /path="\/usuarios" element=\{<AdminOnly><Usuarios \/><\/AdminOnly>\}/);
    // Una sola lista de secciones para la barra lateral y la navegación móvil.
    const nav = readFileSync(new URL("../src/components/layout/navigation.ts", import.meta.url), "utf8");
    assert.match(nav, /path: "\/usuarios", icon: Users, adminOnly: true/);
    assert.match(nav, /!item\.adminOnly \|\| isAdmin/);
    for (const f of ["Sidebar.tsx", "MobileNav.tsx"]) {
      const src = readFileSync(new URL(`../src/components/layout/${f}`, import.meta.url), "utf8");
      assert.match(src, /visibleNav\(isAdmin\)/, f);
    }
    const page = readFileSync(new URL("../src/pages/Usuarios/Usuarios.tsx", import.meta.url), "utf8");
    assert.ok(!/console\.log/.test(page), "nunca registra contraseñas");
  });
});
