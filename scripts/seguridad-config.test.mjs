// Auditoría estática de seguridad y de aislamiento de las pruebas (sin red, sin base de datos).
// Garantiza que las pruebas y los scripts trabajan SOLO en local y que no hay secretos en el repositorio.
// Ejecutar: npm run test:unit
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", ".wrangler", "backups", ".git", ".tmp_t"]);

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}
const rel = (f) => path.relative(root, f).replaceAll("\\", "/");
const read = (f) => readFileSync(f, "utf8");

describe("las pruebas y scripts nunca apuntan a producción", () => {
  const files = [
    ...walk(path.join(root, "api", "test"), [".mjs"]),
    ...walk(path.join(root, "api", "scripts"), [".mjs"]),
    ...walk(path.join(root, "scripts"), [".mjs", ".ts", ".ps1"]),
  ];

  it("ningún script ni prueba usa --remote ni despliega (el único caso es una prueba que verifica que --remote se RECHAZA)", () => {
    for (const f of files) {
      if (rel(f) === "scripts/seguridad-config.test.mjs") continue;
      if (rel(f) === "scripts/audit-d1-readonly.ps1") {
        // Única herramienta que consulta la base REMOTA: solo si el usuario la ejecuta a mano, y solo lectura (lista blanca SELECT/PRAGMA).
        const text = read(f);
        assert.match(text, /Consulta bloqueada \(no es SELECT\)/, "conserva el bloqueo de consultas que no son SELECT");
        assert.match(text, /\^\(\?i\)\(select\|with\)/, "conserva la lista blanca de SELECT");
        assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|INDEX|TRIGGER|VIEW)|ALTER\s+TABLE|TRUNCATE)\b/i.test(text.replace(/#.*$/gm, "")), "no contiene sentencias de escritura");
        continue;
      }
      read(f).split("\n").forEach((line, i) => {
        if (/--remote\b/.test(line)) {
          const isRejectionCheck = rel(f) === "api/test/local-account.test.mjs" && /\bremote\s*=\s*node\(/.test(line);
          const isComment = /^\s*(\/\/|\*|#)/.test(line);
          const isGuard = /includes\(["']--remote["']\)|rechaz|no est[aá] permitido/i.test(line);
          assert.ok(isRejectionCheck || isComment || isGuard, `${rel(f)}:${i + 1} usa --remote sin protegerse: ${line.trim()}`);
        }
        assert.ok(!/wrangler(\.js)?["']?,?\s+(deploy|publish)\b/.test(line) && !/\bnpx\s+wrangler\s+(deploy|publish)\b/.test(line), `${rel(f)}:${i + 1} despliega`);
      });
    }
    const guard = read(path.join(root, "api", "scripts", "local-account.mjs"));
    assert.ok(/--remote/.test(guard), "local-account.mjs rechaza --remote explícitamente");
  });

  it("todo archivo de pruebas o scripts que invoca wrangler d1 usa --local (nunca la base remota)", () => {
    let checked = 0;
    for (const f of files.filter((x) => /api[\\/](test|scripts)/.test(x))) {
      const text = read(f);
      if (!/["']d1["']/.test(text)) continue;
      checked++;
      assert.ok(/["']--local["']/.test(text), `${rel(f)} invoca wrangler d1 sin --local`);
    }
    assert.ok(checked >= 2, `archivos revisados: ${checked}`);
    assert.ok(/MISSI_LOCAL_STATE/.test(read(path.join(root, "api", "scripts", "reset-local-db.mjs"))), "el reinicio exige un estado local explícito");
  });

  it("la suite de la API usa una carpeta de estado aislada y su propio puerto, no la base de desarrollo", () => {
    const t = read(path.join(root, "api", "test", "api.test.mjs"));
    assert.match(t, /const STATE = "\.wrangler\/test-state"/);
    assert.match(t, /const PORT = 8799/);
    assert.ok(!/persist-to["',\s]+["']?\.wrangler\/state/.test(t), "la suite no toca .wrangler/state (desarrollo)");
  });

  it("no hay script de despliegue en package.json (el despliegue requiere aprobación explícita)", () => {
    for (const p of ["package.json", "api/package.json"]) {
      const scripts = JSON.parse(read(path.join(root, p))).scripts ?? {};
      for (const [name, cmd] of Object.entries(scripts)) assert.ok(!/deploy|publish|--remote/.test(`${name} ${cmd}`), `${p}: script «${name}»`);
    }
  });
});

describe("sin secretos en el repositorio", () => {
  const code = [...walk(path.join(root, "src"), [".ts", ".tsx"]), ...walk(path.join(root, "api", "src"), [".ts"]), ...walk(path.join(root, "shared"), [".ts"])];

  it("el código no contiene claves, tokens ni contraseñas incrustadas", () => {
    const patterns = [
      /sb_secret_[A-Za-z0-9_-]{10,}/,
      /service_role/i,
      /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /AKIA[0-9A-Z]{16}/,
      /(api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{12,}["']/i,
    ];
    for (const f of code) {
      const text = read(f);
      for (const p of patterns) assert.ok(!p.test(text), `${rel(f)} coincide con ${p}`);
    }
  });

  it(".env solo contiene la URL pública de la API y está excluido de Git", () => {
    const env = read(path.join(root, ".env")).split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    assert.ok(env.length >= 1);
    for (const line of env) assert.match(line, /^VITE_API_BASE_URL=/, `variable inesperada: ${line.split("=")[0]}`);
    assert.match(read(path.join(root, ".gitignore")), /^\.env$/m);
    assert.ok(existsSync(path.join(root, ".env.example")));
  });

  it("la configuración del Worker no incluye secretos (solo orígenes y TTL)", () => {
    const cfg = read(path.join(root, "api", "wrangler.jsonc"));
    const start = cfg.indexOf('"vars"');
    const vars = cfg.slice(start, cfg.indexOf("}", start));
    assert.ok(/ALLOWED_ORIGINS/.test(vars) && /SESSION_TTL_HOURS/.test(vars));
    assert.ok(!/password|secret|token|key/i.test(vars.replace(/SESSION_TTL_HOURS/g, "")), "vars sin secretos");
  });

  it("no queda dependencia ni configuración de Supabase en la aplicación activa", () => {
    for (const p of ["package.json", "api/package.json"]) assert.ok(!/supabase/i.test(read(path.join(root, p))), p);
    for (const f of code) assert.ok(!/supabase/i.test(read(f)), `${rel(f)} menciona Supabase`);
    for (const f of ["index.html", "vite.config.ts", ".env", ".env.example", "api/wrangler.jsonc"]) assert.ok(!/supabase/i.test(read(path.join(root, f))), f);
  });
});

describe("SQL: las consultas del Worker se parametrizan", () => {
  it("ninguna interpolación dentro de una consulta SQL usa datos de la petición (solo fragmentos internos y enteros de la base)", () => {
    // Nombres que contienen texto o números que vienen del cliente: jamás deben aparecer dentro de ${...} en un SQL.
    const tainted = /\b(body|request|searchParams|url|param|params|raw|depto|provincia|municipio|nombre|email|identifier|password|motivo|detalle|notas)\b|\bq\b(?!\w)/;
    let checked = 0;
    for (const f of walk(path.join(root, "api", "src"), [".ts"])) {
      for (const m of read(f).matchAll(/\.prepare\(\s*`([^`]*)`/g)) {
        for (const interp of m[1].matchAll(/\$\{([^}]*)\}/g)) {
          checked++;
          assert.ok(!tainted.test(interp[1]), `${rel(f)}: \${${interp[1].trim().slice(0, 70)}} usa datos de la petición dentro del SQL`);
        }
      }
    }
    assert.ok(checked > 20, `se revisaron ${checked} interpolaciones`);
  });

  it("los filtros de usuario viajan como parámetros (.bind) y nunca en el texto del SQL", () => {
    assert.match(read(path.join(root, "api", "src", "routes", "sales.ts")), /binds\.push\(departmentKey\(/);
    assert.match(read(path.join(root, "api", "src", "routes", "sales.ts")), /likeParam\(/);
    assert.match(read(path.join(root, "api", "src", "routes", "movements.ts")), /binds\.push\(\.\.\.vals\)/);
  });
});
