import { useCallback, useEffect, useState } from "react";

import {
  testApiConnection,
  type ApiConnectionReport,
} from "../../services/api.service";

function Row({
  label,
  result,
}: {
  label: string;
  result: { ok: boolean; ms: number; detail: string };
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
      <span className="font-medium text-black">{label}</span>
      <span className={result.ok ? "text-green-700" : "text-red-700"}>
        {result.ok ? "OK" : "Falló"} · {result.ms} ms · {result.detail}
      </span>
    </li>
  );
}

/**
 * Pantalla oculta (/diagnostico-api, sin enlace en el menú) para comprobar la
 * conexión con el Worker. Solo hace GET; no modifica datos.
 */
function ApiDiagnostico() {
  const [report, setReport] = useState<ApiConnectionReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setReport(await testApiConnection());
    setRunning(false);
  }, []);

  useEffect(() => {
    // Prueba inicial automática (solo lectura).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run();
  }, [run]);

  return (
    <section className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-black">Diagnóstico de API</h1>
        <p className="mt-1 text-sm text-gray-500">
          Prueba de conexión de solo lectura con el Worker de Cloudflare (requiere sesión iniciada para listar sucursales).
          {report?.baseUrl ? ` (${report.baseUrl})` : ""}
        </p>
      </div>

      {report && (
        <>
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white px-5">
            <Row label="GET /api/health" result={report.health} />
            <Row label="GET /api/sucursales" result={report.sucursales} />
          </ul>

          {report.sucursales.rows.length > 0 && (
            <ul className="rounded-xl border border-gray-200 bg-white p-5 text-sm">
              {report.sucursales.rows.map((row) => (
                <li key={row.id}>
                  #{row.id} · {row.codigo} · {row.nombre}{row.es_central ? " (central)" : ""}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <button
        type="button"
        onClick={() => void run()}
        disabled={running}
        className="rounded-lg bg-black px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
      >
        {running ? "Probando..." : "Repetir prueba"}
      </button>
    </section>
  );
}

export default ApiDiagnostico;
