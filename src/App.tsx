import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";

import MobileNav from "./components/layout/MobileNav";
import Sidebar from "./components/layout/Sidebar";
import Topbar from "./components/layout/Topbar";

import Dashboard from "./pages/Dashboard/Dashboard";
import Inventario from "./pages/Inventario/Inventario";
import Ventas from "./pages/Ventas/Ventas";
import Reportes from "./pages/Reportes/Reportes";
import Traspasos from "./pages/Traspasos/Traspasos";
import Movimientos from "./pages/Movimientos/Movimientos";
import Cambios from "./pages/Cambios/Cambios";
import ApiDiagnostico from "./pages/Diagnostico/ApiDiagnostico";
import Usuarios from "./pages/Usuarios/Usuarios";
import Colores from "./pages/Colores/Colores";
import { SucursalProvider } from "./context/SucursalProvider";
import { useSucursal } from "./context/useSucursal";
import { AuthProvider } from "./context/AuthProvider";
import { useAuth } from "./context/useAuth";
import { api } from "./lib/api";
import Login from "./pages/Login/Login";

function BranchGate({ children }: { children: ReactNode }) {
  const { loading, error, branches, reload } = useSucursal();
  const { pathname } = useLocation();

  // El diagnóstico de la API es independiente de las sucursales y debe poder abrirse
  // aunque la carga de sucursales falle.
  if (pathname === "/diagnostico-api") {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-600">
        Cargando sucursales…
      </div>
    );
  }

  if (error || branches.length === 0) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">
        <p className="font-semibold">No se pudieron cargar las sucursales</p>
        <p className="mt-1">
          {error ||
            "No hay sucursales disponibles para tu usuario. Pide a un administrador que revise tu sucursal asignada."}
        </p>
        <button
          type="button"
          onClick={reload}
          className="mt-4 rounded-lg bg-black px-4 py-2 font-medium text-white hover:bg-gray-800"
        >
          Reintentar
        </button>
      </div>
    );
  }

  return <>{children}</>;
}

/** Rutas solo para administrador (el servidor también lo exige en cada endpoint). */
function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user?.rol === "admin" ? <>{children}</> : <Navigate to="/" replace />;
}

function Shell() {
  return (
    <SucursalProvider>
    <BrowserRouter>
      <div className="flex min-h-dvh bg-gray-50">
        <Sidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="sticky top-0 z-30 print:hidden md:static"><Topbar /></div>

          {/* Móvil: el padding inferior reserva el alto de la barra de navegación + el área segura. */}
          <main className="min-w-0 flex-1 px-4 pt-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-6 md:p-6 lg:p-8 print:overflow-visible print:p-0">

            <BranchGate>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/inventario" element={<Inventario />} />
              <Route path="/ventas" element={<Ventas />} />
              <Route path="/traspasos" element={<Traspasos />} />
              <Route path="/movimientos" element={<Movimientos />} />
              <Route path="/cambios" element={<Cambios />} />
              <Route path="/reportes" element={<Reportes />} />
              <Route path="/colores" element={<AdminOnly><Colores /></AdminOnly>} />
              <Route path="/usuarios" element={<AdminOnly><Usuarios /></AdminOnly>} />
              <Route path="/diagnostico-api" element={<ApiDiagnostico />} />

              <Route
                path="*"
                element={<Navigate to="/" replace />}
              />
            </Routes>
            </BranchGate>
          </main>
        </div>
        <MobileNav />
      </div>
    </BrowserRouter>
    </SucursalProvider>
  );
}

function AuthGate() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-gray-50 text-sm text-gray-600">
        Verificando sesión…
      </div>
    );
  }

  if (!user) return <Login />;

  // key: al cambiar de usuario se descarta todo el estado (sucursal, datos en pantalla).
  return <Shell key={user.id} />;
}

function App() {
  if (api.configError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-gray-50 p-4 sm:p-6">
        <div className="max-w-lg rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          <p className="font-semibold">Configuración de la API incompleta</p>
          <p className="mt-1">{api.configError}</p>
          <p className="mt-2">Corrige el archivo .env y reinicia el servidor (npm run dev).</p>
        </div>
      </div>
    );
  }

  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

export default App;
