# Inventario MISSI

React + Vite (frontend) → Cloudflare Worker (`api/`) → Cloudflare D1. Ver [ARCHITECTURE.md](ARCHITECTURE.md) y [api/README.md](api/README.md).

Desarrollo local:
1. `cd api && npm install && npm run dev` (API en http://127.0.0.1:8790; usa la base local `api/.wrangler/state`)
2. Crear un administrador local (ver ARCHITECTURE.md) y, en la raíz, `npm install && npm run dev`.
3. Copia `.env.example` a `.env` (solo contiene `VITE_API_BASE_URL`).
4. Cuentas de vendedores: entra como administrador → menú **Usuarios** → "Nueva cuenta" (rol Vendedor + sucursal).
   Cada vendedor inicia sesión con su correo o su usuario y solo opera en su sucursal.
