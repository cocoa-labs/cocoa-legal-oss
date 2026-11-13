// backend/src/lib/signatures/anchors.ts
//
// Resolve WHERE each signer's signature should be stamped on a PDF, so it lands
// on the real signature line instead of a block at the bottom. Three sources,
// in priority order:
//
//   1. Tokens   — Coco Legal-generated contracts embed `{{coco-sign:N}}` on each
//                 party's signature line (N = 0-based party order). Most
//                 reliable; we also white out the marker so it never shows.
//   2. Anchors  — any doc: we first narrow to the document's SIGNATURE REGION
//                 (after an "IN WITNESS WHEREOF"-style cue, else the tail of the
//                 doc), then keep only lines that genuinely read like a signature
//                 line (a label like "By:"/"Name:", a label+underscore fill, a
//                 bare underscore run, or "/s/") — NEVER body prose that merely
//                 contains the word "by"/"date". Signers map to those lines by
//                 best-effort party-name match, else by order_index.
//   3. Fallback — signers with no resolved spot get no placement; the stamper
//                 then auto-stacks them at the bottom (its existing behavior).
//
// Coordinates come from pdfjs-dist (already a dep; same bottom-left origin as
// pdf-lib), so placements pass straight through as page + xPct/yPct fractions.

import type { SignatureSigner } from "./types";
import type { StampPlacement } from "./pdf";

export interface CoverRect {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export type PlacementMode = "token" | "anchor" | "fallback" | "mixed";

export interface ResolvedPlacements {
    /** signerId → where to stamp. Missing signers fall back to bottom-stack. */
    placements: Map<string, StampPlacement>;
    /** Token rects to white out so `{{coco-sign:N}}` markers never show. */
    coverRects: CoverRect[];
    mode: PlacementMode;
}

interface TextItem {
    page: number;
    str: string;
    x: number;
    y: number;
    width: number;
    height: number;
    pageWidth: number;
    pageHeight: number;
}

interface Line {
    page: number;
    y: number;
    pageWidth: number;
    pageHeight: number;
    items: TextItem[];
    text: string; // items joined (left→right)
    minX: number;
}

const TOKEN_RE = /\{\{coco-sign:(\d+)\}\}/i;

// Phrases that mark the start of a signature section. Region detection narrows
// the anchor search to at/after the earliest of these (in reading order).
const CUE_RE =
    /\b(in\s+witness\s+whereof|the\s+parties\s+(?:hereto\s+)?have\s+(?:caused|executed|duly\s+executed)|accepted\s+and\s+agreed|agreed\s+and\s+accepted|the\s+undersigned|intending\s+to\s+be\s+legally\s+bound|signature\s+page\s+follows)\b/i;

// A run that reads like a fill blank: 4+ underscores OR 6+ dot leaders.
const FILL_RUN_RE = /_{4,}|\.{6,}/;
// A genuine SIGNATURE-line label at the START of a line. Deliberately limited to
// signature markers — NOT metadata fields (name / print name / title / its /
// date), which are not where a signature goes. Including "date" in particular
// made every party block expose two anchors (By: + Date:), so on a multi-party
// doc the positional assignment filled the first block twice and left the second
// empty. Bare underscore runs ("fill") and "/s/" ("sslash") still qualify.
const LABEL_RE = /^(by|signature|signed)\b\s*:?/i;
// A label-ONLY line: the label, then only blanks / underscores / separators.
const LABEL_ONLY_RE = /^(by|signature|signed)\s*:?[\s_./-]*$/i;
// Metadata fields that are NOT signature lines, even when they carry a long
// underscore fill (e.g. "Date: ______", "Name: ______"). These must be rejected
// up front — otherwise the bare-fill rule would still anchor on them, giving each
// party block two anchors and letting the first block soak up both signers.
const METADATA_LABEL_RE = /^(date|print(?:ed)?\s+name|name|title|its)\b/i;
// Electronic-signature convention, e.g. "/s/ Jane Roe".
const SSLASH_RE = /^\/s\/\s*\S/i;
// A line qualifies as a bare fill when at least this fraction of its non-space
// characters are fill characters (underscores / dot leaders).
const MOSTLY_FILL_RATIO = 0.6;

type AnchorKind = "fill" | "label" | "label_fill" | "sslash";

interface QualifiedBlock {
    line: Line;
    kind: AnchorKind;
    /** Resolved x for the mark (page units), before normalization. */
    x: number;
    /** Vertical nudge above the baseline. */
    yOffset: number;
    /** This line + its neighbors, lowercased — used for party-name matching. */
    contextText: string;
}

async function extractItems(pdf: Buffer): Promise<TextItem[]> {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const doc = await (
        pdfjsLib as unknown as {
            getDocument: (o: unknown) => {
                promise: Promise<{
                    numPages: number;
                    getPage: (n: number) => Promise<{
                        getViewport: (o: { scale: number }) => {
                            width: number;
                            height: number;
                        };
                        getTextContent: () => Promise<{
                            items: {
                                str?: string;
                                transform?: number[];
                                width?: number;
                                height?: number;
                            }[];
                        }>;
                    }>;
                }>;
            };
        }
    ).getDocument({ data: new Uint8Array(pdf) }).promise;

    const items: TextItem[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        for (const it of tc.items) {
            if (typeof it.str !== "string" || it.str.length === 0) continue;
            const t = it.transform ?? [1, 0, 0, 1, 0, 0];
            items.push({
                page: p - 1,
                str: it.str,
                x: typeof t[4] === "number" ? t[4] : 0,
                y: typeof t[5] === "number" ? t[5] : 0,
                width: it.width ?? 0,
                height: it.height ?? 10,
                pageWidth: vp.width,
                pageHeight: vp.height,
            });
        }
    }
    return items;
}

/** Group items into visual lines (same page, baseline within ~2.5pt). */
function groupLines(items: TextItem[]): Line[] {
    const buckets = new Map<string, TextItem[]>();
    for (const it of items) {
        const key = `${it.page}:${Math.round(it.y / 2.5)}`;
        const arr = buckets.get(key);
        if (arr) arr.push(it);
        else buckets.set(key, [it]);
    }
    const lines: Line[] = [];
    for (const arr of buckets.values()) {
        arr.sort((a, b) => a.x - b.x);
        const first = arr[0];
        lines.push({
            page: first.page,
            y: first.y,
            pageWidth: first.pageWidth,
            pageHeight: first.pageHeight,
            items: arr,
            text: arr.map((i) => i.str).join(""),
            minX: Math.min(...arr.map((i) => i.x)),
        });
    }
    return lines;
}

function lineCoverRect(line: Line): CoverRect {
    const minX = Math.min(...line.items.map((i) => i.x));
    const maxX = Math.max(...line.items.map((i) => i.x + i.width));
    const maxH = Math.max(...line.items.map((i) => i.height || 10));
    return {
        page: line.page,
        x: minX - 1,
        y: line.y - 3,
        width: maxX - minX + 2,
        height: maxH + 5,
    };
}

function placementAt(
    line: Line,
    x: number,
    yOffset: number,
): StampPlacement {
    return {
        page: line.page,
        xPct: Math.min(Math.max(x / line.pageWidth, 0), 1),
        yPct: Math.min(Math.max((line.y + yOffset) / line.pageHeight, 0), 1),
    };
}

/** Reading order: page-ascending, then top-of-page first (Y is bottom-up). */
function readingOrder(a: Line, b: Line): number {
    return a.page - b.page || b.y - a.y;
}

/**
 * Narrow the candidate lines to the document's signature region so body prose
 * (which may contain "by"/"date") can never be chosen as an anchor.
 */
function signatureRegionLines(lines: Line[]): Line[] {
    if (lines.length === 0) return lines;
    const numPages = Math.max(...lines.map((l) => l.page)) + 1;

    // Find the LAST cue phrase in reading order — the real signature-section
    // header (e.g. "AGREED AND ACCEPTED"), not an earlier body mention of
    // "the undersigned"/"intending to be legally bound".
    const byReading = lines.slice().sort(readingOrder);
    let cue: Line | null = null;
    for (const l of byReading) {
        const norm = l.text.replace(/\s+/g, " ").trim();
        if (CUE_RE.test(norm)) cue = l; // keep updating → ends on the last match
    }

    let region: Line[];
    if (cue) {
        // The whole cue PAGE onward. Using the page (not "below the cue line")
        // keeps a party's signature block that sits ABOVE the cue on the same
        // page — e.g. the first party's "By:" block above an "AGREED AND
        // ACCEPTED" header on an LOI, which would otherwise be dropped.
        const cuePage = cue.page;
        region = lines.filter((l) => l.page >= cuePage);
    } else if (numPages >= 2) {
        // Blocks often straddle a page break / sit on a dedicated signature
        // page — keep the last two pages.
        region = lines.filter((l) => l.page >= numPages - 2);
    } else {
        // Single page: keep the bottom 40% (the top preamble carries the
        // misleading "by"/"date" prose).
        region = lines.filter((l) => l.y <= 0.4 * l.pageHeight);
    }
    // The qualifier is an independent second defense, so degrade safely.
    return region.length > 0 ? region : lines;
}

/** Left-most item whose own text starts with a signature-block label. */
function findLabelItem(line: Line): TextItem | undefined {
    return line.items
        .slice()
        .sort((a, b) => a.x - b.x)
        .find((it) => LABEL_RE.test(it.str.trim()));
}

/**
 * x where the underscore/dot fill RUN begins — i.e. where a signature should
 * start. When pdfjs keeps the fill in its own item (e.g. "By:" and "____" as
 * separate items), that item's x is exact. When pdfjs MERGES the label and the
 * fill into one item ("By: ____"), the item's x is the label's left edge, so we
 * estimate the fill start from the first fill char's offset within the item
 * (errs slightly rightward, keeping the mark clear of the "By:" label rather
 * than drawn over it).
 */
function firstFillItemX(line: Line): number | null {
    const it = line.items.find(
        (i) => i.str.includes("_") || /\.{4,}/.test(i.str),
    );
    if (!it) return null;
    const m = it.str.match(/_|\.{4,}/);
    const idx = m?.index ?? 0;
    if (idx <= 0 || it.str.length === 0) return it.x;
    return it.x + (it.width * idx) / it.str.length;
}

function mk(
    line: Line,
    kind: AnchorKind,
    x: number,
    yOffset: number,
): QualifiedBlock {
    return { line, kind, x, yOffset, contextText: "" };
}

/**
 * Decide whether a line is a genuine signature line, and where on it the mark
 * should sit. Returns null for body prose.
 */
function qualifyAnchorLine(line: Line): QualifiedBlock | null {
    const raw = line.text;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // A metadata field (Name/Title/Date/Its) is never a signature line — reject
    // it before the bare-fill rule can anchor on its underscore fill.
    if (METADATA_LABEL_RE.test(trimmed)) return null;
    const compact = raw.replace(/\s+/g, "");
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const labelItem = findLabelItem(line);
    const startsWithLabel = LABEL_RE.test(trimmed);

    // 1) "/s/ Name" electronic signature notation.
    if (SSLASH_RE.test(trimmed)) return mk(line, "sslash", line.minX, 2);

    // 2) Label + fill on one baseline: "By: ____", "Signature: ____".
    if (startsWithLabel && FILL_RUN_RE.test(raw)) {
        const x =
            (firstFillItemX(line) ??
                (labelItem
                    ? labelItem.x + labelItem.width + 8
                    : line.minX)) + 2;
        // yOffset 0: the shared drawSignerBlock lift (+6) already sits the mark
        // just above the underscores. A larger offset floated it a line too high.
        return mk(line, "label_fill", x, 0);
    }

    // 3) Bare fill run (mostly underscores / dot leaders).
    const fillChars = (compact.match(/[_.]/g) ?? []).length;
    if (
        compact.length >= 4 &&
        fillChars / compact.length >= MOSTLY_FILL_RATIO
    ) {
        const x = (firstFillItemX(line) ?? line.minX) + 2;
        return mk(line, "fill", x, 0);
    }

    // 4) Short label-only line: "By:", "Name:", "Title:", "Date:". (The fill
    // rule may be a graphic, absent from the text layer.)
    if (startsWithLabel && LABEL_ONLY_RE.test(trimmed) && wordCount <= 4 && labelItem)
        return mk(line, "label", labelItem.x + labelItem.width + 10, 2);

    return null;
}

/**
 * A single grouped line can hold two parties' blocks side by side (e.g.
 * "By: ____    By: ____"). Split into one block per cluster when there are ≥2
 * anchor positions separated by a wide horizontal gap.
 */
function splitSideBySide(block: QualifiedBlock): QualifiedBlock[] {
    const line = block.line;
    const gap = 0.25 * line.pageWidth;
    const anchorXs: number[] = [];
    for (const it of line.items) {
        if (LABEL_RE.test(it.str.trim())) anchorXs.push(it.x);
        else if (it.str.includes("_")) anchorXs.push(it.x);
    }
    if (anchorXs.length < 2) return [block];
    anchorXs.sort((a, b) => a - b);
    const clusters: number[][] = [[anchorXs[0]]];
    for (let i = 1; i < anchorXs.length; i++) {
        if (anchorXs[i] - anchorXs[i - 1] > gap) clusters.push([anchorXs[i]]);
        else clusters[clusters.length - 1].push(anchorXs[i]);
    }
    if (clusters.length < 2) return [block];
    return clusters.map((c) => ({ ...block, x: Math.min(...c) + 2 }));
}

/** Last whitespace token with ≥3 letters; null for emails / unnamed signers. */
function surnameToken(name: string): string | null {
    if (!name || name.includes("@")) return null;
    const tokens = name.trim().split(/\s+/).filter((t) => t.length > 0);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const s = tokens[i].toLowerCase().replace(/[^a-z]/g, "");
        if (s.length >= 3) return s;
    }
    return null;
}

/**
 * Assign signers to qualified blocks: best-effort party-name match first, then
 * positional by order_index. Never assigns two signers to the same block;
 * surplus signers are left unplaced (→ bottom-stack fallback).
 */
function assignSignersToBlocks(
    blocks: QualifiedBlock[],
    unplaced: SignatureSigner[],
): Map<string, QualifiedBlock> {
    const result = new Map<string, QualifiedBlock>();
    const claimed = new Set<number>();

    // Pass 1: unique party-name match.
    for (const signer of unplaced) {
        const surname = surnameToken(signer.name ?? "");
        if (!surname) continue;
        const re = new RegExp(`\\b${surname}\\b`);
        const hits: number[] = [];
        for (let bi = 0; bi < blocks.length; bi++) {
            if (claimed.has(bi)) continue;
            if (re.test(blocks[bi].contextText)) hits.push(bi);
        }
        if (hits.length === 1) {
            claimed.add(hits[0]);
            result.set(signer.id, blocks[hits[0]]);
        }
    }

    // Pass 2: positional fill, in order, skipping claimed blocks.
    let bi = 0;
    for (const signer of unplaced) {
        if (result.has(signer.id)) continue;
        while (bi < blocks.length && claimed.has(bi)) bi++;
        if (bi >= blocks.length) break;
        claimed.add(bi);
        result.set(signer.id, blocks[bi]);
        bi++;
    }
    return result;
}

/**
 * From a `{{coco-sign}}` token line, find the real signature line just below
 * it. The token is emitted on its own line *above* the party's "By:" line
 * (often with the party name in between), so the mark belongs on the nearest
 * qualifying signature line beneath the token, not on the token line itself.
 * Bounded scan, closest-first; skips lines already claimed by another token.
 */
function findSignatureLineBelow(
    lines: Line[],
    tokenLine: Line,
    usedKeys: Set<string>,
): QualifiedBlock | null {
    const below = lines
        .filter((l) => l.page === tokenLine.page && l.y < tokenLine.y)
        .sort((a, b) => b.y - a.y) // closest below the token first (Y is bottom-up)
        .slice(0, 6);
    for (const cand of below) {
        const key = `${cand.page}:${Math.round(cand.y)}`;
        if (usedKeys.has(key)) continue;
        const q = qualifyAnchorLine(cand);
        if (q) {
            usedKeys.add(key);
            return q;
        }
    }
    return null;
}

/**
 * Resolve per-signer stamp placements. Pure read of the PDF text layer; never
 * throws (a parse failure degrades to an empty map → bottom-stack fallback).
 */
export async function resolveSignerPlacements(
    pdf: Buffer,
    signers: SignatureSigner[],
): Promise<ResolvedPlacements> {
    const placements = new Map<string, StampPlacement>();
    const coverRects: CoverRect[] = [];
    const ordered = signers
        .filter((s) => s.role === "signer")
        .slice()
        .sort((a, b) => a.order_index - b.order_index);
    if (ordered.length === 0)
        return { placements, coverRects, mode: "fallback" };

    let items: TextItem[];
    try {
        items = await extractItems(pdf);
    } catch {
        return { placements, coverRects, mode: "fallback" };
    }
    const lines = groupLines(items);

    // 1) Tokens — match against whitespace-stripped line text so a token split
    // across pdfjs items (e.g. "{{coco" + "-sign:0}}") still resolves. The
    // token marks WHICH party + roughly WHERE; the signature is snapped onto the
    // real "By:"/underscore line just below the token (the token sits on its own
    // line above it), falling back to the token line when none is found.
    const usedSnapKeys = new Set<string>();
    let usedToken = false;
    for (const line of lines) {
        const m = line.text.replace(/\s+/g, "").match(TOKEN_RE);
        if (!m) continue;
        coverRects.push(lineCoverRect(line)); // hide the marker regardless
        const n = Number(m[1]);
        const signer =
            ordered.find((s) => s.order_index === n) ?? ordered[n];
        if (signer && !placements.has(signer.id)) {
            const target = findSignatureLineBelow(lines, line, usedSnapKeys);
            placements.set(
                signer.id,
                target
                    ? placementAt(target.line, target.x, target.yOffset)
                    : placementAt(line, line.minX, 2),
            );
            usedToken = true;
        }
    }

    // 2) Text anchors — for any signer still unplaced, look only inside the
    // signature region and only at lines that genuinely read like a signature
    // line, then assign by party-name match / order_index.
    const unplaced = ordered.filter((s) => !placements.has(s.id));
    let usedAnchor = false;
    if (unplaced.length > 0) {
        const regionSorted = signatureRegionLines(lines)
            .slice()
            .sort(readingOrder);
        const blocks: QualifiedBlock[] = [];
        for (let i = 0; i < regionSorted.length; i++) {
            const q = qualifyAnchorLine(regionSorted[i]);
            if (!q) continue;
            // Context = this line + its neighbors (party names sit directly
            // above or below the signature line).
            const contextText = [
                regionSorted[i - 1]?.text ?? "",
                regionSorted[i].text,
                regionSorted[i + 1]?.text ?? "",
            ]
                .join(" ")
                .toLowerCase();
            for (const part of splitSideBySide(q))
                blocks.push({ ...part, contextText });
        }
        const assigned = assignSignersToBlocks(blocks, unplaced);
        for (const [signerId, block] of assigned) {
            placements.set(
                signerId,
                placementAt(block.line, block.x, block.yOffset),
            );
            usedAnchor = true;
        }
    }

    const mode: PlacementMode =
        usedToken && usedAnchor
            ? "mixed"
            : usedToken
              ? "token"
              : usedAnchor
                ? "anchor"
                : "fallback";
    return { placements, coverRects, mode };
}
