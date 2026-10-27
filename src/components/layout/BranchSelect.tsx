import { useSucursal } from "../../context/useSucursal";
import { branchLabel } from "../../lib/ubicaciones";

/** Selector de sucursal (barra lateral y cabecera móvil). El vendedor solo recibe la suya. */
function BranchSelect({ id, compact = false }: { id: string; compact?: boolean }) {
  const { branches, selectedId, setSelectedId } = useSucursal();

  return (
    <select
      id={id}
      aria-label="Sucursal"
      value={selectedId ?? ""}
      onChange={(event) => setSelectedId(event.target.value ? Number(event.target.value) : null)}
      className={`w-full min-w-0 rounded-lg border border-gray-200 bg-gray-50 text-black outline-none focus:border-black ${
        compact ? "h-10 truncate px-2 text-sm font-medium" : "px-3 py-2 text-sm"
      }`}
    >
      {branches.map((branch) => (
        <option key={branch.id} value={branch.id}>
          {branchLabel(branch).toUpperCase()}
        </option>
      ))}
    </select>
  );
}

export default BranchSelect;
