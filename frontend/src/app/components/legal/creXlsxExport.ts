"use client";

import ExcelJS from "exceljs";
import type { ColumnConfig, CocoLegalDocument, TabularCell } from "../shared/types";
import { preprocessCitations } from "../tabular/citation-utils";
import type { CellFlag } from "./creShared";

/**
 * Strip the inline `[[page:N||quote:...]]` citation markers (and any plain
 * `[[pill]]` markers) from a cell summary, leaving a clean human-readable
 * value for a spreadsheet cell. Pure — no DOM, no workbook state — so the
 * value/marker-stripping behaviour can be reasoned about and reused.
 * Mirrors the stripping used by the tabular Excel export.
 */
export function cleanCellValue(summary: string | undefined | null): string {
    if (!summary) return "";
    const { processed } = preprocessCitations(summary);
    return processed
        .replace(/§\d+§/g, "")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim();
}

/**
 * Collect the page references cited in a cell summary as a compact note
 * (e.g. "pp. 3, 12"). Lets the abstract keep traceability in a trailing notes
 * column without cluttering the value cell.
 */
export function citedPagesNote(summary: string | undefined | null): string {
    if (!summary) return "";
    const { citations } = preprocessCitations(summary);
    if (citations.length === 0) return "";
    const pages = Array.from(new Set(citations.map((c) => c.page))).sort(
        (a, b) => a - b,
    );
    return pages.length === 1 ? `p. ${pages[0]}` : `pp. ${pages.join(", ")}`;
}

// ExcelJS argb fills keyed by flag. Light tints that read well behind text.
const FLAG_FILL: Record<CellFlag, string> = {
    green: "FFDCFCE7", // emerald-100
    yellow: "FFFEF3C7", // amber-100
    red: "FFFEE2E2", // red-100
    grey: "FFF3F4F6", // gray-100
};

function flagFill(flag: string | undefined): ExcelJS.Fill | undefined {
    if (!flag || !(flag in FLAG_FILL)) return undefined;
    return {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: FLAG_FILL[flag as CellFlag] },
    };
}

function cellValueFor(cell: TabularCell | undefined): string {
    if (!cell) return "";
    if (cell.status === "pending" || cell.status === "generating") return "";
    if (cell.status === "error") return "Error";
    return cleanCellValue(cell.content?.summary);
}

function sanitizeFilename(name: string): string {
    return (
        name
            .replace(/[\\/:*?"<>|]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || "Lease Abstract"
    );
}

function triggerDownload(buffer: ArrayBuffer, filename: string) {
    const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/**
 * Build a lease-abstract workbook from a CRE tabular review's columns + cells.
 *
 * Orientation adapts to the data, matching how the grid reads:
 *  - Single document → one row per term (Term | Value | Flag | Page Refs), the
 *    classic single-asset lease abstract.
 *  - Multiple documents → documents as rows and terms as columns (mirrors the
 *    tabular grid), with each value cell tinted by its flag.
 *
 * Returns the populated workbook so callers can write/serialize it; pass it to
 * downloadLeaseAbstractWorkbook to trigger a browser download.
 */
export async function buildLeaseAbstractWorkbook(
    columns: ColumnConfig[],
    cells: TabularCell[],
    documents: CocoLegalDocument[] = [],
): Promise<ExcelJS.Workbook> {
    const sortedCols = [...columns].sort((a, b) => a.index - b.index);
    const cellMap = new Map<string, TabularCell>();
    for (const c of cells) cellMap.set(`${c.document_id}:${c.column_index}`, c);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Lease Abstract");

    const singleDoc = documents.length <= 1;
    const doc = documents[0];

    if (singleDoc) {
        // Term-per-row abstract.
        ws.columns = [
            { header: "Term", width: 28 },
            { header: "Value", width: 70 },
            { header: "Flag", width: 10 },
            { header: "Page Refs", width: 14 },
        ];
        styleHeaderRow(ws.getRow(1));

        for (const col of sortedCols) {
            const cell = doc
                ? cellMap.get(`${doc.id}:${col.index}`)
                : cells.find((c) => c.column_index === col.index);
            const flag = cell?.content?.flag;
            const row = ws.addRow([
                col.name,
                cellValueFor(cell),
                flag ?? "",
                citedPagesNote(cell?.content?.summary),
            ]);
            row.alignment = { vertical: "top", wrapText: true };
            const fill = flagFill(flag);
            if (fill) row.getCell(3).fill = fill;
        }
    } else {
        // Documents-as-rows grid (mirrors the tabular review layout).
        ws.columns = [
            { header: "Document", width: 40 },
            ...sortedCols.map((c) => ({ header: c.name, width: 32 })),
        ];
        styleHeaderRow(ws.getRow(1));

        for (const document of documents) {
            const values: string[] = [document.filename];
            for (const col of sortedCols) {
                values.push(cellValueFor(cellMap.get(`${document.id}:${col.index}`)));
            }
            const row = ws.addRow(values);
            row.alignment = { vertical: "top", wrapText: true };
            // Tint each value cell by its flag (offset by the Document column).
            sortedCols.forEach((col, i) => {
                const flag = cellMap.get(`${document.id}:${col.index}`)?.content
                    ?.flag;
                const fill = flagFill(flag);
                if (fill) row.getCell(i + 2).fill = fill;
            });
        }
    }

    return wb;
}

function styleHeaderRow(row: ExcelJS.Row) {
    row.font = { bold: true };
    row.alignment = { vertical: "middle" };
    row.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF3F4F6" },
    };
}

/** Build the lease-abstract workbook and trigger a browser download. */
export async function downloadLeaseAbstractWorkbook(params: {
    title: string;
    columns: ColumnConfig[];
    cells: TabularCell[];
    documents?: CocoLegalDocument[];
}): Promise<void> {
    const wb = await buildLeaseAbstractWorkbook(
        params.columns,
        params.cells,
        params.documents ?? [],
    );
    const buffer = await wb.xlsx.writeBuffer();
    triggerDownload(buffer, sanitizeFilename(params.title));
}
