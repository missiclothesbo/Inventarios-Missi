import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // En produccion la API debe ser un https publico: nunca se compila con localhost ni sin URL.
  if (mode === "production") {
    const raw = loadEnv(mode, process.cwd(), "VITE_").VITE_API_BASE_URL?.trim();
    let host = "";
    let protocol = "";
    try {
      const u = new URL(raw ?? "");
      host = u.hostname;
      protocol = u.protocol;
    } catch {
      /* invalida: se informa abajo */
    }
    const local = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(host);
    if (!host || local || protocol !== "https:") {
      throw new Error(
        `Build de produccion abortado: VITE_API_BASE_URL debe ser una URL https publica (recibido: "${raw ?? ""}"). ` +
          "Defínela en .env.production.",
      );
    }
  }
  return { plugins: [react(), tailwindcss()] };
});
