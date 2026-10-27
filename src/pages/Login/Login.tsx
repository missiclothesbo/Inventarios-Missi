
import { useState, type FormEvent } from "react";
import { useAuth } from "../../context/useAuth";

function Login() {
  const { login } = useAuth();

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      await login(identifier.trim(), password);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No se pudo iniciar sesión. Verifica tus datos.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gray-50 p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:p-6">
      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="w-full max-w-sm space-y-5 rounded-xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8"
      >
        <div>
          <p className="text-lg font-bold tracking-tight text-black">
            INVENTARIO MISSI
          </p>
          <p className="mt-1 text-sm text-gray-500">
            Inicia sesión para continuar.
          </p>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {error}
          </p>
        )}

        <div>
          <label
            htmlFor="login-identifier"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Correo electrónico o nombre de usuario
          </label>
          <input
            id="login-identifier"
            name="identifier"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            required
            maxLength={254}
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder="Correo o usuario (ej. nadith)"
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm outline-none focus:border-black"
          />
        </div>

        <div>
          <label
            htmlFor="login-password"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Contraseña
          </label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Ingresa tu contraseña"
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm outline-none focus:border-black"
          />
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-black px-4 py-3 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
        >
          {busy ? "Ingresando..." : "Ingresar"}
        </button>
      </form>
    </div>
  );
}

export default Login;
