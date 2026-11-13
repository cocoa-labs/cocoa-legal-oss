import crypto from "node:crypto";
import type { createServerSupabase } from "./supabase";
import { generatedDocKey, uploadFile } from "./storage";
import { buildDownloadUrl } from "./downloadTokens";
import {
    describeSupabaseError,
    insertDocumentVersionCompat,
} from "./documentVersions";
import {
    layoutQaVersionValues,
    verifyDerivedArtifact,
} from "./documentLayoutGate";
import type { DocumentLayoutQaReport } from "./documentLayoutQa";

/**
 * Structured section input shared by single-pass generation and (later)
 * template-anchored assembly. Both paths feed these into one renderer.
 */
export interface DocxSection {
    heading?: string;
    content?: string;
    level?: number;
    pageBreak?: boolean;
    table?: { headers: string[]; rows: string[][] };
}

/** Generated prose sometimes uses HTML whitespace entities as indentation. */
export function normalizeDocxWhitespaceEntities(value: string): string {
    return value.replace(/&(?:nbsp|ensp|emsp|#0*160|#x0*a0);/gi, " ");
}

export type DocxRendererMode = "standard" | "compatibility";

export interface DocxRenderOptions {
    landscape?: boolean;
    /** Compact LibreOffice-compatible layout used after standard visual QA fails. */
    mode?: DocxRendererMode;
}

/**
 * Build a validated .docx buffer from structured sections. This is the pure
 * rendering half extracted from the original `generateDocx`: literal,
 * LibreOffice-compatible markers plus the same signature-block detection,
 * `{{coco-sign:N}}` anchor handling, and OOXML package validation. It does
 * NOT persist anything — callers pass the buffer to `persistAuthoredDocx`.
 */
export async function renderSectionsToDocxBuffer(
    title: string,
    sections: DocxSection[],
    options: DocxRenderOptions = {},
): Promise<{ buffer: Buffer } | { error: string }> {
    try {
        const {
            Document,
            Paragraph,
            HeadingLevel,
            Packer,
            Table,
            TableRow,
            TableCell,
            WidthType,
            TableLayoutType,
            BorderStyle,
            TextRun,
            AlignmentType,
            PageOrientation,
            PageBreak,
        } = await import("docx");

        const FONT = "Times New Roman";
        const compact = options.mode === "compatibility";
        const SIZE = compact ? 20 : 22; // half-points: 10pt / 11pt
        const MARGIN = compact ? 1080 : 1440; // 0.75in / 1in
        const TITLE_AFTER = compact ? 120 : 200;
        const HEADING_AFTER = compact ? 100 : 160;
        const BODY_AFTER = compact ? 60 : 120;
        const LINE_SPACING = compact ? 240 : 276;

        type DocChild =
            | InstanceType<typeof Paragraph>
            | InstanceType<typeof Table>;
        const children: DocChild[] = [];
        children.push(
            new Paragraph({
                heading: HeadingLevel.TITLE,
                spacing: { after: TITLE_AFTER },
                alignment: AlignmentType.CENTER,
                wordWrap: true,
                children: [
                    new TextRun({
                        text: normalizeDocxWhitespaceEntities(
                            title,
                        ).toUpperCase(),
                        color: "000000",
                        font: FONT,
                        size: SIZE,
                        bold: true,
                    }),
                ],
            }),
        );

        const cellBorder = {
            top: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
            left: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
            right: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
        };

        const headingLevels = [
            HeadingLevel.HEADING_1,
            HeadingLevel.HEADING_2,
            HeadingLevel.HEADING_3,
            HeadingLevel.HEADING_4,
        ];
        const inlineRuns = (
            value: string,
            forceBold = false,
        ): InstanceType<typeof TextRun>[] => {
            value = normalizeDocxWhitespaceEntities(value);
            const runs: InstanceType<typeof TextRun>[] = [];
            const pattern = /(\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*)/g;
            let cursor = 0;
            for (const match of value.matchAll(pattern)) {
                const index = match.index ?? 0;
                if (index > cursor) {
                    runs.push(
                        new TextRun({
                            text: value.slice(cursor, index),
                            font: FONT,
                            size: SIZE,
                            bold: forceBold,
                        }),
                    );
                }
                runs.push(
                    new TextRun({
                        text: match[2] ?? match[3] ?? "",
                        font: FONT,
                        size: SIZE,
                        bold: forceBold || !!match[2],
                        italics: !!match[3],
                    }),
                );
                cursor = index + match[0].length;
            }
            if (cursor < value.length || runs.length === 0) {
                runs.push(
                    new TextRun({
                        text: value.slice(cursor),
                        font: FONT,
                        size: SIZE,
                        bold: forceBold,
                    }),
                );
            }
            return runs;
        };
        const normalizeTable = (
            table: unknown,
        ): { headers: string[]; rows: string[][] } | null => {
            if (!table || typeof table !== "object") return null;
            const raw = table as { headers?: unknown; rows?: unknown };
            const headers = Array.isArray(raw.headers)
                ? raw.headers
                      .map((header) =>
                          typeof header === "string" ? header.trim() : "",
                      )
                      .filter(Boolean)
                : [];
            if (headers.length === 0) return null;

            const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
            const rows = rawRows
                .filter((row): row is unknown[] => Array.isArray(row))
                .map((row) =>
                    headers.map((_, i) =>
                        typeof row[i] === "string" ? row[i] : "",
                    ),
                );

            return { headers, rows };
        };
        const parseLiteralMarker = (value: string) => {
            const trimmed = value.trim();
            const match = trimmed.match(
                /^((?:\d+[.)]|\d+(?:\.\d+)+[.)]?)|\([a-zivxlcdm]+\)|[a-zivxlcdm]+[.)]|[-*\u2022\u25cf\u25aa\u25e6\u2023\u2013\u2014]|\[[ xX]\]|[\u2610\u2611\u2612])\s+(.+)$/i,
            );
            if (!match) {
                return {
                    marker: null as string | null,
                    text: trimmed,
                    numericLevel: null as number | null,
                    numericParts: null as number[] | null,
                };
            }
            const numeric = match[1].match(/^(\d+(?:\.\d+)*)/);
            const marker =
                match[1] === "☐"
                    ? "[ ]"
                    : match[1] === "☑" || match[1] === "☒"
                      ? "[x]"
                      : match[1];
            return {
                marker,
                text: match[2].trim(),
                numericLevel: numeric ? numeric[1].split(".").length - 1 : null,
                numericParts: numeric
                    ? numeric[1].split(".").map((part) => Number(part))
                    : null,
            };
        };
        const headingCounters = [0, 0, 0, 0];
        const alphabeticMarker = (value: number) => {
            let number = Math.max(1, value);
            let result = "";
            while (number > 0) {
                number -= 1;
                result = String.fromCharCode(97 + (number % 26)) + result;
                number = Math.floor(number / 26);
            }
            return result;
        };
        const romanMarker = (value: number) => {
            const table: [number, string][] = [
                [1000, "m"],
                [900, "cm"],
                [500, "d"],
                [400, "cd"],
                [100, "c"],
                [90, "xc"],
                [50, "l"],
                [40, "xl"],
                [10, "x"],
                [9, "ix"],
                [5, "v"],
                [4, "iv"],
                [1, "i"],
            ];
            let remaining = Math.max(1, value);
            let result = "";
            for (const [amount, token] of table) {
                while (remaining >= amount) {
                    result += token;
                    remaining -= amount;
                }
            }
            return result;
        };
        const nextHeadingMarker = (level: number) => {
            const idx = Math.max(0, Math.min(level, 3));
            if (idx > 0 && headingCounters[0] === 0) headingCounters[0] = 1;
            headingCounters[idx] += 1;
            for (let i = idx + 1; i < headingCounters.length; i++) {
                headingCounters[i] = 0;
            }
            if (idx === 0) return `${headingCounters[0]}.`;
            if (idx === 1) return `${headingCounters[0]}.${headingCounters[1]}`;
            if (idx === 2) return `(${alphabeticMarker(headingCounters[2])})`;
            return `(${romanMarker(headingCounters[3])})`;
        };
        const normalizeHeadingText = (value: string) =>
            value
                .trim()
                .replace(/[^a-zA-Z0-9]+/g, " ")
                .trim()
                .toLowerCase();

        const isTitleLikeFirstHeading = (
            heading: string,
            sectionIndex: number,
        ) => {
            if (sectionIndex !== 0) return false;
            const normalized = normalizeHeadingText(heading);
            const titleNormalized = normalizeHeadingText(title);
            if (!normalized || !titleNormalized) return false;
            if (normalized === titleNormalized) return true;
            return (
                titleNormalized.includes(normalized) &&
                /\b(agreement|contract|deed|terms|policy|notice|nda|disclosure)\b/.test(
                    normalized,
                )
            );
        };

        const isUnnumberedHeading = (heading: string, sectionIndex: number) => {
            const normalized = normalizeHeadingText(heading);
            if (!normalized) return true;
            if (normalized === "signatures" || normalized === "signature") {
                return true;
            }
            if (isTitleLikeFirstHeading(heading, sectionIndex)) {
                return true;
            }
            if (
                sectionIndex === 0 &&
                /^(agreement|contract|mutual non disclosure agreement|non disclosure agreement|employment agreement|service level agreement)$/.test(
                    normalized,
                )
            ) {
                return true;
            }
            return false;
        };
        for (const [sectionIndex, section] of (
            sections as {
                heading?: string;
                content?: string;
                level?: number;
                pageBreak?: boolean;
                table?: { headers: string[]; rows: string[][] };
            }[]
        ).entries()) {
            const normalizedTable = normalizeTable(section.table);
            const tableStartsFreshPage = !!normalizedTable && sectionIndex > 0;
            if ((section.pageBreak && !compact) || tableStartsFreshPage) {
                children.push(new Paragraph({ children: [new PageBreak()] }));
            }
            if (section.heading) {
                const parsed = parseLiteralMarker(section.heading);
                const isUnnumbered = isUnnumberedHeading(
                    parsed.text,
                    sectionIndex,
                );
                const skipHeading = isTitleLikeFirstHeading(
                    parsed.text,
                    sectionIndex,
                );
                const idx = Math.max(
                    0,
                    Math.min(
                        parsed.numericLevel ?? (section.level ?? 1) - 1,
                        3,
                    ),
                );
                if (parsed.numericParts) {
                    for (let i = 0; i < headingCounters.length; i += 1) {
                        headingCounters[i] = parsed.numericParts[i] ?? 0;
                    }
                }
                const marker =
                    parsed.marker ??
                    (isUnnumbered || skipHeading
                        ? null
                        : nextHeadingMarker(idx));
                const bodyText =
                    idx === 0 && !isUnnumbered
                        ? parsed.text.toUpperCase()
                        : parsed.text;
                const headingText = marker ? `${marker} ${bodyText}` : bodyText;
                if (!skipHeading) {
                    children.push(
                        new Paragraph({
                            heading: headingLevels[idx],
                            spacing: {
                                after: HEADING_AFTER,
                                line: LINE_SPACING,
                            },
                            indent: marker
                                ? { left: 540 + idx * 360, hanging: 360 }
                                : undefined,
                            wordWrap: true,
                            children: [
                                new TextRun({
                                    text: headingText,
                                    color: "000000",
                                    font: FONT,
                                    size: SIZE,
                                    bold: true,
                                }),
                            ],
                        }),
                    );
                }
            }
            if (normalizedTable) {
                const { headers, rows } = normalizedTable;
                const columnWeight = (header: string) => {
                    const value = header.toLowerCase();
                    if (/^(#|no\.?|id)$/.test(value)) return 0.4;
                    if (
                        /\b(detail|requirement|recommendation|description)\b/.test(
                            value,
                        )
                    ) {
                        return 2.4;
                    }
                    if (
                        /\b(notes?|dependencies|analysis|rationale)\b/.test(
                            value,
                        )
                    ) {
                        return 2;
                    }
                    if (
                        /\b(issue|item|workstream|task|milestone)\b/.test(value)
                    ) {
                        return 1.35;
                    }
                    if (
                        /\b(owner|status|target|week|date|section|track)\b/.test(
                            value,
                        )
                    ) {
                        return 0.75;
                    }
                    return 1;
                };
                const weights = headers.map(columnWeight);
                const totalWeight = weights.reduce(
                    (total, weight) => total + weight,
                    0,
                );
                const pageWidth = options.landscape ? 16_838 : 11_906;
                const usableWidth = pageWidth - MARGIN * 2;
                const columnWidths = weights.map((weight) =>
                    Math.floor((usableWidth * weight) / totalWeight),
                );
                columnWidths[columnWidths.length - 1] +=
                    usableWidth -
                    columnWidths.reduce((total, width) => total + width, 0);

                const charactersAcrossPage =
                    (options.landscape ? 132 : 84) * (compact ? 1.1 : 1);
                const charactersPerLine = columnWidths.map((width) =>
                    Math.max(
                        8,
                        Math.floor(
                            (charactersAcrossPage * width) / usableWidth,
                        ),
                    ),
                );
                const estimatedRowLines = (cells: string[]) =>
                    Math.max(
                        ...cells.map((cell, columnIndex) =>
                            cell
                                .split("\n")
                                .reduce(
                                    (total, line) =>
                                        total +
                                        Math.max(
                                            1,
                                            Math.ceil(
                                                line.length /
                                                    charactersPerLine[
                                                        columnIndex
                                                    ],
                                            ),
                                        ),
                                    0,
                                ),
                        ),
                    ) + 1;
                const pageLineBudget = options.landscape
                    ? compact
                        ? 35
                        : 29
                    : compact
                      ? 54
                      : 44;
                const headerLines = estimatedRowLines(headers);
                const tableBodyLineBudget = Math.max(
                    12,
                    pageLineBudget - headerLines - 4,
                );
                const rowCanFitOnOnePage = (cells: string[]) =>
                    estimatedRowLines(cells) <= tableBodyLineBudget;

                // LibreOffice's automatic repeated-header pagination can
                // misplace a fragment from a split row outside the table. We
                // pre-paginate normal legal tables into fresh, fixed-layout
                // table blocks instead. Very large individual rows remain
                // splittable so an exceptional exhibit cannot be clipped.
                const rowGroups: string[][][] = [];
                let currentGroup: string[][] = [];
                let currentLines = 0;
                for (const normalized of rows) {
                    const rowLines = estimatedRowLines(normalized);
                    if (
                        currentGroup.length > 0 &&
                        currentLines + rowLines > tableBodyLineBudget
                    ) {
                        rowGroups.push(currentGroup);
                        currentGroup = [];
                        currentLines = 0;
                    }
                    currentGroup.push(normalized);
                    currentLines += rowLines;
                    if (rowLines > tableBodyLineBudget) {
                        rowGroups.push(currentGroup);
                        currentGroup = [];
                        currentLines = 0;
                    }
                }
                if (currentGroup.length > 0) rowGroups.push(currentGroup);
                if (rowGroups.length === 0) rowGroups.push([]);

                const buildCell = (
                    value: string,
                    columnIndex: number,
                    header = false,
                ) =>
                    new TableCell({
                        width: {
                            size: columnWidths[columnIndex],
                            type: WidthType.DXA,
                        },
                        borders: cellBorder,
                        ...(header ? { shading: { fill: "F2F2F2" } } : {}),
                        children: [
                            new Paragraph({
                                wordWrap: true,
                                children: inlineRuns(value, header),
                                alignment: AlignmentType.LEFT,
                            }),
                        ],
                    });
                for (const [groupIndex, group] of rowGroups.entries()) {
                    if (groupIndex > 0) {
                        children.push(
                            new Paragraph({ children: [new PageBreak()] }),
                            // Keep LibreOffice from anchoring the following table above
                            // the page's top text boundary.
                            new Paragraph({ text: "" }),
                        );
                    }
                    const tableRows: InstanceType<typeof TableRow>[] = [
                        new TableRow({
                            cantSplit: true,
                            children: headers.map((header, columnIndex) =>
                                buildCell(header, columnIndex, true),
                            ),
                        }),
                    ];
                    // Rows were already normalized to exactly the header
                    // count, protecting the grid from malformed model output.
                    for (const normalized of group) {
                        const keepTogether = rowCanFitOnOnePage(normalized);
                        tableRows.push(
                            new TableRow({
                                ...(keepTogether ? { cantSplit: true } : {}),
                                children: normalized.map((cell, columnIndex) =>
                                    buildCell(cell, columnIndex),
                                ),
                            }),
                        );
                    }
                    children.push(
                        new Table({
                            width: {
                                size: usableWidth,
                                type: WidthType.DXA,
                            },
                            columnWidths,
                            layout: TableLayoutType.FIXED,
                            rows: tableRows,
                        }),
                    );
                }
                children.push(new Paragraph({ text: "" }));
            }
            if (section.content) {
                for (const line of section.content.split("\n")) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
                        continue;
                    }
                    const markdownHeading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
                    if (markdownHeading) {
                        const headingIndex = Math.max(
                            1,
                            Math.min(markdownHeading[1].length - 1, 3),
                        );
                        children.push(
                            new Paragraph({
                                heading: headingLevels[headingIndex],
                                spacing: {
                                    after: HEADING_AFTER,
                                    line: LINE_SPACING,
                                },
                                wordWrap: true,
                                children: inlineRuns(markdownHeading[2], true),
                            }),
                        );
                        continue;
                    }
                    const parsed = parseLiteralMarker(trimmed);
                    const leadingWhitespace = line.match(/^\s*/)?.[0] ?? "";
                    const nesting = Math.min(
                        4,
                        (leadingWhitespace.match(/\t/g)?.length ?? 0) +
                            Math.floor(
                                leadingWhitespace.replace(/\t/g, "").length / 2,
                            ),
                    );
                    children.push(
                        new Paragraph({
                            spacing: {
                                after: BODY_AFTER,
                                line: LINE_SPACING,
                            },
                            indent: parsed.marker
                                ? {
                                      left: 720 + nesting * 360,
                                      hanging: 360,
                                  }
                                : undefined,
                            wordWrap: true,
                            children: parsed.marker
                                ? [
                                      new TextRun({
                                          text: `${parsed.marker} `,
                                          font: FONT,
                                          size: SIZE,
                                      }),
                                      ...inlineRuns(parsed.text),
                                  ]
                                : inlineRuns(trimmed),
                        }),
                    );
                }
            }
        }

        const pageSetup = {
            page: {
                margin: {
                    top: MARGIN,
                    right: MARGIN,
                    bottom: MARGIN,
                    left: MARGIN,
                },
                ...(options.landscape
                    ? { size: { orientation: PageOrientation.LANDSCAPE } }
                    : {}),
            },
        };

        const doc = new Document({
            sections: [{ properties: pageSetup, children }],
        });
        const buf = await Packer.toBuffer(doc);
        const zip = await import("jszip");
        const packageZip = await zip.default.loadAsync(buf);
        for (const requiredPath of [
            "[Content_Types].xml",
            "word/document.xml",
            "word/_rels/document.xml.rels",
        ]) {
            if (!packageZip.file(requiredPath)) {
                return {
                    error: `Generated DOCX is missing required package part: ${requiredPath}`,
                };
            }
        }
        return { buffer: buf };
    } catch (e) {
        return { error: String(e) };
    }
}

/**
 * A Buffer is a *view* onto an ArrayBuffer, and for small allocations Node
 * hands out slices of a shared 8 KB pool — so `buf.buffer` is not the
 * document, it is the document plus whatever else happens to live in that
 * pool. Copy out exactly the view's own bytes.
 *
 * Deliberately a local copy: the same three lines already exist in
 * documentCleanCopies.ts, email/ingest.ts, routes/documents.ts and
 * routes/signatures.ts, and consolidating all five is a separate change.
 */
function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
}

/**
 * Persist a rendered .docx buffer as a first-class `documents` +
 * `document_versions` row. This is the persistence half extracted from the
 * original `generateDocx`: same filename/key derivation, same upload, same
 * lineage-metadata structure (derivation_kind defaults to "generated_docx").
 * The only parameterized behavior is `source`, which defaults to "generated"
 * to preserve the original single-pass path while allowing the later
 * template-anchored assembly path to pass "authored".
 */
export interface PersistAuthoredDocxParams {
    db: ReturnType<typeof createServerSupabase>;
    userId: string;
    buffer: Buffer;
    title: string;
    projectId?: string | null;
    source?: "generated" | "authored";
    /**
     * Stable UUID for crash-safe callers. Reusing it overwrites the same
     * object and reuses the same document/version instead of duplicating.
     */
    idempotencyKey?: string | null;
    lineage?: {
        sourceDocumentId?: string | null;
        sourceVersionId?: string | null;
        derivationKind?: string | null;
        operationId?: string | null;
    } | null;
    /** A report already produced by the worker's retry/fallback pipeline. */
    layoutQaReport?: DocumentLayoutQaReport;
    /** Durable callers recheck their lease before each publication write. */
    beforePublish?: () => Promise<void>;
}

export interface PersistedAuthoredDocx {
    filename: string;
    download_url: string;
    document_id: string;
    version_id: string;
    version_number: number;
    storage_path: string;
    message: string;
}

/**
 * Typed persistence API for durable workers. Unlike the legacy wrapper below,
 * this function throws and therefore preserves DocumentLayoutQaError details.
 */
export async function persistAuthoredDocxOrThrow(
    params: PersistAuthoredDocxParams,
): Promise<PersistedAuthoredDocx> {
    const { db, userId, buffer: buf, title } = params;
    const qaReport =
        params.layoutQaReport ??
        (await verifyDerivedArtifact({
            bytes: buf,
            fileType: "docx",
            trackedViews: false,
        }));
    if (!qaReport || qaReport.status !== "passed") {
        throw new Error(
            "Document layout verification returned no passing result.",
        );
    }
    const docId =
        params.idempotencyKey ?? crypto.randomUUID().replace(/-/g, "");
    const safeTitle =
        title
            .replace(/[^a-zA-Z0-9 -]/g, "")
            .trim()
            .slice(0, 64) || "document";
    const filename = `${safeTitle}.docx`;
    const key = generatedDocKey(userId, docId, filename);

    await params.beforePublish?.();
    await uploadFile(
        key,
        bufferToArrayBuffer(buf),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const downloadUrl = buildDownloadUrl(key, filename);

    // Persist to DB so generated docs are first-class documents:
    // openable in the DocPanel and editable via edit_document. In
    // project chats we attach to the project so it appears in the
    // sidebar; in the general chat we leave project_id null and it
    // stays a standalone document.
    const documentValues = {
        ...(params.idempotencyKey ? { id: params.idempotencyKey } : {}),
        project_id: params.projectId ?? null,
        user_id: userId,
        filename,
        file_type: "docx",
        size_bytes: buf.byteLength,
        status: "ready",
    };
    await params.beforePublish?.();
    const documentWrite = params.idempotencyKey
        ? db.from("documents").upsert(documentValues, { onConflict: "id" })
        : db.from("documents").insert(documentValues);
    const { data: docRow, error: docErr } = await documentWrite
        .select("id")
        .single();
    if (docErr || !docRow) {
        throw new Error(
            `Failed to record generated document: ${docErr?.message ?? "unknown"}`,
            { cause: docErr ?? undefined },
        );
    }
    const documentId = docRow.id as string;

    let versionId: string;
    if (params.idempotencyKey) {
        const { data: existingVersion, error: existingVersionError } = await db
            .from("document_versions")
            .select("id")
            .eq("document_id", documentId)
            .eq("version_number", 1)
            .maybeSingle();
        if (existingVersionError)
            throw new Error(
                `Could not load saved document version: ${existingVersionError.message}`,
            );
        if (existingVersion?.id) {
            versionId = String(existingVersion.id);
            await params.beforePublish?.();
            const { error: qaUpdateError } = await db
                .from("document_versions")
                .update(layoutQaVersionValues(qaReport))
                .eq("id", versionId);
            if (qaUpdateError) {
                throw new Error(
                    `Document QA state could not be persisted. ${describeSupabaseError(qaUpdateError)}`,
                    { cause: qaUpdateError },
                );
            }
            await params.beforePublish?.();
            const { error: activateError } = await db
                .from("documents")
                .update({ current_version_id: versionId })
                .eq("id", documentId);
            if (activateError) {
                throw new Error(
                    `Verified document could not be activated. ${describeSupabaseError(activateError)}`,
                    { cause: activateError },
                );
            }
            return {
                filename,
                download_url: downloadUrl,
                document_id: documentId,
                version_id: versionId,
                version_number: 1,
                storage_path: key,
                message: `Document '${filename}' has been generated successfully.`,
            };
        }
    }
    await params.beforePublish?.();
    try {
        const versionRow = await insertDocumentVersionCompat({
            db,
            errorMessage: "Failed to record generated document version.",
            fallbackSource: "generated",
            values: {
                document_id: documentId,
                storage_path: key,
                source: params.source ?? "generated",
                version_number: 1,
                display_name: filename,
                created_by_user_id: userId,
                metadata: {
                    ...(params.lineage?.sourceDocumentId
                        ? {
                              source_document_id:
                                  params.lineage.sourceDocumentId,
                          }
                        : {}),
                    ...(params.lineage?.sourceVersionId
                        ? {
                              source_version_id: params.lineage.sourceVersionId,
                          }
                        : {}),
                    derivation_kind:
                        params.lineage?.derivationKind ?? "generated_docx",
                    ...(params.lineage?.operationId
                        ? { operation_id: params.lineage.operationId }
                        : {}),
                    layout_qa: {
                        status: "passed",
                        schema_version: qaReport.schema_version,
                        checked_at: qaReport.checked_at,
                    },
                },
                ...layoutQaVersionValues(qaReport),
            },
        });
        versionId = versionRow.id;
    } catch (err) {
        if (params.idempotencyKey) {
            await params.beforePublish?.();
            const { data: racedVersion, error: racedVersionError } = await db
                .from("document_versions")
                .select("id")
                .eq("document_id", documentId)
                .eq("version_number", 1)
                .maybeSingle();
            if (racedVersionError)
                throw new Error(
                    `Could not load concurrent document save: ${racedVersionError.message}`,
                );
            if (racedVersion?.id) {
                versionId = String(racedVersion.id);
                await params.beforePublish?.();
                const { error: qaUpdateError } = await db
                    .from("document_versions")
                    .update(layoutQaVersionValues(qaReport))
                    .eq("id", versionId);
                if (qaUpdateError) {
                    throw new Error(
                        `Document QA state could not be persisted. ${describeSupabaseError(qaUpdateError)}`,
                        { cause: qaUpdateError },
                    );
                }
                await params.beforePublish?.();
                const { error: activateError } = await db
                    .from("documents")
                    .update({ current_version_id: versionId })
                    .eq("id", documentId);
                if (activateError) {
                    throw new Error(
                        `Verified document could not be activated. ${describeSupabaseError(activateError)}`,
                        { cause: activateError },
                    );
                }
                return {
                    filename,
                    download_url: downloadUrl,
                    document_id: documentId,
                    version_id: versionId,
                    version_number: 1,
                    storage_path: key,
                    message: `Document '${filename}' has been generated successfully.`,
                };
            }
        }
        throw err instanceof Error
            ? err
            : new Error(
                  `Failed to record generated document version: ${describeSupabaseError(err)}`,
                  { cause: err },
              );
    }

    await params.beforePublish?.();
    const { error: activateError } = await db
        .from("documents")
        .update({ current_version_id: versionId })
        .eq("id", documentId);
    if (activateError) {
        throw new Error(
            `Verified document could not be activated. ${describeSupabaseError(activateError)}`,
            { cause: activateError },
        );
    }

    return {
        filename,
        download_url: downloadUrl,
        document_id: documentId,
        version_id: versionId,
        version_number: 1,
        storage_path: key,
        message: `Document '${filename}' has been generated successfully.`,
    };
}

/**
 * Backward-compatible tool API. Chat/tool callers historically consume an
 * `{ error }` union, while durable workers use persistAuthoredDocxOrThrow so
 * typed QA failures and reports are not flattened into strings.
 */
export async function persistAuthoredDocx(
    params: PersistAuthoredDocxParams,
): Promise<PersistedAuthoredDocx | { error: string }> {
    try {
        return await persistAuthoredDocxOrThrow(params);
    } catch (error) {
        return { error: String(error) };
    }
}
