// Comprobación previa a `npm run dev`: evita arrancar un segundo backend cuando el puerto 8790 ya está ocupado.
// En Windows, un proceso `workerd` que quedó colgado puede seguir escuchando: Wrangler dice "Ready" pero
// nada responde y el login muestra "No se pudo conectar con la API". Aquí se detecta y se explica.
import net from "node:net";

const PORT = 8790;

const listening = await new Promise((resolve) => {
  const socket = net.connect(PORT, "127.0.0.1");
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));
});

if (listening) {
  let healthy = false;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) });
    healthy = res.ok;
  } catch {
    healthy = false;
  }
  console.error(
    healthy
      ? `Ya hay un backend MISSI respondiendo en http://127.0.0.1:${PORT}. No hace falta iniciar otro.`
      : `El puerto ${PORT} está ocupado por un proceso que no responde (probablemente un backend anterior colgado).\n` +
          `Ciérralo y vuelve a ejecutar "npm run dev". En PowerShell:\n` +
          `  Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`,
  );
  process.exit(1);
}
