// Cuentas en la base REAL (producción). Se ejecuta a mano en TU terminal; la contraseña se escribe oculta (sin eco),
// nunca por argumentos, variables de entorno ni chat, y solo se guarda como hash PBKDF2.
//   node scripts/prod-account.mjs list                                        (solo lectura, sin hashes)
//   node scripts/prod-account.mjs create-admin --email a@b.c --nombre "Nombre" [--username usuario] --confirm
//   node scripts/prod-account.mjs set-password --identifier correo|usuario --confirm   (cambia SOLO esa cuenta)
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, sqlQuote } from "./hash.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function remote(extra) {
  const r = spawnSync(process.execPath, [wrangler, "d1", "execute", "DB", "--remote", ...extra], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "wrangler falló").trim().split("\n").slice(-3).join(" "));
  return r.stdout;
}
const query = (sql) => { const o = remote(["--json", "--command", sql]); return JSON.parse(o.slice(o.indexOf("[")))[0].results; };
function run(sql) {
  const dir = mkdtempSync(path.join(tmpdir(), "missi-prod-"));
  const f = path.join(dir, "q.sql");
  writeFileSync(f, sql);
  try { remote(["--file", f]); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error("Ejecútalo en una terminal interactiva: la contraseña se escribe oculta."));
    process.stdout.write(prompt);
    const s = process.stdin; s.setRawMode(true); s.resume(); s.setEncoding("utf8");
    let v = "";
    const on = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { s.setRawMode(false); s.pause(); s.removeListener("data", on); process.stdout.write("\n"); return resolve(v); }
        if (ch === "\u0003") { s.setRawMode(false); return reject(new Error("Cancelado.")); }
        if (ch === "\u007f" || ch === "\b") v = v.slice(0, -1); else v += ch;
      }
    };
    s.on("data", on);
  });
}
async function newPassword() {
  const a = await readHidden("Contraseña nueva (mín. 12 caracteres, no se muestra): ");
  if (a.length < 12) throw new Error("La contraseña debe tener al menos 12 caracteres.");
  if (a !== (await readHidden("Repite la contraseña: "))) throw new Error("No coinciden.");
  return a;
}
const accounts = () => query("SELECT id, email, username, rol, sucursal_id, activo, ultimo_login FROM usuarios ORDER BY id");

try {
  if (cmd === "list") {
    console.log("Cuentas en PRODUCCIÓN:");
    for (const r of accounts()) console.log(`  id ${r.id} · ${r.email} · usuario: ${r.username ?? "—"} · ${r.rol} · ${r.activo ? "activa" : "INACTIVA"} · último acceso: ${r.ultimo_login ?? "nunca"}`);
  } else if (cmd === "create-admin" || cmd === "set-password") {
    if (!args.includes("--confirm")) throw new Error("Esto escribe en la base REAL. Repite el comando con --confirm.");
    const rows = accounts();
    if (cmd === "create-admin") {
      const email = (opt("email") ?? "").trim().toLowerCase(), nombre = (opt("nombre") ?? "").trim(), username = (opt("username") ?? "").trim().toLowerCase();
      if (!EMAIL.test(email) || !nombre) throw new Error('Indica --email válido y --nombre "Nombre".');
      if (username && !USERNAME.test(username)) throw new Error("--username inválido (3-30: letras, números, . _ -; sin @).");
      if (rows.some((r) => r.email.toLowerCase() === email || (username && (r.username ?? "").toLowerCase() === username))) throw new Error("Ya existe una cuenta con ese correo o usuario; usa set-password.");
      const hash = hashPassword(await newPassword());
      run(`INSERT INTO usuarios (email, username, nombre, password_hash, rol, sucursal_id) VALUES (${sqlQuote(email)}, ${username ? sqlQuote(username) : "NULL"}, ${sqlQuote(nombre)}, ${sqlQuote(hash)}, 'admin', NULL);`);
      console.log(`Administrador ${email} creado en PRODUCCIÓN.`);
    } else {
      const id = (opt("identifier") ?? "").trim().toLowerCase();
      const t = rows.find((r) => r.email.toLowerCase() === id || (r.username ?? "").toLowerCase() === id);
      if (!t) throw new Error(`No existe ninguna cuenta con "${id}". Usa "list".`);
      const hash = hashPassword(await newPassword());
      run(`UPDATE usuarios SET password_hash = ${sqlQuote(hash)} WHERE id = ${Number(t.id)}; DELETE FROM sesiones WHERE usuario_id = ${Number(t.id)}; DELETE FROM intentos_login WHERE email = ${sqlQuote(t.email)} COLLATE NOCASE;`);
      console.log(`Contraseña actualizada solo para ${t.email} (id ${t.id}).`);
    }
  } else {
    console.log("Uso: node scripts/prod-account.mjs <list | create-admin | set-password> [opciones] --confirm");
    process.exit(1);
  }
} catch (e) { console.error("Error:", e instanceof Error ? e.message : e); process.exit(1); }
