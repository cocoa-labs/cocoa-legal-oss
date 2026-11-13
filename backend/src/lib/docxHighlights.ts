import JSZip from "jszip";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

type XNode = Record<string, unknown>;

const ATTR_KEY = ":@";
const TEXT_KEY = "#text";
const STABLE_ZIP_ENTRY_DATE = new Date("2000-01-01T00:00:00.000Z");

export type DocxHighlightInput = {
    quote: string;
    occurrence_index: number;
};

export type AppliedDocxHighlight = {
    quote: string;
    occurrence_index: number;
};

export type ApplyDocxHighlightsResult = {
    bytes: Buffer;
    applied: AppliedDocxHighlight[];
    errors: { quote: string; occurrence_index: number; reason: string }[];
};

export type RemoveDocxHighlightsResult = {
    bytes: Buffer;
    removed: AppliedDocxHighlight[];
    removed_count: number;
    errors: { quote: string; occurrence_index: number; reason: string }[];
};

type TextSlot = {
    parentChildren: XNode[];
    childIndex: number;
    rPr: XNode | null;
    text: string;
    paraStart: number;
    paraEnd: number;
};

type ParagraphRef = {
    text: string;
    slots: TextSlot[];
};

function getZipEntry(zip: JSZip, pathSlash: string) {
    const direct = zip.file(pathSlash);
    if (direct) return direct;
    return zip.file(pathSlash.replace(/\//g, "\\"));
}

function setZipEntry(
    zip: JSZip,
    pathSlash: string,
    content: string | Buffer,
): void {
    const backslash = pathSlash.replace(/\//g, "\\");
    const direct = zip.file(pathSlash);
    const fallback = direct ? null : zip.file(backslash);
    const target = fallback ? backslash : pathSlash;
    zip.file(target, content, {
        date: (direct ?? fallback)?.date ?? STABLE_ZIP_ENTRY_DATE,
        createFolders: false,
    });
}

function elName(n: unknown): string | null {
    if (!n || typeof n !== "object") return null;
    for (const k of Object.keys(n as XNode)) {
        if (k === ATTR_KEY || k === TEXT_KEY) continue;
        return k;
    }
    return null;
}

function isTextNode(n: unknown): n is { [TEXT_KEY]: string } {
    if (!n || typeof n !== "object") return false;
    const obj = n as XNode;
    return TEXT_KEY in obj && elName(n) === null;
}

function elChildren(n: unknown): XNode[] {
    const name = elName(n);
    if (!name) return [];
    const v = (n as XNode)[name];
    return Array.isArray(v) ? (v as XNode[]) : [];
}

function elAttrs(n: unknown): Record<string, string> {
    if (!n || typeof n !== "object") return {};
    return ((n as XNode)[ATTR_KEY] as Record<string, string>) ?? {};
}

function makeEl(
    name: string,
    children: XNode[] = [],
    attrs?: Record<string, string>,
): XNode {
    const el: XNode = { [name]: children };
    if (attrs) {
        const attrObj: Record<string, string> = {};
        for (const [k, v] of Object.entries(attrs)) attrObj[`@_${k}`] = v;
        el[ATTR_KEY] = attrObj;
    }
    return el;
}

function makeText(s: string): XNode {
    return { [TEXT_KEY]: s };
}

function cloneNode<T>(n: T): T {
    return JSON.parse(JSON.stringify(n)) as T;
}

function getTextContent(wtEl: XNode): string {
    let out = "";
    for (const k of elChildren(wtEl)) {
        if (isTextNode(k)) out += String(k[TEXT_KEY] ?? "");
    }
    return out;
}

function findRPr(runEl: XNode): XNode | null {
    return elChildren(runEl).find((kid) => elName(kid) === "w:rPr") ?? null;
}

function highlightedRPr(source: XNode | null): XNode {
    const rPr = source ? cloneNode(source) : makeEl("w:rPr", []);
    const children = elChildren(rPr).filter((kid) => elName(kid) !== "w:highlight");
    children.push(makeEl("w:highlight", [], { "w:val": "yellow" }));
    const name = elName(rPr);
    if (name) rPr[name] = children;
    return rPr;
}

function unhighlightedRPr(source: XNode | null): XNode | null {
    if (!source) return null;
    const rPr = cloneNode(source);
    const name = elName(rPr);
    if (!name) return null;
    rPr[name] = elChildren(rPr).filter((kid) => elName(kid) !== "w:highlight");
    return rPr;
}

function buildRun(rPr: XNode | null, text: string, highlighted: boolean): XNode {
    const children: XNode[] = [];
    if (highlighted) {
        children.push(highlightedRPr(rPr));
    } else if (rPr) {
        children.push(cloneNode(rPr));
    }
    if (text) {
        children.push(makeEl("w:t", [makeText(text)], { "xml:space": "preserve" }));
    }
    return makeEl("w:r", children);
}

function buildUnhighlightedRun(rPr: XNode | null, text: string): XNode {
    const children: XNode[] = [];
    const cleanRPr = unhighlightedRPr(rPr);
    if (cleanRPr) children.push(cleanRPr);
    if (text) {
        children.push(makeEl("w:t", [makeText(text)], { "xml:space": "preserve" }));
    }
    return makeEl("w:r", children);
}

function normalizeWithMap(input: string): { norm: string; origIdx: number[] } {
    const norm: string[] = [];
    const origIdx: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i]
            .replace(/[\u2018\u2019\u2032]/g, "'")
            .replace(/[\u201C\u201D\u2033]/g, '"')
            .replace(/[\u2013\u2014]/g, "-")
            .replace(/\u00A0/g, " ")
            .replace(/\u200B/g, " ");
        if (/\s/.test(ch)) {
            if (!prevSpace) {
                norm.push(" ");
                origIdx.push(i);
                prevSpace = true;
            }
        } else {
            norm.push(ch.toLowerCase());
            origIdx.push(i);
            prevSpace = false;
        }
    }
    return { norm: norm.join(""), origIdx };
}

function normalizedNeedle(value: string): string {
    return normalizeWithMap(value.trim()).norm.replace(/\s+/g, " ");
}

function collectParagraphs(tree: XNode[]): ParagraphRef[] {
    const paragraphs: ParagraphRef[] = [];

    const processParagraph = (node: XNode) => {
        const slots: TextSlot[] = [];
        let text = "";

        const processRunArray = (children: XNode[]) => {
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                const name = elName(child);
                if (name === "w:r") {
                    const rPr = findRPr(child);
                    const textEls = elChildren(child).filter(
                        (kid) => elName(kid) === "w:t",
                    );
                    for (const wt of textEls) {
                        const segment = getTextContent(wt);
                        if (!segment) continue;
                        const start = text.length;
                        slots.push({
                            parentChildren: children,
                            childIndex: i,
                            rPr,
                            text: segment,
                            paraStart: start,
                            paraEnd: start + segment.length,
                        });
                        text += segment;
                    }
                } else if (name && name !== "w:del") {
                    processRunArray(elChildren(child));
                }
            }
        };

        processRunArray(elChildren(node));
        if (slots.length) paragraphs.push({ text, slots });
    };

    const visit = (node: XNode) => {
        if (elName(node) === "w:p") {
            processParagraph(node);
            return;
        }
        for (const child of elChildren(node)) visit(child);
    };

    for (const top of tree) {
        if (elName(top) === "w:document") visit(top);
    }
    return paragraphs;
}

function replaceSlotWithHighlight(
    slot: TextSlot,
    ranges: { start: number; end: number }[],
): void {
    const cleanRanges = ranges
        .filter((r) => r.start < r.end)
        .sort((a, b) => a.start - b.start);
    if (!cleanRanges.length) return;

    const replacement: XNode[] = [];
    let cursor = 0;
    for (const range of cleanRanges) {
        if (cursor < range.start) {
            replacement.push(
                buildRun(slot.rPr, slot.text.slice(cursor, range.start), false),
            );
        }
        replacement.push(
            buildRun(slot.rPr, slot.text.slice(range.start, range.end), true),
        );
        cursor = range.end;
    }
    if (cursor < slot.text.length) {
        replacement.push(buildRun(slot.rPr, slot.text.slice(cursor), false));
    }
    slot.parentChildren.splice(slot.childIndex, 1, ...replacement);
}

function replaceSlotRemovingHighlight(
    slot: TextSlot,
    ranges: { start: number; end: number }[],
): void {
    const cleanRanges = ranges
        .filter((r) => r.start < r.end)
        .sort((a, b) => a.start - b.start);
    if (!cleanRanges.length) return;

    const replacement: XNode[] = [];
    let cursor = 0;
    for (const range of cleanRanges) {
        if (cursor < range.start) {
            replacement.push(
                buildRun(slot.rPr, slot.text.slice(cursor, range.start), false),
            );
        }
        replacement.push(
            buildUnhighlightedRun(slot.rPr, slot.text.slice(range.start, range.end)),
        );
        cursor = range.end;
    }
    if (cursor < slot.text.length) {
        replacement.push(buildRun(slot.rPr, slot.text.slice(cursor), false));
    }
    slot.parentChildren.splice(slot.childIndex, 1, ...replacement);
}

function applyRangesToParagraph(
    paragraph: ParagraphRef,
    ranges: { start: number; end: number }[],
): void {
    const bySlot = new Map<TextSlot, { start: number; end: number }[]>();
    for (const range of ranges) {
        for (const slot of paragraph.slots) {
            if (range.start >= slot.paraEnd || range.end <= slot.paraStart) continue;
            const localStart = Math.max(0, range.start - slot.paraStart);
            const localEnd = Math.min(slot.text.length, range.end - slot.paraStart);
            if (localStart < localEnd) {
                bySlot.set(slot, [
                    ...(bySlot.get(slot) ?? []),
                    { start: localStart, end: localEnd },
                ]);
            }
        }
    }

    const slots = [...bySlot.keys()].sort((a, b) => {
        if (a.parentChildren === b.parentChildren) return b.childIndex - a.childIndex;
        return 0;
    });
    for (const slot of slots) replaceSlotWithHighlight(slot, bySlot.get(slot) ?? []);
}

function removeRangesFromParagraph(
    paragraph: ParagraphRef,
    ranges: { start: number; end: number }[],
): void {
    const bySlot = new Map<TextSlot, { start: number; end: number }[]>();
    for (const range of ranges) {
        for (const slot of paragraph.slots) {
            if (range.start >= slot.paraEnd || range.end <= slot.paraStart) continue;
            const localStart = Math.max(0, range.start - slot.paraStart);
            const localEnd = Math.min(slot.text.length, range.end - slot.paraStart);
            if (localStart < localEnd) {
                bySlot.set(slot, [
                    ...(bySlot.get(slot) ?? []),
                    { start: localStart, end: localEnd },
                ]);
            }
        }
    }

    const slots = [...bySlot.keys()].sort((a, b) => {
        if (a.parentChildren === b.parentChildren) return b.childIndex - a.childIndex;
        return 0;
    });
    for (const slot of slots) {
        replaceSlotRemovingHighlight(slot, bySlot.get(slot) ?? []);
    }
}

function removeAllHighlightsFromTree(tree: XNode[]): number {
    let removed = 0;
    const visit = (node: XNode) => {
        const name = elName(node);
        if (!name) return;
        const children = elChildren(node);
        if (name === "w:rPr") {
            const next = children.filter((child) => {
                const isHighlight = elName(child) === "w:highlight";
                if (isHighlight) removed++;
                return !isHighlight;
            });
            node[name] = next;
        } else {
            for (const child of children) visit(child);
        }
    };
    for (const top of tree) visit(top);
    return removed;
}

function rangesForHighlights(
    paragraphs: ParagraphRef[],
    inputs: DocxHighlightInput[],
): {
    byParagraph: Map<ParagraphRef, { start: number; end: number }[]>;
    applied: AppliedDocxHighlight[];
    errors: { quote: string; occurrence_index: number; reason: string }[];
} {
    const requested = new Map<string, Set<number>>();
    for (const input of inputs) {
        const needle = normalizedNeedle(input.quote);
        if (!needle) continue;
        requested.set(needle, new Set([...(requested.get(needle) ?? []), input.occurrence_index]));
    }

    const seen = new Map<string, number>();
    const appliedKeys = new Set<string>();
    const byParagraph = new Map<ParagraphRef, { start: number; end: number }[]>();

    for (const paragraph of paragraphs) {
        const mapped = normalizeWithMap(paragraph.text);
        for (const [needle, indices] of requested.entries()) {
            let from = 0;
            while (from <= mapped.norm.length - needle.length) {
                const pos = mapped.norm.indexOf(needle, from);
                if (pos < 0) break;
                const occurrence = seen.get(needle) ?? 0;
                if (indices.has(occurrence) || indices.has(-1)) {
                    const endNorm = pos + needle.length;
                    const start = mapped.origIdx[pos] ?? 0;
                    const end =
                        endNorm - 1 < mapped.origIdx.length
                            ? (mapped.origIdx[endNorm - 1] ?? paragraph.text.length - 1) + 1
                            : paragraph.text.length;
                    byParagraph.set(paragraph, [
                        ...(byParagraph.get(paragraph) ?? []),
                        { start, end },
                    ]);
                    appliedKeys.add(`${needle}:${occurrence}`);
                    if (indices.has(-1)) appliedKeys.add(`${needle}:-1`);
                }
                seen.set(needle, occurrence + 1);
                from = pos + Math.max(1, needle.length);
            }
        }
    }

    const applied: AppliedDocxHighlight[] = [];
    const errors: { quote: string; occurrence_index: number; reason: string }[] = [];
    for (const input of inputs) {
        const needle = normalizedNeedle(input.quote);
        if (needle && appliedKeys.has(`${needle}:${input.occurrence_index}`)) {
            applied.push(input);
        } else {
            errors.push({
                quote: input.quote,
                occurrence_index: input.occurrence_index,
                reason: "Quote occurrence was not found in DOCX body.",
            });
        }
    }
    return { byParagraph, applied, errors };
}

export async function applyDocxHighlights(
    bytes: Buffer,
    highlights: DocxHighlightInput[],
): Promise<ApplyDocxHighlightsResult> {
    const zip = await JSZip.loadAsync(bytes);
    const docEntry = getZipEntry(zip, "word/document.xml");
    if (!docEntry) throw new Error("DOCX is missing word/document.xml");

    const xml = await docEntry.async("string");
    const parser = new XMLParser({
        ignoreAttributes: false,
        preserveOrder: true,
        textNodeName: TEXT_KEY,
        attributeNamePrefix: "@_",
        trimValues: false,
    });
    const tree = parser.parse(xml) as XNode[];
    const paragraphs = collectParagraphs(tree);
    const { byParagraph, applied, errors } = rangesForHighlights(
        paragraphs,
        highlights,
    );

    for (const [paragraph, ranges] of byParagraph.entries()) {
        applyRangesToParagraph(paragraph, ranges);
    }

    const builder = new XMLBuilder({
        ignoreAttributes: false,
        preserveOrder: true,
        textNodeName: TEXT_KEY,
        attributeNamePrefix: "@_",
        suppressEmptyNode: false,
        format: false,
    });
    setZipEntry(zip, "word/document.xml", builder.build(tree));
    const out = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: out, applied, errors };
}

export async function removeDocxHighlights(
    bytes: Buffer,
    highlights: DocxHighlightInput[] = [],
    options: { all?: boolean } = {},
): Promise<RemoveDocxHighlightsResult> {
    const zip = await JSZip.loadAsync(bytes);
    const docEntry = getZipEntry(zip, "word/document.xml");
    if (!docEntry) throw new Error("DOCX is missing word/document.xml");

    const xml = await docEntry.async("string");
    const parser = new XMLParser({
        ignoreAttributes: false,
        preserveOrder: true,
        textNodeName: TEXT_KEY,
        attributeNamePrefix: "@_",
        trimValues: false,
    });
    const tree = parser.parse(xml) as XNode[];

    let removed: AppliedDocxHighlight[] = [];
    let errors: { quote: string; occurrence_index: number; reason: string }[] = [];
    let removedCount = 0;

    if (options.all || highlights.length === 0) {
        removedCount = removeAllHighlightsFromTree(tree);
    } else {
        const paragraphs = collectParagraphs(tree);
        const { byParagraph, applied, errors: rangeErrors } = rangesForHighlights(
            paragraphs,
            highlights,
        );
        for (const [paragraph, ranges] of byParagraph.entries()) {
            removeRangesFromParagraph(paragraph, ranges);
        }
        removed = applied;
        errors = rangeErrors;
        removedCount = [...byParagraph.values()].reduce(
            (sum, ranges) => sum + ranges.length,
            0,
        );
    }

    const builder = new XMLBuilder({
        ignoreAttributes: false,
        preserveOrder: true,
        textNodeName: TEXT_KEY,
        attributeNamePrefix: "@_",
        suppressEmptyNode: false,
        format: false,
    });
    setZipEntry(zip, "word/document.xml", builder.build(tree));
    const out = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: out, removed, removed_count: removedCount, errors };
}
