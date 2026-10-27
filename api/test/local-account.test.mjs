// Recuperación de acceso LOCAL + flujo real de acceso (login -> API protegida -> dashboard -> logout) y CORS del navegador.
// Usa su propio estado (.wrangler/recovery-test-state) y puerto: NO toca la base de desarrollo ni producción.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { hashPassword, sqlQuote } from "../scripts/hash.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = ".wrangler/recovery-test-state";
const wranglerJs = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:5173";
const env = { ...process.env, MISSI_LOCAL_STATE: STATE };
let server;
let logFd;

const newPw = () => randomBytes(14).toString("base64url");
const pw = { first: newPw(), second: newPw(), other: newPw() };

function node(script, args, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, encoding: "utf8", env: { ...env, ...extraEnv }, stdin: "ignore" });
}

function sql(query) {
  const r = spawnSync(process.execPath, [wranglerJs, "d1", "execute", "DB", "--local", "--persist-to", STATE, "--json", "--command", query], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf("[")))[0].results;
}

async function call(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Connection: "close", ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* sin cuerpo */ }
  return { status: res.status, json, headers: res.headers };
}

before(async () => {
  rmSync(path.join(root, STATE), { recursive: true, force: true });
  let r = node("scripts/reset-local-db.mjs", []);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  // Cuenta "ajena" (vendedor) que NO debe cambiar al recuperar el acceso del admin.
  const dir = mkdtempSync(path.join(tmpdir(), "missi-rec-"));
  writeFileSync(path.join(dir, "s.sql"), `INSERT INTO usuarios (email,nombre,password_hash,rol,sucursal_id) VALUES ('otro@test.local','Otro',${sqlQuote(hashPassword(pw.other))},'vendedor',1);`);
  r = spawnSync(process.execPath, [wranglerJs, "d1", "execute", "DB", "--local", "--persist-to", STATE, "--file", path.join(dir, "s.sql")], { cwd: root, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);

  logFd = openSync(path.join(tmpdir(), "missi-recovery-dev.log"), "w");
  server = spawn(process.execPath, [wranglerJs, "dev", "--local", "--port", String(PORT), "--persist-to", STATE], { cwd: root, stdio: ["ignore", logFd, logFd] });
  for (const t0 = Date.now(); ; ) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* arrancando */ }
    if (Date.now() - t0 > 90_000) throw new Error("wrangler dev no arrancó");
    await new Promise((res) => setTimeout(res, 500));
  }
});

after(() => {
  if (server?.pid) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  if (logFd) closeSync(logFd);
  try { rmSync(path.join(root, STATE), { recursive: true, force: true }); } catch { /* se limpia luego */ }
});

describe("recuperación local de acceso", () => {
  it("crea un administrador con contraseña por entorno (sin TTY) y permite entrar por correo o usuario", async () => {
    const r = node("scripts/local-account.mjs", ["create-admin", "--email", "dueña@missi.test", "--nombre", "Dueña", "--username", "nadith"], { MISSI_NEW_PASSWORD: pw.first });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes(pw.first), "no imprime la contraseña");
    for (const identifier of ["dueña@missi.test", "nadith", "NADITH"]) {
      const l = await call("POST", "/api/auth/login", { body: { identifier, password: pw.first } });
      assert.equal(l.status, 200, identifier);
      assert.equal(l.json.data.user.rol, "admin");
    }
  });

  it("set-password cambia SOLO la cuenta elegida y revoca sus sesiones", async () => {
    const before = sql("SELECT id, password_hash FROM usuarios ORDER BY id");
    const old = (await call("POST", "/api/auth/login", { body: { identifier: "nadith", password: pw.first } })).json.data.token;
    assert.equal((await call("GET", "/api/auth/me", { token: old })).status, 200);

    const r = node("scripts/local-account.mjs", ["set-password", "--identifier", "nadith"], { MISSI_NEW_PASSWORD: pw.second });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes(pw.second));

    const after = sql("SELECT id, password_hash FROM usuarios ORDER BY id");
    assert.equal(after.length, before.length, "no se crean ni borran cuentas");
    const changed = after.filter((a, i) => a.password_hash !== before[i].password_hash).map((a) => a.id);
    assert.deepEqual(changed, [before.find((b) => sql(`SELECT username FROM usuarios WHERE id=${b.id}`)[0].username === "nadith").id], "solo cambió la cuenta elegida");

    assert.equal((await call("GET", "/api/auth/me", { token: old })).status, 401, "sesión anterior revocada");
    assert.equal((await call("POST", "/api/auth/login", { body: { identifier: "nadith", password: pw.first } })).status, 401, "la contraseña anterior ya no sirve");
    assert.equal((await call("POST", "/api/auth/login", { body: { identifier: "nadith", password: pw.second } })).status, 200);
    assert.equal((await call("POST", "/api/auth/login", { body: { identifier: "otro@test.local", password: pw.other } })).status, 200, "la otra cuenta sigue igual");
  });

  it("rechaza cuentas inexistentes, contraseñas cortas y --remote", () => {
    assert.notEqual(node("scripts/local-account.mjs", ["set-password", "--identifier", "fantasma"], { MISSI_NEW_PASSWORD: pw.second }).status, 0);
    assert.notEqual(node("scripts/local-account.mjs", ["set-password", "--identifier", "nadith"], { MISSI_NEW_PASSWORD: "corta" }).status, 0);
    const remote = node("scripts/local-account.mjs", ["set-password", "--identifier", "nadith", "--remote"], { MISSI_NEW_PASSWORD: pw.second });
    assert.equal(remote.status, 2);
    assert.match(remote.stderr, /LOCAL/);
    // sigue funcionando con la contraseña válida (no se alteró nada)
    assert.equal(sql("SELECT COUNT(*) AS n FROM usuarios")[0].n, 2);
  });
});

describe("flujo de acceso completo (como lo hace el navegador)", () => {
  it("preflight CORS de login y de peticiones con Authorization desde el origen del frontend", async () => {
    for (const [p, headers] of [["/api/auth/login", "content-type"], ["/api/dashboard", "authorization"]]) {
      const res = await fetch(BASE + p, { method: "OPTIONS", headers: { Connection: "close", Origin: ORIGIN, "Access-Control-Request-Method": p.includes("login") ? "POST" : "GET", "Access-Control-Request-Headers": headers } });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
      assert.match(res.headers.get("access-control-allow-headers") ?? "", /Authorization/i);
    }
    const login = await call("POST", "/api/auth/login", { headers: { Origin: ORIGIN }, body: { identifier: "nadith", password: pw.second } });
    assert.equal(login.headers.get("access-control-allow-origin"), ORIGIN, "la respuesta real también lleva CORS");
  });

  it("login -> /me -> sucursales -> dashboard -> logout (la sesión deja de valer)", async () => {
    const login = await call("POST", "/api/auth/login", { body: { identifier: "nadith", password: pw.second } });
    assert.equal(login.status, 200);
    const token = login.json.data.token;
    assert.equal((await call("GET", "/api/dashboard")).status, 401, "sin token no hay acceso");
    assert.equal((await call("GET", "/api/auth/me", { token })).json.data.username, "nadith");
    const branches = (await call("GET", "/api/sucursales", { token })).json.data;
    assert.equal(branches.length, 3, "almacén central + 2 tiendas");
    const dash = await call("GET", `/api/dashboard?sucursal_id=${branches[0].id}`, { token });
    assert.equal(dash.status, 200);
    assert.ok("stats" in dash.json.data && "recentSales" in dash.json.data && "lowStockItems" in dash.json.data);
    assert.equal((await call("POST", "/api/auth/logout", { token })).status, 200);
    assert.equal((await call("GET", "/api/dashboard", { token })).status, 401, "logout invalida el token");
  });
});
