import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, UserPlus, Users } from "lucide-react";

import { useAuth } from "../../context/useAuth";
import { useSucursal } from "../../context/useSucursal";
import { createUser, listUsers, updateUser, type UserRow } from "../../services/users.service";
import {
  EMPTY_USER,
  MIN_PASSWORD,
  editPatch,
  newUserPayload,
  passwordError,
  sqliteUtcToIso,
  validateEdit,
  validateNewUser,
  type EditForm,
  type UserErrors,
  type UserForm,
} from "../../lib/usuarios";
import { formatBoliviaDateTime } from "../../lib/receipt";

const INPUT =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-black disabled:bg-gray-100";
const LABEL = "mb-1 block text-xs font-medium text-gray-600";
const ROL_TEXT = { admin: "Administrador", vendedor: "Vendedor" } as const;

function FieldError({ text }: { text?: string }) {
  return text ? <p className="mt-1 text-xs text-red-600">{text}</p> : null;
}

type Panel = { kind: "editar"; user: UserRow; form: EditForm } | { kind: "clave"; user: UserRow; password: string; password2: string } | null;

/** Gestión de cuentas (solo administrador). El servidor vuelve a validar permisos y datos. */
function Usuarios() {
  const { user: me, logout } = useAuth();
  const { branches } = useSucursal();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState<UserForm>(EMPTY_USER);
  const [errors, setErrors] = useState<UserErrors>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [serverError, setServerError] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [panelErrors, setPanelErrors] = useState<Record<string, string>>({});
  const panelRef = useRef<HTMLFormElement>(null);
  const panelKey = panel ? `${panel.kind}-${panel.user.id}` : "";
  useEffect(() => {
    if (panelKey) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [panelKey]);

  const branchName = (id: number | null) => (id === null ? "Todas" : (branches.find((b) => b.id === id)?.nombre ?? `Sucursal ${id}`));

  const fetchRows = useCallback(
    () =>
      listUsers()
        .then((list) => {
          setRows(list);
          setLoadError("");
        })
        .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : "No se pudo cargar la lista de usuarios."))
        .finally(() => setLoading(false)),
    [],
  );

  /** Recarga desde un evento (botón, después de guardar). */
  const load = useCallback(() => {
    setLoading(true);
    return fetchRows();
  }, [fetchRows]);

  const isAdmin = me?.rol === "admin";
  useEffect(() => {
    if (isAdmin) void fetchRows();
  }, [isAdmin, fetchRows]);

  if (!isAdmin || !me) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">
        Solo un administrador puede gestionar usuarios.
      </div>
    );
  }

  function edit(patch: Partial<UserForm>) {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch) as (keyof UserForm)[]) delete next[k === "password2" ? "password" : k];
      return next;
    });
    setServerError("");
    setNotice("");
  }

  async function submitNew(e: React.FormEvent) {
    e.preventDefault();
    const found = validateNewUser(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setServerError("");
    try {
      const payload = newUserPayload(form);
      await createUser(payload);
      setNotice(`Cuenta creada para ${payload.email}${payload.username ? ` (usuario ${payload.username})` : ""}. Ya puede iniciar sesión con su correo o usuario.`);
      setForm(EMPTY_USER);
      await fetchRows();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "No se pudo crear la cuenta.");
    } finally {
      setSaving(false);
    }
  }

  async function apply(u: UserRow, patch: Parameters<typeof updateUser>[1], message: string) {
    setSaving(true);
    setServerError("");
    setNotice("");
    try {
      await updateUser(u.id, patch);
      setPanel(null);
      setPanelErrors({});
      // Cambiar la propia contraseña cierra también esta sesión: se vuelve al inicio de sesión.
      if (u.id === me?.id && patch.password !== undefined) {
        await logout();
        return;
      }
      setNotice(message);
      await fetchRows();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "No se pudo guardar el cambio.");
    } finally {
      setSaving(false);
    }
  }

  function savePanel(e: React.FormEvent) {
    e.preventDefault();
    if (!panel) return;
    if (panel.kind === "editar") {
      const found = validateEdit(panel.form);
      setPanelErrors(found);
      if (Object.keys(found).length > 0) return;
      const { patch, permisos } = editPatch(panel.user, panel.form);
      if (Object.keys(patch).length === 0) {
        setPanel(null);
        return;
      }
      void apply(panel.user, patch, permisos ? `Datos de ${panel.user.email} guardados. Debe volver a iniciar sesión para usar sus nuevos permisos.` : `Datos de ${panel.user.email} guardados.`);
    } else {
      const err = passwordError(panel.password, panel.password2);
      setPanelErrors(err ? { password: err } : {});
      if (err) return;
      void apply(panel.user, { password: panel.password }, `Contraseña de ${panel.user.email} actualizada. Sus sesiones abiertas se cerraron.`);
    }
  }

  const rowActions = (u: UserRow) => {
    const self = u.id === me.id;
    const btn = "min-h-11 rounded-lg border px-3 py-1.5 lg:min-h-9";
    return (
      <div className="flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={() => {
            setPanelErrors({});
            setPanel({ kind: "editar", user: u, form: { nombre: u.nombre, username: u.username ?? "", rol: u.rol, sucursalId: u.sucursal_id ? String(u.sucursal_id) : "" } });
          }}
          className={`${btn} border-gray-300 hover:border-black`}
        >
          Editar
        </button>
        <button
          type="button"
          onClick={() => {
            setPanelErrors({});
            setPanel({ kind: "clave", user: u, password: "", password2: "" });
          }}
          className={`${btn} border-gray-300 hover:border-black`}
        >
          Contraseña
        </button>
        {!self && (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              // Desactivar cierra sus sesiones: se confirma antes.
              if (u.activo && !window.confirm(`¿Desactivar la cuenta ${u.email}? No podrá iniciar sesión hasta reactivarla.`)) return;
              void apply(u, { activo: !u.activo }, u.activo ? `Cuenta ${u.email} desactivada: ya no puede iniciar sesión.` : `Cuenta ${u.email} activada.`);
            }}
            className={`${btn} disabled:opacity-60 ${u.activo ? "border-red-200 text-red-700 hover:border-red-500" : "border-green-200 text-green-700 hover:border-green-500"}`}
          >
            {u.activo ? "Desactivar" : "Activar"}
          </button>
        )}
      </div>
    );
  };

  const sucursalSelect = (value: string, onChange: (v: string) => void, id: string) => (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}>
      <option value="">Elige sucursal</option>
      {branches.map((b) => (
        <option key={b.id} value={b.id}>
          {b.nombre}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl sm:text-2xl font-semibold text-black">
          <Users size={22} /> Usuarios
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Crea cuentas para vendedores y administradores. Cada vendedor trabaja solo con la sucursal asignada. Las contraseñas no se muestran nunca.
        </p>
      </div>

      {notice && <p className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{notice}</p>}
      {serverError && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {serverError}
        </p>
      )}

      <form onSubmit={submitNew} noValidate className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-gray-500">
          <UserPlus size={16} /> Nueva cuenta
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="u-nombre" className={LABEL}>Nombre</label>
            <input id="u-nombre" value={form.nombre} maxLength={120} onChange={(e) => edit({ nombre: e.target.value })} className={INPUT} />
            <FieldError text={errors.nombre} />
          </div>
          <div>
            <label htmlFor="u-email" className={LABEL}>Correo</label>
            <input id="u-email" type="email" inputMode="email" autoCapitalize="none" autoCorrect="off" autoComplete="off" value={form.email} maxLength={200} onChange={(e) => edit({ email: e.target.value })} className={INPUT} />
            <FieldError text={errors.email} />
          </div>
          <div>
            <label htmlFor="u-username" className={LABEL}>Usuario (opcional)</label>
            <input id="u-username" autoCapitalize="none" autoCorrect="off" autoComplete="off" value={form.username} maxLength={30} onChange={(e) => edit({ username: e.target.value })} className={INPUT} placeholder="ej.: ana.cb" />
            <FieldError text={errors.username} />
          </div>
          <div>
            <label htmlFor="u-rol" className={LABEL}>Rol</label>
            <select id="u-rol" value={form.rol} onChange={(e) => edit({ rol: e.target.value as UserForm["rol"], sucursalId: "" })} className={INPUT}>
              <option value="vendedor">Vendedor</option>
              <option value="admin">Administrador</option>
            </select>
          </div>
          <div>
            <label htmlFor="u-sucursal" className={LABEL}>Sucursal</label>
            {form.rol === "vendedor" ? (
              sucursalSelect(form.sucursalId, (v) => edit({ sucursalId: v }), "u-sucursal")
            ) : (
              <input id="u-sucursal" disabled value="Todas (administrador)" className={INPUT} />
            )}
            <FieldError text={errors.sucursalId} />
          </div>
          <div className="hidden lg:block" />
          <div>
            <label htmlFor="u-pass" className={LABEL}>Contraseña (mínimo {MIN_PASSWORD} caracteres)</label>
            <input id="u-pass" type="password" autoComplete="new-password" value={form.password} onChange={(e) => edit({ password: e.target.value })} className={INPUT} />
            <FieldError text={errors.password} />
          </div>
          <div>
            <label htmlFor="u-pass2" className={LABEL}>Repetir contraseña</label>
            <input id="u-pass2" type="password" autoComplete="new-password" value={form.password2} onChange={(e) => edit({ password2: e.target.value })} className={INPUT} />
          </div>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={saving}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
            >
              {saving && <LoaderCircle size={16} className="animate-spin" />} CREAR CUENTA
            </button>
          </div>
        </div>
      </form>

      {panel && (
        <form ref={panelRef} onSubmit={savePanel} noValidate className="scroll-mt-20 rounded-xl border border-black bg-white p-4 shadow-sm sm:p-5">
          <h2 className="mb-4 text-sm font-semibold text-black">
            {panel.kind === "editar" ? "Editar" : "Nueva contraseña para"} {panel.user.email}
          </h2>
          {panel.kind === "editar" ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label htmlFor="e-nombre" className={LABEL}>Nombre</label>
                <input id="e-nombre" value={panel.form.nombre} maxLength={120} onChange={(e) => setPanel({ ...panel, form: { ...panel.form, nombre: e.target.value } })} className={INPUT} />
                <FieldError text={panelErrors.nombre} />
              </div>
              <div>
                <label htmlFor="e-username" className={LABEL}>Usuario (opcional)</label>
                <input id="e-username" value={panel.form.username} maxLength={30} onChange={(e) => setPanel({ ...panel, form: { ...panel.form, username: e.target.value } })} className={INPUT} />
                <FieldError text={panelErrors.username} />
              </div>
              <div>
                <label htmlFor="e-rol" className={LABEL}>Rol</label>
                <select
                  id="e-rol"
                  value={panel.form.rol}
                  disabled={panel.user.id === me.id}
                  onChange={(e) => setPanel({ ...panel, form: { ...panel.form, rol: e.target.value as EditForm["rol"] } })}
                  className={INPUT}
                >
                  <option value="vendedor">Vendedor</option>
                  <option value="admin">Administrador</option>
                </select>
                {panel.user.id === me.id && <p className="mt-1 text-xs text-gray-500">No puedes quitarte el rol de administrador.</p>}
              </div>
              <div>
                <label htmlFor="e-sucursal" className={LABEL}>Sucursal</label>
                {panel.form.rol === "vendedor" ? (
                  sucursalSelect(panel.form.sucursalId, (v) => setPanel({ ...panel, form: { ...panel.form, sucursalId: v } }), "e-sucursal")
                ) : (
                  <input id="e-sucursal" disabled value="Todas (administrador)" className={INPUT} />
                )}
                <FieldError text={panelErrors.sucursalId} />
              </div>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="c-pass" className={LABEL}>Nueva contraseña (mínimo {MIN_PASSWORD} caracteres)</label>
                <input id="c-pass" type="password" autoComplete="new-password" value={panel.password} onChange={(e) => setPanel({ ...panel, password: e.target.value })} className={INPUT} />
                <FieldError text={panelErrors.password} />
              </div>
              <div>
                <label htmlFor="c-pass2" className={LABEL}>Repetir contraseña</label>
                <input id="c-pass2" type="password" autoComplete="new-password" value={panel.password2} onChange={(e) => setPanel({ ...panel, password2: e.target.value })} className={INPUT} />
              </div>
              {panel.user.id === me.id && <p className="text-xs text-gray-500 sm:col-span-2">Es tu propia cuenta: al guardar se cerrará tu sesión y entrarás con la nueva contraseña.</p>}
            </div>
          )}
          <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row">
            <button type="submit" disabled={saving} className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60">
              {saving && <LoaderCircle size={16} className="animate-spin" />} GUARDAR
            </button>
            <button type="button" onClick={() => { setPanel(null); setPanelErrors({}); }} className="min-h-11 rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:border-black">
              CANCELAR
            </button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <p className="flex items-center gap-2 p-6 text-sm text-gray-500">
            <LoaderCircle size={16} className="animate-spin" /> Cargando usuarios...
          </p>
        ) : loadError ? (
          <div className="p-6 text-sm text-red-700">
            <p>{loadError}</p>
            <button type="button" onClick={() => void load()} className="mt-3 rounded-lg bg-black px-4 py-2 font-medium text-white hover:bg-gray-800">
              Reintentar
            </button>
          </div>
        ) : (
          <>
          {/* Móvil y tablet: tarjetas */}
          <ul className="divide-y divide-gray-100 lg:hidden">
            {rows.map((u) => (
              <li key={u.id} className={`space-y-2 p-4 ${u.activo ? "" : "bg-gray-50 text-gray-500"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-black">
                      {u.nombre}
                      {u.id === me.id && <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">tú</span>}
                    </p>
                    <p className="text-sm text-gray-600">{u.email}</p>
                    <p className="text-xs text-gray-500">
                      {u.username ? `Usuario ${u.username} · ` : ""}
                      {ROL_TEXT[u.rol]} · {branchName(u.sucursal_id)}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${u.activo ? "bg-green-50 text-green-700" : "bg-gray-200 text-gray-600"}`}>
                    {u.activo ? "Activa" : "Desactivada"}
                  </span>
                </div>
                <p className="text-xs text-gray-500">
                  Último acceso: {u.ultimo_login ? formatBoliviaDateTime(sqliteUtcToIso(u.ultimo_login)) : "nunca"}
                </p>
                {rowActions(u)}
              </li>
            ))}
          </ul>

          <table className="hidden w-full text-left text-sm lg:table">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3">Nombre</th>
                <th className="px-4 py-3">Correo</th>
                <th className="px-4 py-3">Usuario</th>
                <th className="px-4 py-3">Rol</th>
                <th className="px-4 py-3">Sucursal</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Último acceso</th>
                <th className="px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((u) => {
                const self = u.id === me.id;
                return (
                  <tr key={u.id} className={u.activo ? "" : "text-gray-400"}>
                    <td className="px-4 py-3 font-medium">
                      {u.nombre}
                      {self && <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">tú</span>}
                    </td>
                    <td className="px-4 py-3">{u.email}</td>
                    <td className="px-4 py-3">{u.username ?? "—"}</td>
                    <td className="px-4 py-3">{ROL_TEXT[u.rol]}</td>
                    <td className="px-4 py-3">{branchName(u.sucursal_id)}</td>
                    <td className="px-4 py-3">{u.activo ? "Activa" : "Desactivada"}</td>
                    <td className="px-4 py-3">{u.ultimo_login ? formatBoliviaDateTime(sqliteUtcToIso(u.ultimo_login)) : "Nunca"}</td>
                    <td className="px-4 py-3">{rowActions(u)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </>
        )}
      </div>
    </div>
  );
}

export default Usuarios;
