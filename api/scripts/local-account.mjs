// Recuperación / creación de cuentas SOLO EN LA BASE D1 LOCAL (Miniflare). Nunca usa --remote.
// La contraseña se escribe de forma privada en la terminal (sin eco) y se guarda solo como hash PBKDF2
// (mismo formato que src/crypto.ts). Modifica ÚNICAMENTE la cuenta que elijas explícitamente.
//
//   Cambiar contraseña:   node scripts/local-account.mjs set-password [--identifier correo|usuario] [--set-username nuevo.usuario]
//   Crear administrador:  node scripts/local-account.mjs create-admin --email a@b.c --nombre "Nombre" [--username usuario]
//   Ver cuentas locales:  node scripts/local-account.mjs list
//
// Sin TTY (automatización/pruebas) la contraseña se toma de MISSI_NEW_PASSWORD. Estado local: MISSI_LOCAL_STATE
// (por defecto .wrangler/state, el mismo que usa `npm run dev`).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { hashPassword, sqlQuote } from "./hash.mjs";

if (process.argv.includes("--remote")) {
  console.error("Este script es solo para la base LOCAL; --remote no está permitido.");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const state = path.resolve(root, process.env.MISSI_LOCAL_STATE ?? ".wrangler/state");

const args = process.argv.slice(2);
const command = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function wranglerLocal(extra) {
  const r = spawnSync(process.execPath, [wrangler, "d1", "execute", "DB", "--local", "--persist-to", state, ...extra], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "wrangler falló").trim());
  return r.stdout;
}

function query(sql) {
  const out = wranglerLocal(["--json", "--command", sql]);
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

function run(sql) {
  const dir = mkdtempSync(path.join(tmpdir(), "missi-acct-"));
  const file = path.join(dir, "q.sql");
  writeFileSync(file, sql);
  try {
    wranglerLocal(["--file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Lee una línea sin mostrarla (TTY). */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          return reject(new Error("Cancelado."));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function askLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function getNewPassword() {
  if (!process.stdin.isTTY) {
    const p = process.env.MISSI_NEW_PASSWORD ?? "";
    if (p.length < 12) throw new Error("Sin terminal interactiva: define MISSI_NEW_PASSWORD (mín. 12 caracteres).");
    return p;
  }
  const a = await readHidden("Nueva contraseña (mín. 12 caracteres, no se muestra): ");
  if (a.length < 12) throw new Error("La contraseña debe tener al menos 12 caracteres.");
  const b = await readHidden("Repite la contraseña: ");
  if (a !== b) throw new Error("Las contraseñas no coinciden.");
  return a;
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function listAccounts() {
  return query("SELECT id, email, username, nombre, rol, sucursal_id, activo FROM usuarios ORDER BY id");
}

function printAccounts(rows) {
  if (rows.length === 0) console.log("(no hay cuentas en la base local)");
  for (const r of rows) {
    console.log(`  id ${r.id} · ${r.email} · usuario: ${r.username ?? "—"} · ${r.rol} · ${r.activo ? "activa" : "INACTIVA"} · ${r.nombre}`);
  }
}

async function setPassword() {
  let identifier = (opt("identifier") ?? "").trim().toLowerCase();
  const rows = listAccounts();

  if (!identifier) {
    if (!process.stdin.isTTY) throw new Error("Indica --identifier (correo o usuario) de la cuenta a modificar.");
    console.log("Cuentas en la base local:");
    printAccounts(rows);
    identifier = (await askLine("Correo o usuario de la cuenta a modificar: ")).toLowerCase();
  }

  const target = rows.find((r) => r.email.toLowerCase() === identifier || (r.username ?? "").toLowerCase() === identifier);
  if (!target) throw new Error(`No existe ninguna cuenta local con "${identifier}". Usa "list" para verlas o "create-admin" para crear una.`);

  const newUsername = opt("set-username")?.trim().toLowerCase();
  if (newUsername && !USERNAME.test(newUsername)) throw new Error("--set-username inválido (3-30 caracteres: letras, números, . _ -; sin @).");

  if (process.stdin.isTTY) {
    const ok = (await askLine(`Se cambiará SOLO la contraseña de: ${target.email} (id ${target.id}, ${target.rol}). ¿Continuar? (s/N) `)).toLowerCase();
    if (ok !== "s" && ok !== "si" && ok !== "sí") throw new Error("Cancelado; no se modificó nada.");
  }

  const password = await getNewPassword();
  const hash = hashPassword(password);

  // Solo la cuenta elegida (por id). Se revocan sus sesiones y se limpian sus intentos fallidos.
  run(
    [
      `UPDATE usuarios SET password_hash = ${sqlQuote(hash)}${newUsername ? `, username = ${sqlQuote(newUsername)}` : ""} WHERE id = ${Number(target.id)};`,
      `DELETE FROM sesiones WHERE usuario_id = ${Number(target.id)};`,
      `DELETE FROM intentos_login WHERE email = ${sqlQuote(target.email)} COLLATE NOCASE;`,
    ].join("\n"),
  );
  console.log(`Contraseña actualizada para ${target.email} (id ${target.id}).${newUsername ? ` Usuario: ${newUsername}.` : ""}`);
  if (!target.activo) console.log("Aviso: la cuenta está INACTIVA y no podrá iniciar sesión hasta reactivarla.");
}

async function createAdmin() {
  const email = (opt("email") ?? "").trim().toLowerCase();
  const nombre = (opt("nombre") ?? "").trim();
  const username = (opt("username") ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || !nombre) throw new Error('Indica --email válido y --nombre "Nombre".');
  if (username && !USERNAME.test(username)) throw new Error("--username inválido (3-30 caracteres: letras, números, . _ -; sin @).");
  if (listAccounts().some((r) => r.email.toLowerCase() === email || (username && (r.username ?? "").toLowerCase() === username))) {
    throw new Error("Ya existe una cuenta con ese correo o usuario; usa set-password.");
  }
  const password = await getNewPassword();
  run(
    "INSERT INTO usuarios (email, username, nombre, password_hash, rol, sucursal_id) VALUES (" +
      `${sqlQuote(email)}, ${username ? sqlQuote(username) : "NULL"}, ${sqlQuote(nombre)}, ${sqlQuote(hashPassword(password))}, 'admin', NULL);`,
  );
  console.log(`Administrador ${email}${username ? ` (usuario ${username})` : ""} creado en la base LOCAL.`);
}

try {
  if (command === "list") {
    console.log(`Base local: ${state}`);
    printAccounts(listAccounts());
  } else if (command === "set-password") {
    await setPassword();
  } else if (command === "create-admin") {
    await createAdmin();
  } else {
    console.log("Uso: node scripts/local-account.mjs <list | set-password | create-admin> [opciones]");
    process.exit(1);
  }
} catch (err) {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
}
