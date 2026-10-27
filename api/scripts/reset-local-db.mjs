// Recrea la base D1 LOCAL (Miniflare, carpeta .wrangler/state) desde cero:
//   1) esquema+catalogos identicos a produccion (local/baseline-from-remote.sql, export remoto del 2026-10-18)
//   2) migraciones 0001..0003
// Solo usa --local. Nunca toca la base remota.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Protección: este script BORRA el estado indicado. No usa por defecto la base de desarrollo.
if (!process.env.MISSI_LOCAL_STATE) {
  console.error("Define MISSI_LOCAL_STATE con la carpeta de estado a recrear (p. ej. .wrangler/test-state). No se borró nada.");
  process.exit(2);
}
const state = path.join(root, process.env.MISSI_LOCAL_STATE);
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");

function run(args) {
  const r = spawnSync(process.execPath, [wrangler, ...args, "--local", "--persist-to", state], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error("wrangler fallo: " + args.slice(0, 3).join(" "));
  }
  return r.stdout;
}

rmSync(state, { recursive: true, force: true });
run(["d1", "execute", "DB", "--file", "local/baseline-from-remote.sql"]);
console.log("baseline cargado");
console.log(run(["d1", "migrations", "apply", "DB"]).split("\n").filter((l) => /0\d{3}|✅|applied|Migrations/i.test(l)).join("\n"));
console.log("base local lista en", state);
