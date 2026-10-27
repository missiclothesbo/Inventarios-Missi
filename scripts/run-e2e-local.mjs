// Orquesta la prueba de integración LOCAL de la capa de servicios de React contra la API local:
//   1) recrea la base D1 LOCAL (esquema real + migraciones) y le importa el último respaldo de Supabase
//   2) crea un administrador temporal con contraseña aleatoria (no se imprime)
//   3) levanta `wrangler dev --local` en :8787, compila scripts/e2e-services.ts con Vite y lo ejecuta
// No toca Cloudflare ni Supabase en la nube. Uso: node scripts/run-e2e-local.mjs backups/<marca>
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const api = path.join(root, "api");
const backup = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Indica la carpeta del respaldo: backups/<marca>");

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

// Estado y puerto PROPIOS: nunca se toca la base local de desarrollo (.wrangler/state) ni el puerto 8787.
const E2E_STATE = ".wrangler/e2e-state";
const E2E_PORT = 8788;
const e2eEnv = { ...process.env, MISSI_LOCAL_STATE: E2E_STATE };

const password = randomBytes(15).toString("base64url");
const email = "e2e-admin@local.test";

console.log("1) base local + importación");
run(process.execPath, ["scripts/reset-local-db.mjs"], { cwd: api, env: e2eEnv });
const imp = run(process.execPath, ["scripts/import-supabase.mjs", backup, "--apply-local"], { cwd: api, env: e2eEnv });
console.log(imp.split("\n").filter((l) => /OK|FALLA/.test(l)).join("\n"));

console.log("2) administrador temporal");
run(process.execPath, ["scripts/create-admin.mjs", "--email", email, "--nombre", "E2E Admin", "--local"], {
  cwd: api, env: { ...e2eEnv, MISSI_ADMIN_PASSWORD: password },
});

console.log("3) API local + servicios de React");
const outDir = mkdtempSync(path.join(tmpdir(), "missi-e2e-"));
run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--ssr", "scripts/e2e-services.ts", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"], {
  cwd: root, env: { ...process.env, VITE_API_BASE_URL: `http://127.0.0.1:${E2E_PORT}` },
});

const logFd = openSync(path.join(tmpdir(), "missi-e2e-api.log"), "w");
const server = spawn(process.execPath, [path.join(api, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--port", String(E2E_PORT), "--persist-to", E2E_STATE], {
  cwd: api, stdio: ["ignore", logFd, logFd],
});

let code = 1;
try {
  for (const t0 = Date.now(); ; ) {
    try { if ((await fetch(`http://127.0.0.1:${E2E_PORT}/api/health`)).ok) break; } catch { /* arrancando */ }
    if (Date.now() - t0 > 90_000) throw new Error("la API local no arrancó");
    await new Promise((r) => setTimeout(r, 500));
  }
  const file = readdirSync(outDir).find((f) => f.endsWith(".js") || f.endsWith(".mjs"));
  const r = spawnSync(process.execPath, [path.join(outDir, file)], {
    cwd: root, stdio: "inherit",
    env: { ...process.env, E2E_ADMIN_EMAIL: email, E2E_ADMIN_PASSWORD: password },
  });
  code = r.status ?? 1;
} finally {
  spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  try { rmSync(path.join(api, E2E_STATE), { recursive: true, force: true }); } catch { /* se limpia en la próxima ejecución */ }
  closeSync(logFd);
  rmSync(outDir, { recursive: true, force: true });
}
process.exit(code);
