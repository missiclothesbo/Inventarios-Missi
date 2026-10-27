/**
 * Exportación a CSV (se abre bien en Excel: separador coma, comillas dobles y BOM UTF-8 para tildes).
 * Lógica pura; la descarga en el navegador está en `downloadCsv`.
 */

export type CsvCell = string | number | null | undefined;

/** Escapa una celda. Las que empiezan con = + - @ se prefijan con comilla simple para que Excel no las ejecute como fórmula. */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** Nombre de archivo seguro: sin tildes, espacios ni símbolos. */
export function csvFileName(base: string, desde?: string, hasta?: string): string {
  const clean = base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${clean}${desde && hasta ? `_${desde}_a_${hasta}` : "_todo-el-historial"}.csv`;
}

export function downloadCsv(fileName: string, content: string): void {
  const blob = new Blob(["﻿", content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
