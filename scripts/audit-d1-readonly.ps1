# Auditoría de SOLO LECTURA de la base D1 "inventarios-missi".
# Ejecuta únicamente SELECT sobre sqlite_master / pragma_* / COUNT(*). No modifica nada
# y NO lee filas de datos (solo estructura y conteos). No imprime tokens ni credenciales.
#
# Requisitos (los haces tú, en tu terminal):
#   1) npx wrangler login        (abre el navegador; la sesión queda en tu equipo)
#   2) npx wrangler whoami       (verifica que ves tu cuenta)
# Uso:
#   powershell -ExecutionPolicy Bypass -File scripts\audit-d1-readonly.ps1
# Resultado: d1-audit-output.txt (raiz del proyecto)  -> pega su contenido en el chat.
# Nota: no usa wrangler.jsonc (el del proyecto es una plantilla); resuelve la base por nombre en tu cuenta.

param(
  [string]$Database = "inventarios-missi",
  [string]$DatabaseId = "2384fad4-6c9d-4e60-821e-91ce3ac89cf5"
)

# Wrangler escribe avisos en stderr; con "Stop" PowerShell 5.1 los convierte en error. Los fallos reales se detectan con $LASTEXITCODE.
$ErrorActionPreference = "Continue"
$out = Join-Path (Split-Path $PSScriptRoot -Parent) "d1-audit-output.txt"
"" | Set-Content $out -Encoding utf8

function Invoke-D1ReadOnly([string]$Title, [string]$Sql) {
  # Defensa: solo SELECT/WITH, o PRAGMA de lectura de una lista blanca sobre una tabla concreta.
  $q = $Sql.Trim()
  $isSelect = $q -match '^(?i)(select|with)\b'
  $isReadPragma = $q -match '^(?i)PRAGMA\s+(foreign_key_list|index_list|table_info)\(\s*[A-Za-z0-9_]+\s*\)$'
  if (-not ($isSelect -or $isReadPragma)) {
    throw "Consulta bloqueada (no es SELECT): $Title"
  }
  Add-Content $out "`n===== $Title =====" -Encoding utf8
  $json = npx wrangler d1 execute $Database --remote --json --command $Sql
  if ($LASTEXITCODE -ne 0) { throw "wrangler fallo en: $Title (codigo $LASTEXITCODE). Revisa 'npx wrangler whoami'." }
  Add-Content $out ($json -join "`n") -Encoding utf8
}

# 0. Comprueba (solo lectura) que el nombre corresponde al ID esperado antes de consultar.
$list = npx wrangler d1 list --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "No se pudo listar D1. Ejecuta primero: npx wrangler login" }
$match = $list | Where-Object { $_.uuid -eq $DatabaseId -and $_.name -eq $Database }
if (-not $match) { throw "No se encontro una base '$Database' con ID $DatabaseId en tu cuenta. No se consulto nada." }
Add-Content $out "Base verificada: $Database ($DatabaseId)" -Encoding utf8

Invoke-D1ReadOnly "1. sqlite_master (tablas, indices, triggers, vistas)" `
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name"

Invoke-D1ReadOnly "2. Columnas de cada tabla (PRAGMA table_info)" `
  "SELECT m.name AS tabla, p.cid, p.name AS columna, p.type, p.[notnull], p.dflt_value, p.pk FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%' ORDER BY m.name, p.cid"

# Nombres de tablas (de sqlite_master). D1 bloquea pragma_*() como funcion en algunos casos
# (SQLITE_AUTH), asi que FKs e indices se leen con PRAGMA por tabla.
$names = (npx wrangler d1 execute $Database --remote --json --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name" | ConvertFrom-Json)[0].results.name
foreach ($t in $names) {
  if ($t -notmatch '^[A-Za-z0-9_]+$') { Add-Content $out "omitida tabla con nombre no estandar" -Encoding utf8; continue }
  Invoke-D1ReadOnly "3. Llaves foraneas de $t" "PRAGMA foreign_key_list($t)"
  Invoke-D1ReadOnly "4. Indices de $t" "PRAGMA index_list($t)"
}

foreach ($t in $names) {
  if ($t -notmatch '^[A-Za-z0-9_]+$') { continue }
  Invoke-D1ReadOnly "5. Conteo de $t" "SELECT '$t' AS tabla, COUNT(*) AS filas FROM [$t]"
}

Write-Host "Listo. Revisa y pega el contenido de: $out"
