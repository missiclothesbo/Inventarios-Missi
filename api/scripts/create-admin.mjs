// Genera el SQL para crear el PRIMER administrador, con la contraseña ya hasheada.
// La contraseña se lee de la variable de entorno MISSI_ADMIN_PASSWORD (nunca de argumentos ni del repo)
// y NO se imprime. Uso (PowerShell):
//   $env:MISSI_ADMIN_PASSWORD = Read-Host "Contraseña (min. 12)"   # se escribe en tu terminal
//   node scripts/create-admin.mjs --email tu@correo.com --nombre "Tu Nombre"            # imprime SQL
//   node scripts/create-admin.mjs --email tu@correo.com --nombre "Tu Nombre" --local    # aplica a la base LOCAL
//   (opcional) --username tu.usuario   # permite iniciar sesión con correo o usuario
// Aplicarlo a la base remota es un paso aparte que requiere aprobación explícita.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, sqlQuote } from "./hash.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const email = (opt("email") ?? "").trim().toLowerCase();
const nombre = (opt("nombre") ?? "").trim();
const username = (opt("username") ?? "").trim().toLowerCase();
const password = process.env.MISSI_ADMIN_PASSWORD ?? "";

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !nombre) {
  console.error("Falta --email válido y --nombre.");
  process.exit(1);
}
if (password.length < 12) {
  console.error("Define MISSI_ADMIN_PASSWORD con al menos 12 caracteres.");
  process.exit(1);
}

const sql =
  "INSERT INTO usuarios (email, nombre, password_hash, rol, sucursal_id) VALUES (" +
  `${sqlQuote(email)}, ${sqlQuote(nombre)}, ${sqlQuote(hashPassword(password))}, 'admin', NULL);\n`;

if (args.includes("--local")) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(path.join(tmpdir(), "missi-admin-"));
  const file = path.join(dir, "admin.sql");
  writeFileSync(file, sql);
  const r = spawnSync(
    process.execPath,
    [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "DB", "--local", "--persist-to", path.resolve(root, process.env.MISSI_LOCAL_STATE ?? ".wrangler/state"), "--file", file],
    { cwd: root, encoding: "utf8" },
  );
  rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(1);
  }
  console.log(`Administrador ${email} creado en la base LOCAL.`);
} else {
  console.log("-- SQL (contiene solo el hash, no la contraseña):");
  console.log(sql);
}
