import crypto from "node:crypto";

import { XMLBuilder, XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

export const DOCUMENT_REFLOW_UNSUPPORTED =
    "DOCUMENT_REFLOW_UNSUPPORTED" as const;

export class DocumentReflowError extends Error {
    readonly code = DOCUMENT_REFLOW_UNSUPPORTED;
    readonly reasons: string[];

    constructor(message: string, reasons: string[] = [], options?: ErrorOptions) {
        super(message, options);
        this.name = "DocumentReflowError";
        this.reasons = [...reasons];
    }
}

export interface DocxLayoutInspection {
    sha256: string;
    paragraphCount: number;
    framedParagraphCount: number;
    sectionCount: number;
    tableCount: number;
    fixedHeightRowCount: number;
    floatingObjectCount: number;
    trackedInsertionCount: number;
    trackedDeletionCount: number;
    commentCount: number;
    commentAnchorCount: number;
    supportedForAutomaticReflow: boolean;
    unsupportedReasons: string[];
}

export interface DocxReflowResult {
    bytes: Buffer;
    changed: boolean;
    inspection: DocxLayoutInspection;
    metadata: {
        layout_reflowed: boolean;
        layout_reflow_version: number;
        source_sha256: string;
        original_frame_count: number;
        original_fixed_height_row_count: number;
        original_section_count: number;
        converted_table_count: number;
        converted_footer_count: number;
        normalized_fixed_height_row_count: number;
    };
}

type XNode = Record<string, unknown>;
type TextView = "accepted" | "rejected" | "all";

const ATTR_KEY = ":@";
const TEXT_KEY = "#text";
const W_NS =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS =
    "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS =
    "http://schemas.openxmlformats.org/package/2006/content-types";
const FOOTER_REL_TYPE =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer";
const FOOTER_CONTENT_TYPE =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";
const STABLE_ZIP_ENTRY_DATE = new Date("2000-01-01T00:00:00.000Z");
const DEFAULT_PAGE_WIDTH = 12_240;
const DEFAULT_PAGE_HEIGHT = 15_840;
const DEFAULT_MARGIN = 1_440;
const ROW_Y_TOLERANCE_DXA = 60;
const COLUMN_X_TOLERANCE_DXA = 60;
const MAX_DERIVED_ROW_GAP_DXA = 480;
const FOOTER_EDGE_TOLERANCE_DXA = 1_200;
const REFLOW_VERSION = 1;

function sha256(bytes: Buffer | string): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parser(): XMLParser {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        trimValues: false,
        // OOXML text is data, never a typed scalar. Without this, the XML
        // parser coerces values such as "3.10" to the number 3.1 and the
        // layout verifier falsely reports that Writer dropped text even when
        // the DOCX and rendered PDF both contain the exact identifier.
        parseTagValue: false,
        parseAttributeValue: false,
        processEntities: true,
    });
}

function builder(): XMLBuilder {
    return new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        suppressEmptyNode: false,
        processEntities: true,
    });
}

function cloneNode<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function elementName(node: unknown): string | null {
    if (!node || typeof node !== "object") return null;
    for (const key of Object.keys(node as XNode)) {
        if (key !== ATTR_KEY && key !== TEXT_KEY) return key;
    }
    return null;
}

function children(node: unknown): XNode[] {
    const name = elementName(node);
    if (!name) return [];
    const value = (node as XNode)[name];
    return Array.isArray(value) ? (value as XNode[]) : [];
}

function setChildren(node: XNode, value: XNode[]): void {
    const name = elementName(node);
    if (name) node[name] = value;
}

function attrs(node: unknown): Record<string, string> {
    if (!node || typeof node !== "object") return {};
    return ((node as XNode)[ATTR_KEY] as Record<string, string> | undefined) ?? {};
}

function makeElement(
    name: string,
    childNodes: XNode[] = [],
    attributes?: Record<string, string>,
): XNode {
    const node: XNode = { [name]: childNodes };
    if (attributes && Object.keys(attributes).length > 0) {
        node[ATTR_KEY] = Object.fromEntries(
            Object.entries(attributes).map(([key, value]) => [
                key.startsWith("@_") ? key : `@_${key}`,
                value,
            ]),
        );
    }
    return node;
}

function makeText(value: string): XNode {
    return { [TEXT_KEY]: value };
}

function ensureXmlDeclaration(xml: string): string {
    if (xml.startsWith("<?xml")) return xml;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
}

function zipEntry(zip: JSZip, slashPath: string): JSZip.JSZipObject | null {
    return zip.file(slashPath) ?? zip.file(slashPath.replace(/\//g, "\\"));
}

function setZipEntry(zip: JSZip, slashPath: string, value: string | Buffer): void {
    const backslashPath = slashPath.replace(/\//g, "\\");
    const direct = zip.file(slashPath);
    const fallback = direct ? null : zip.file(backslashPath);
    const target = fallback ? backslashPath : slashPath;
    zip.file(target, value, {
        date: (direct ?? fallback)?.date ?? STABLE_ZIP_ENTRY_DATE,
        createFolders: false,
    });
}

function findFirst(node: XNode, wanted: string): XNode | null {
    if (elementName(node) === wanted) return node;
    for (const child of children(node)) {
        const found = findFirst(child, wanted);
        if (found) return found;
    }
    return null;
}

function findBody(tree: XNode[]): XNode | null {
    for (const node of tree) {
        const body = findFirst(node, "w:body");
        if (body) return body;
    }
    return null;
}

function paragraphProperties(paragraph: XNode): XNode {
    const existing = children(paragraph).find(
        (child) => elementName(child) === "w:pPr",
    );
    if (existing) return existing;
    const created = makeElement("w:pPr");
    setChildren(paragraph, [created, ...children(paragraph)]);
    return created;
}

function nestedSectPr(paragraph: XNode): XNode | null {
    const pPr = children(paragraph).find(
        (child) => elementName(child) === "w:pPr",
    );
    if (!pPr) return null;
    return (
        children(pPr).find((child) => elementName(child) === "w:sectPr") ??
        null
    );
}

function detachNestedSectPr(paragraph: XNode): XNode | null {
    const pPr = children(paragraph).find(
        (child) => elementName(child) === "w:pPr",
    );
    if (!pPr) return null;
    const sectPr = children(pPr).find(
        (child) => elementName(child) === "w:sectPr",
    );
    if (!sectPr) return null;
    setChildren(
        pPr,
        children(pPr).filter((child) => child !== sectPr),
    );
    return sectPr;
}

function frameProperties(paragraph: XNode): XNode | null {
    const pPr = children(paragraph).find(
        (child) => elementName(child) === "w:pPr",
    );
    if (!pPr) return null;
    return (
        children(pPr).find((child) => elementName(child) === "w:framePr") ??
        null
    );
}

function removeFrameProperties(paragraph: XNode): void {
    const pPr = children(paragraph).find(
        (child) => elementName(child) === "w:pPr",
    );
    if (!pPr) return;
    setChildren(
        pPr,
        children(pPr).filter((child) => elementName(child) !== "w:framePr"),
    );
}

function integerAttr(
    node: XNode | null,
    name: string,
    fallback: number,
): number {
    const parsed = Number(attrs(node)[`@_${name}`]);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function directText(node: XNode, view: TextView = "accepted"): string {
    let result = "";
    const visit = (current: XNode, revisionState: "normal" | "ins" | "del") => {
        const name = elementName(current);
        if (!name) return;
        const nextState =
            name === "w:ins" ? "ins" : name === "w:del" ? "del" : revisionState;
        if (
            (view === "accepted" && nextState === "del") ||
            (view === "rejected" && nextState === "ins")
        ) {
            return;
        }
        if (name === "w:t" || name === "w:delText") {
            result += children(current)
                .map((child) => String(child[TEXT_KEY] ?? ""))
                .join("");
            return;
        }
        if (name === "w:tab") {
            result += "\t";
            return;
        }
        if (name === "w:br" || name === "w:cr") {
            result += "\n";
            return;
        }
        for (const child of children(current)) visit(child, nextState);
    };
    visit(node, "normal");
    return result;
}

function containsAnyElement(node: XNode, wanted: ReadonlySet<string>): boolean {
    const name = elementName(node);
    if (name && wanted.has(name)) return true;
    return children(node).some((child) => containsAnyElement(child, wanted));
}

function countElements(tree: XNode[], wanted: string): number {
    let count = 0;
    const visit = (node: XNode) => {
        if (elementName(node) === wanted) count += 1;
        for (const child of children(node)) visit(child);
    };
    for (const node of tree) visit(node);
    return count;
}

function visibleTextMultiset(tree: XNode[], view: TextView): string[] {
    const values: string[] = [];
    const visit = (node: XNode, revisionState: "normal" | "ins" | "del") => {
        const name = elementName(node);
        if (!name) return;
        const nextState =
            name === "w:ins" ? "ins" : name === "w:del" ? "del" : revisionState;
        if (
            (view === "accepted" && nextState === "del") ||
            (view === "rejected" && nextState === "ins")
        ) {
            return;
        }
        if (name === "w:t" || name === "w:delText") {
            const value = children(node)
                .map((child) => String(child[TEXT_KEY] ?? ""))
                .join("");
            values.push(value);
            return;
        }
        for (const child of children(node)) visit(child, nextState);
    };
    for (const node of tree) visit(node, "normal");
    return values.sort();
}

function trackedSignatures(tree: XNode[]): string[] {
    const signatures: string[] = [];
    const visit = (node: XNode) => {
        const name = elementName(node);
        if (name === "w:ins" || name === "w:del") {
            const properties = attrs(node);
            signatures.push(
                JSON.stringify({
                    kind: name,
                    id: properties["@_w:id"] ?? "",
                    author: properties["@_w:author"] ?? "",
                    date: properties["@_w:date"] ?? "",
                    text: directText(node, name === "w:del" ? "rejected" : "accepted"),
                }),
            );
        }
        for (const child of children(node)) visit(child);
    };
    for (const node of tree) visit(node);
    return signatures.sort();
}

function commentAnchorSignatures(tree: XNode[]): string[] {
    const signatures: string[] = [];
    const anchorNames = new Set([
        "w:commentRangeStart",
        "w:commentRangeEnd",
        "w:commentReference",
    ]);
    const visit = (node: XNode) => {
        const name = elementName(node);
        if (name && anchorNames.has(name)) {
            signatures.push(`${name}:${attrs(node)["@_w:id"] ?? ""}`);
        }
        for (const child of children(node)) visit(child);
    };
    for (const node of tree) visit(node);
    return signatures.sort();
}

interface IntegritySnapshot {
    acceptedText: string[];
    rejectedText: string[];
    revisions: string[];
    commentAnchors: string[];
    commentsHash: string | null;
    relationships: string[];
}

function paragraphTextSequence(tree: XNode[], view: TextView): string[] {
    const values: string[] = [];
    const visit = (node: XNode) => {
        if (elementName(node) === "w:p") {
            const value = directText(node, view);
            if (value) values.push(value);
            return;
        }
        for (const child of children(node)) visit(child);
    };
    for (const node of tree) visit(node);
    return values;
}

function flowParagraphTextSequence(tree: XNode[], view: TextView): string[] {
    const values: string[] = [];
    const visit = (node: XNode) => {
        if (elementName(node) === "w:p") {
            if (!frameProperties(node)) {
                const value = directText(node, view);
                if (value) values.push(value);
            }
            return;
        }
        for (const child of children(node)) visit(child);
    };
    for (const node of tree) visit(node);
    return values;
}

function isSubsequence(values: string[], candidates: string[]): boolean {
    let index = 0;
    for (const candidate of candidates) {
        if (candidate === values[index]) index += 1;
        if (index === values.length) return true;
    }
    return values.length === 0;
}

async function relationshipSignatures(zip: JSZip): Promise<string[]> {
    const entry = zipEntry(zip, "word/_rels/document.xml.rels");
    if (!entry) return [];
    const tree = parser().parse(await entry.async("string")) as XNode[];
    const signatures: string[] = [];
    const visit = (node: XNode) => {
        if (elementName(node) === "Relationship") {
            const a = attrs(node);
            signatures.push(
                JSON.stringify({
                    id: a["@_Id"] ?? "",
                    type: a["@_Type"] ?? "",
                    target: a["@_Target"] ?? "",
                    targetMode: a["@_TargetMode"] ?? "",
                }),
            );
        }
        for (const child of children(node)) visit(child);
    };
    for (const node of tree) visit(node);
    return signatures.sort();
}

async function integritySnapshot(zip: JSZip, tree: XNode[]): Promise<IntegritySnapshot> {
    const comments = zipEntry(zip, "word/comments.xml");
    const commentsXml = comments ? await comments.async("string") : null;
    const visiblePartTrees: XNode[][] = [tree];
    const relatedPartPaths = Object.keys(zip.files)
        .map((entry) => entry.replace(/\\/g, "/"))
        .filter((entry) => /^word\/(?:header|footer)\d+\.xml$/i.test(entry))
        .sort();
    for (const partPath of relatedPartPaths) {
        const part = zipEntry(zip, partPath);
        if (!part) continue;
        visiblePartTrees.push(
            parser().parse(await part.async("string")) as XNode[],
        );
    }
    const acceptedText = visiblePartTrees
        .flatMap((partTree) => visibleTextMultiset(partTree, "accepted"))
        .sort();
    const rejectedText = visiblePartTrees
        .flatMap((partTree) => visibleTextMultiset(partTree, "rejected"))
        .sort();
    const revisions = visiblePartTrees
        .flatMap((partTree) => trackedSignatures(partTree))
        .sort();
    const commentAnchors = visiblePartTrees
        .flatMap((partTree) => commentAnchorSignatures(partTree))
        .sort();
    return {
        acceptedText,
        rejectedText,
        revisions,
        commentAnchors,
        commentsHash: commentsXml ? sha256(commentsXml) : null,
        relationships: await relationshipSignatures(zip),
    };
}

function arraysEqual(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, i) => value === right[i]);
}

function verifyIntegrity(before: IntegritySnapshot, after: IntegritySnapshot): void {
    const reasons: string[] = [];
    if (!arraysEqual(before.acceptedText, after.acceptedText)) {
        reasons.push("accepted-view text changed during reflow");
    }
    if (!arraysEqual(before.rejectedText, after.rejectedText)) {
        reasons.push("rejected-view text changed during reflow");
    }
    if (!arraysEqual(before.revisions, after.revisions)) {
        reasons.push("tracked-change metadata changed during reflow");
    }
    if (!arraysEqual(before.commentAnchors, after.commentAnchors)) {
        reasons.push("comment anchors changed during reflow");
    }
    if (before.commentsHash !== after.commentsHash) {
        reasons.push("comments.xml changed during reflow");
    }
    const afterRelationships = new Set(after.relationships);
    if (!before.relationships.every((value) => afterRelationships.has(value))) {
        reasons.push("an existing document relationship was lost during reflow");
    }
    if (reasons.length > 0) {
        throw new DocumentReflowError(
            "The fixed-layout document could not be normalized without changing its content.",
            reasons,
        );
    }
}

function unsupportedReasons(tree: XNode[], framedParagraphCount: number): string[] {
    const reasons: string[] = [];
    const alwaysUnsupported = [
        ["wp:anchor", "floating drawings"],
        ["v:textbox", "VML text boxes"],
        ["w:txbxContent", "text-box content"],
        ["w:object", "embedded objects"],
    ] as const;
    for (const [name, label] of alwaysUnsupported) {
        if (countElements(tree, name) > 0) reasons.push(`contains ${label}`);
    }
    if (framedParagraphCount > 0) {
        const frameConflicts = [
            ["w:tbl", "existing tables"],
            ["w:drawing", "drawings"],
            ["w:pict", "VML pictures or text boxes"],
        ] as const;
        for (const [name, label] of frameConflicts) {
            if (countElements(tree, name) > 0) reasons.push(`contains ${label}`);
        }
    }
    return reasons;
}

async function parseDocument(bytes: Buffer): Promise<{
    zip: JSZip;
    tree: XNode[];
    body: XNode;
}> {
    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(bytes);
    } catch (cause) {
        throw new DocumentReflowError("The DOCX archive is invalid.", ["invalid ZIP archive"], {
            cause,
        });
    }
    const entry = zipEntry(zip, "word/document.xml");
    if (!entry) {
        throw new DocumentReflowError("The DOCX is missing word/document.xml.", [
            "missing main document part",
        ]);
    }
    const tree = parser().parse(await entry.async("string")) as XNode[];
    const body = findBody(tree);
    if (!body) {
        throw new DocumentReflowError("The DOCX is missing w:body.", [
            "missing document body",
        ]);
    }
    return { zip, tree, body };
}

export async function inspectDocxLayout(bytes: Buffer): Promise<DocxLayoutInspection> {
    const { zip, tree } = await parseDocument(bytes);
    const framedParagraphCount = countElements(tree, "w:framePr");
    const reasons = unsupportedReasons(tree, framedParagraphCount);
    let additionalFloatingObjectCount = 0;
    const auxiliaryStoryPaths = Object.keys(zip.files)
        .map((entry) => entry.replace(/\\/g, "/"))
        .filter((entry) =>
            /^word\/(?:header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(
                entry,
            ),
        );
    for (const partPath of auxiliaryStoryPaths) {
        const part = zipEntry(zip, partPath);
        if (!part) continue;
        const partTree = parser().parse(await part.async("string")) as XNode[];
        const partFrames = countElements(partTree, "w:framePr");
        const partFixedRows = (() => {
            let count = 0;
            const visit = (node: XNode) => {
                if (
                    elementName(node) === "w:trHeight" &&
                    attrs(node)["@_w:hRule"] === "exact"
                ) {
                    count += 1;
                }
                for (const child of children(node)) visit(child);
            };
            for (const node of partTree) visit(node);
            return count;
        })();
        const partFloating =
            countElements(partTree, "wp:anchor") +
            countElements(partTree, "v:textbox") +
            countElements(partTree, "w:txbxContent") +
            countElements(partTree, "w:object");
        additionalFloatingObjectCount += partFloating;
        if (partFrames > 0) {
            reasons.push(`contains framed content outside the main document (${partPath})`);
        }
        if (partFixedRows > 0) {
            reasons.push(`contains fixed-height rows outside the main document (${partPath})`);
        }
        if (partFloating > 0) {
            reasons.push(`contains floating objects outside the main document (${partPath})`);
        }
    }
    const commentsEntry = zipEntry(zip, "word/comments.xml");
    let commentCount = 0;
    if (commentsEntry) {
        const commentsTree = parser().parse(
            await commentsEntry.async("string"),
        ) as XNode[];
        commentCount = countElements(commentsTree, "w:comment");
    }
    let fixedHeightRowCount = 0;
    const visitFixedRows = (node: XNode) => {
        if (
            elementName(node) === "w:trHeight" &&
            attrs(node)["@_w:hRule"] === "exact"
        ) {
            fixedHeightRowCount += 1;
        }
        for (const child of children(node)) visitFixedRows(child);
    };
    for (const node of tree) visitFixedRows(node);
    const floatingObjectCount =
        countElements(tree, "wp:anchor") +
        countElements(tree, "v:textbox") +
        countElements(tree, "w:txbxContent") +
        countElements(tree, "w:object") +
        additionalFloatingObjectCount;
    return {
        sha256: sha256(bytes),
        paragraphCount: countElements(tree, "w:p"),
        framedParagraphCount,
        sectionCount: Math.max(1, countElements(tree, "w:sectPr")),
        tableCount: countElements(tree, "w:tbl"),
        fixedHeightRowCount,
        floatingObjectCount,
        trackedInsertionCount: countElements(tree, "w:ins"),
        trackedDeletionCount: countElements(tree, "w:del"),
        commentCount,
        commentAnchorCount:
            countElements(tree, "w:commentRangeStart") +
            countElements(tree, "w:commentRangeEnd") +
            countElements(tree, "w:commentReference"),
        supportedForAutomaticReflow:
            (framedParagraphCount > 0 || fixedHeightRowCount > 0) &&
            reasons.length === 0,
        unsupportedReasons: reasons,
    };
}

interface PageGeometry {
    width: number;
    height: number;
    left: number;
    right: number;
}

function pageGeometry(sectPr: XNode | null): PageGeometry {
    const pgSz = sectPr
        ? children(sectPr).find((child) => elementName(child) === "w:pgSz") ?? null
        : null;
    const pgMar = sectPr
        ? children(sectPr).find((child) => elementName(child) === "w:pgMar") ?? null
        : null;
    return {
        width: integerAttr(pgSz, "w:w", DEFAULT_PAGE_WIDTH),
        height: integerAttr(pgSz, "w:h", DEFAULT_PAGE_HEIGHT),
        left: integerAttr(pgMar, "w:left", DEFAULT_MARGIN),
        right: integerAttr(pgMar, "w:right", DEFAULT_MARGIN),
    };
}

interface FramedParagraph {
    node: XNode;
    originalIndex: number;
    x: number;
    y: number;
    width: number;
}

interface FrameColumn {
    x: number;
    width: number;
    paragraphs: FramedParagraph[];
}

interface FrameRow {
    y: number;
    columns: FrameColumn[];
}

function frameRows(framed: FramedParagraph[]): FrameRow[] {
    const sorted = [...framed].sort(
        (left, right) =>
            left.y - right.y ||
            left.x - right.x ||
            left.originalIndex - right.originalIndex,
    );
    const rowBuckets: FramedParagraph[][] = [];
    for (const paragraph of sorted) {
        const current = rowBuckets.at(-1);
        if (
            !current ||
            Math.abs(paragraph.y - current[0].y) > ROW_Y_TOLERANCE_DXA
        ) {
            rowBuckets.push([paragraph]);
        } else {
            current.push(paragraph);
        }
    }
    return rowBuckets.map((bucket) => {
        const columns: FrameColumn[] = [];
        for (const paragraph of bucket.sort(
            (left, right) =>
                left.x - right.x || left.originalIndex - right.originalIndex,
        )) {
            let column = columns.find(
                (candidate) =>
                    Math.abs(candidate.x - paragraph.x) <= COLUMN_X_TOLERANCE_DXA,
            );
            if (!column) {
                column = { x: paragraph.x, width: paragraph.width, paragraphs: [] };
                columns.push(column);
            }
            column.width = Math.max(column.width, paragraph.width);
            column.paragraphs.push(paragraph);
        }
        return {
            y: Math.min(...bucket.map((paragraph) => paragraph.y)),
            columns: columns.sort((left, right) => left.x - right.x),
        };
    });
}

function updateChildAttribute(
    parent: XNode,
    childName: string,
    attributes: Record<string, string>,
): XNode {
    let child = children(parent).find(
        (candidate) => elementName(candidate) === childName,
    );
    if (!child) {
        child = makeElement(childName, [], attributes);
        setChildren(parent, [...children(parent), child]);
        return child;
    }
    child[ATTR_KEY] = {
        ...attrs(child),
        ...Object.fromEntries(
            Object.entries(attributes).map(([key, value]) => [
                key.startsWith("@_") ? key : `@_${key}`,
                value,
            ]),
        ),
    };
    return child;
}

function normalizeFixedHeightRows(tree: XNode[]): number {
    let normalized = 0;
    const visit = (node: XNode) => {
        if (
            elementName(node) === "w:trHeight" &&
            attrs(node)["@_w:hRule"] === "exact"
        ) {
            node[ATTR_KEY] = {
                ...attrs(node),
                "@_w:hRule": "atLeast",
            };
            normalized += 1;
        }
        for (const child of children(node)) visit(child);
    };
    for (const node of tree) visit(node);
    return normalized;
}

function applyParagraphGeometry(
    paragraph: XNode,
    geometry: PageGeometry,
    column: FrameColumn,
    after: number,
): void {
    removeFrameProperties(paragraph);
    const pPr = paragraphProperties(paragraph);
    const rightEdge = Math.min(geometry.width - geometry.right, column.x + column.width);
    updateChildAttribute(pPr, "w:ind", {
        "w:left": String(Math.max(0, column.x - geometry.left)),
        "w:right": String(
            Math.max(0, geometry.width - geometry.right - rightEdge),
        ),
    });
    updateChildAttribute(pPr, "w:spacing", {
        "w:after": String(Math.max(0, after)),
    });
}

function tableBorders(): XNode {
    const border = (name: string) =>
        makeElement(name, [], {
            "w:val": "nil",
            "w:sz": "0",
            "w:space": "0",
            "w:color": "auto",
        });
    return makeElement("w:tblBorders", [
        border("w:top"),
        border("w:left"),
        border("w:bottom"),
        border("w:right"),
        border("w:insideH"),
        border("w:insideV"),
    ]);
}

function tableCellMargins(): XNode {
    const margin = (name: string, width: number) =>
        makeElement(name, [], {
            "w:w": String(width),
            "w:type": "dxa",
        });
    return makeElement("w:tblCellMar", [
        margin("w:top", 0),
        margin("w:left", 60),
        margin("w:bottom", 0),
        margin("w:right", 60),
    ]);
}

function tableForRow(
    row: FrameRow,
    geometry: PageGeometry,
    after: number,
): XNode {
    const firstX = row.columns[0].x;
    const lastRight = Math.min(
        geometry.width - geometry.right,
        Math.max(...row.columns.map((column) => column.x + column.width)),
    );
    const widths = row.columns.map((column, index) => {
        const next = row.columns[index + 1];
        return Math.max(240, (next ? next.x : lastRight) - column.x);
    });
    const totalWidth = widths.reduce((sum, width) => sum + width, 0);
    const table = makeElement("w:tbl", [
        makeElement("w:tblPr", [
            makeElement("w:tblW", [], {
                "w:w": String(totalWidth),
                "w:type": "dxa",
            }),
            makeElement("w:tblInd", [], {
                "w:w": String(Math.max(0, firstX - geometry.left)),
                "w:type": "dxa",
            }),
            makeElement("w:tblLayout", [], { "w:type": "fixed" }),
            tableBorders(),
            tableCellMargins(),
        ]),
        makeElement(
            "w:tblGrid",
            widths.map((width) =>
                makeElement("w:gridCol", [], { "w:w": String(width) }),
            ),
        ),
        makeElement(
            "w:tr",
            row.columns.map((column, index) => {
                const paragraphs = column.paragraphs.map((entry, paragraphIndex) => {
                    removeFrameProperties(entry.node);
                    const pPr = paragraphProperties(entry.node);
                    updateChildAttribute(pPr, "w:ind", {
                        "w:left": "0",
                        "w:right": "0",
                    });
                    updateChildAttribute(pPr, "w:spacing", {
                        "w:after": String(
                            paragraphIndex === column.paragraphs.length - 1
                                ? Math.max(0, after)
                                : 0,
                        ),
                    });
                    return entry.node;
                });
                if (paragraphs.length === 0) paragraphs.push(makeElement("w:p"));
                return makeElement("w:tc", [
                    makeElement("w:tcPr", [
                        makeElement("w:tcW", [], {
                            "w:w": String(widths[index]),
                            "w:type": "dxa",
                        }),
                        makeElement("w:vAlign", [], { "w:val": "top" }),
                    ]),
                    ...paragraphs,
                ]);
            }),
        ),
    ]);
    return table;
}

function isNumericPageParagraph(paragraph: XNode): boolean {
    return /^\d+$/.test(directText(paragraph).trim());
}

function hasRevisionOrComment(node: XNode): boolean {
    return containsAnyElement(
        node,
        new Set([
            "w:ins",
            "w:del",
            "w:commentRangeStart",
            "w:commentRangeEnd",
            "w:commentReference",
        ]),
    );
}

const UNSAFE_FLOW_OVERLAY_ELEMENTS = new Set([
    "w:altChunk",
    "w:br",
    "w:cr",
    "w:drawing",
    "w:fldChar",
    "w:fldSimple",
    "w:instrText",
    "w:object",
    "w:pict",
    "w:tab",
]);

/**
 * Some converted fixed-layout documents use ordinary centered paragraphs for
 * a letterhead while storing the rest of the page in absolute frames. Word
 * lays those paragraphs out at the top even when their XML appears between
 * later-positioned frames. Treat only inert spacer paragraphs and simple,
 * centered, review-free text as that leading flow overlay. Anything else is
 * an ordering boundary and keeps its original position relative to frames.
 */
function isLeadingFlowOverlayParagraph(node: XNode): boolean {
    if (elementName(node) !== "w:p" || hasRevisionOrComment(node)) return false;
    const paragraphChildren = children(node);
    if (
        paragraphChildren.length === 0 ||
        paragraphChildren.every((child) => elementName(child) === "w:pPr")
    ) {
        return true;
    }
    if (containsAnyElement(node, UNSAFE_FLOW_OVERLAY_ELEMENTS)) return false;
    const pPr = paragraphChildren.find(
        (child) => elementName(child) === "w:pPr",
    );
    const justification = pPr
        ? children(pPr).find((child) => elementName(child) === "w:jc")
        : null;
    return attrs(justification)["@_w:val"] === "center";
}

function footerCandidate(row: FrameRow, geometry: PageGeometry): boolean {
    if (row.columns.length < 2) return false;
    if (row.y < geometry.height - FOOTER_EDGE_TOLERANCE_DXA) return false;
    const rightColumn = row.columns.at(-1);
    const leftColumn = row.columns[0];
    if (!rightColumn || !leftColumn) return false;
    if (rightColumn.paragraphs.length !== 1) return false;
    if (!isNumericPageParagraph(rightColumn.paragraphs[0].node)) return false;
    if (!directText(leftColumn.paragraphs[0].node).trim()) return false;
    return !row.columns.some((column) =>
        column.paragraphs.some((paragraph) => hasRevisionOrComment(paragraph.node)),
    );
}

function rightAlignParagraph(paragraph: XNode): void {
    const pPr = paragraphProperties(paragraph);
    updateChildAttribute(pPr, "w:jc", { "w:val": "right" });
}

function replacePageNumberWithField(paragraph: XNode): void {
    removeFrameProperties(paragraph);
    const cached = directText(paragraph).trim() || "1";
    const pPr = paragraphProperties(paragraph);
    rightAlignParagraph(paragraph);
    const originalRun = children(paragraph).find(
        (child) => elementName(child) === "w:r",
    );
    const originalRPr = originalRun
        ? children(originalRun).find((child) => elementName(child) === "w:rPr")
        : null;
    const run = (content: XNode) =>
        makeElement("w:r", [
            ...(originalRPr ? [cloneNode(originalRPr)] : []),
            content,
        ]);
    setChildren(paragraph, [
        pPr,
        run(makeElement("w:fldChar", [], { "w:fldCharType": "begin" })),
        run(
            makeElement("w:instrText", [makeText(" PAGE ")], {
                "xml:space": "preserve",
            }),
        ),
        run(makeElement("w:fldChar", [], { "w:fldCharType": "separate" })),
        run(makeElement("w:t", [makeText(cached)])),
        run(makeElement("w:fldChar", [], { "w:fldCharType": "end" })),
    ]);
}

function footerXml(
    row: FrameRow,
    geometry: PageGeometry,
    documentRootAttributes: Record<string, string>,
): string {
    const clonedRow = cloneNode(row);
    const right = clonedRow.columns.at(-1);
    if (right) replacePageNumberWithField(right.paragraphs[0].node);
    for (const column of clonedRow.columns) {
        for (const paragraph of column.paragraphs) removeFrameProperties(paragraph.node);
    }
    const root = makeElement(
        "w:ftr",
        [tableForRow(clonedRow, geometry, 0)],
        {
            ...documentRootAttributes,
            "xmlns:w": documentRootAttributes["@_xmlns:w"] ?? W_NS,
            "xmlns:r": documentRootAttributes["@_xmlns:r"] ?? R_NS,
        },
    );
    return ensureXmlDeclaration(builder().build([root]));
}

function derivedGap(current: FrameRow, next: FrameRow | undefined): number {
    if (!next) return 0;
    const maxParagraphs = Math.max(
        1,
        ...current.columns.map((column) => column.paragraphs.length),
    );
    const estimatedHeight = maxParagraphs * 240;
    return Math.min(
        MAX_DERIVED_ROW_GAP_DXA,
        Math.max(0, next.y - current.y - estimatedHeight),
    );
}

interface SectionChunk {
    content: XNode[];
    sectPr: XNode | null;
    terminalParagraph: XNode | null;
}

function splitSections(bodyChildren: XNode[]): {
    sections: SectionChunk[];
    finalSectPr: XNode | null;
} {
    const sections: SectionChunk[] = [];
    let content: XNode[] = [];
    let finalSectPr: XNode | null = null;
    for (const node of bodyChildren) {
        if (elementName(node) === "w:sectPr") {
            finalSectPr = node;
            continue;
        }
        const sectPr = elementName(node) === "w:p" ? nestedSectPr(node) : null;
        if (!sectPr) {
            content.push(node);
            continue;
        }
        const detached = detachNestedSectPr(node);
        content.push(node);
        sections.push({
            content,
            sectPr: detached,
            terminalParagraph: makeElement("w:p", [
                makeElement("w:pPr", detached ? [detached] : []),
            ]),
        });
        content = [];
    }
    sections.push({
        content,
        sectPr: finalSectPr,
        terminalParagraph: null,
    });
    return { sections, finalSectPr };
}

interface ProcessedSection {
    nodes: XNode[];
    footer: { xml: string; sectPr: XNode } | null;
    convertedTableCount: number;
}

function hasDefaultFooter(sectPr: XNode): boolean {
    return children(sectPr).some(
        (node) =>
            elementName(node) === "w:footerReference" &&
            attrs(node)["@_w:type"] === "default",
    );
}

function processSection(
    section: SectionChunk,
    documentRootAttributes: Record<string, string>,
): ProcessedSection {
    const geometry = pageGeometry(section.sectPr);
    const nodes: XNode[] = [];
    let footer: ProcessedSection["footer"] = null;
    let convertedTableCount = 0;
    let framedGroup: FramedParagraph[] = [];
    let leadingFlowOverlay: XNode[] = [];
    const flushFrames = () => {
        if (leadingFlowOverlay.length > 0) {
            nodes.push(...leadingFlowOverlay);
            leadingFlowOverlay = [];
        }
        if (framedGroup.length === 0) return;
        const rows = frameRows(framedGroup);
        framedGroup = [];
        if (section.sectPr) {
            const candidateIndex = rows.findIndex((row) =>
                footerCandidate(row, geometry),
            );
            if (candidateIndex >= 0) {
                if (footer) {
                    throw new DocumentReflowError(
                        "The fixed-layout section contains more than one footer candidate.",
                        ["multiple bottom-of-page title/page-number rows"],
                    );
                }
                if (hasDefaultFooter(section.sectPr)) {
                    throw new DocumentReflowError(
                        "The fixed-layout footer cannot be merged safely with the section's existing footer.",
                        ["section already has a default footer"],
                    );
                }
                const [candidate] = rows.splice(candidateIndex, 1);
                footer = {
                    xml: footerXml(candidate, geometry, documentRootAttributes),
                    sectPr: section.sectPr,
                };
            }
        }
        rows.forEach((row, index) => {
            const after = derivedGap(row, rows[index + 1]);
            if (row.columns.length === 1) {
                const column = row.columns[0];
                column.paragraphs.forEach((entry, paragraphIndex) => {
                    applyParagraphGeometry(
                        entry.node,
                        geometry,
                        column,
                        paragraphIndex === column.paragraphs.length - 1
                            ? after
                            : 0,
                    );
                    nodes.push(entry.node);
                });
            } else {
                nodes.push(tableForRow(row, geometry, after));
                convertedTableCount += 1;
            }
        });
    };
    for (const [index, node] of section.content.entries()) {
        const frame = elementName(node) === "w:p" ? frameProperties(node) : null;
        if (!frame) {
            if (isLeadingFlowOverlayParagraph(node)) {
                leadingFlowOverlay.push(node);
                continue;
            }
            flushFrames();
            nodes.push(node);
            continue;
        }
        framedGroup.push({
            node,
            originalIndex: index,
            x: integerAttr(frame, "w:x", geometry.left),
            y: integerAttr(frame, "w:y", 0),
            width: Math.max(240, integerAttr(frame, "w:w", 4_320)),
        });
    }
    flushFrames();
    if (section.terminalParagraph) nodes.push(section.terminalParagraph);
    return { nodes, footer, convertedTableCount };
}

function relationshipRoot(tree: XNode[]): XNode | null {
    return (
        tree.find((node) => elementName(node) === "Relationships") ?? null
    );
}

async function addFooterPart(
    zip: JSZip,
    footerNumber: number,
    xml: string,
    sectPr: XNode,
): Promise<void> {
    const relPath = "word/_rels/document.xml.rels";
    const relEntry = zipEntry(zip, relPath);
    const relTree = relEntry
        ? (parser().parse(await relEntry.async("string")) as XNode[])
        : [makeElement("Relationships", [], { xmlns: REL_NS })];
    const root = relationshipRoot(relTree);
    if (!root) {
        throw new DocumentReflowError("The document relationships part is invalid.", [
            "missing Relationships root",
        ]);
    }
    const usedIds = children(root)
        .filter((node) => elementName(node) === "Relationship")
        .map((node) => attrs(node)["@_Id"] ?? "");
    let numericId = 1;
    while (usedIds.includes(`rId${numericId}`)) numericId += 1;
    const relationshipId = `rId${numericId}`;
    const footerFilename = `footer${footerNumber}.xml`;
    setChildren(root, [
        ...children(root),
        makeElement("Relationship", [], {
            Id: relationshipId,
            Type: FOOTER_REL_TYPE,
            Target: footerFilename,
        }),
    ]);
    setZipEntry(
        zip,
        relPath,
        ensureXmlDeclaration(builder().build(relTree)),
    );
    setZipEntry(zip, `word/${footerFilename}`, xml);

    const contentTypesPath = "[Content_Types].xml";
    const contentTypesEntry = zipEntry(zip, contentTypesPath);
    if (!contentTypesEntry) {
        throw new DocumentReflowError("The DOCX is missing [Content_Types].xml.", [
            "missing content-types part",
        ]);
    }
    const contentTree = parser().parse(
        await contentTypesEntry.async("string"),
    ) as XNode[];
    const typesRoot =
        contentTree.find((node) => elementName(node) === "Types") ?? null;
    if (!typesRoot) {
        throw new DocumentReflowError("The DOCX content-types part is invalid.", [
            "missing Types root",
        ]);
    }
    const partName = `/word/${footerFilename}`;
    const hasOverride = children(typesRoot).some(
        (node) =>
            elementName(node) === "Override" &&
            attrs(node)["@_PartName"] === partName,
    );
    if (!hasOverride) {
        setChildren(typesRoot, [
            ...children(typesRoot),
            makeElement("Override", [], {
                PartName: partName,
                ContentType: FOOTER_CONTENT_TYPE,
            }),
        ]);
        setZipEntry(
            zip,
            contentTypesPath,
            ensureXmlDeclaration(builder().build(contentTree)),
        );
    }

    const reference = makeElement("w:footerReference", [], {
        "w:type": "default",
        "r:id": relationshipId,
    });
    const sectChildren = children(sectPr).filter(
        (node) =>
            !(
                elementName(node) === "w:footerReference" &&
                attrs(node)["@_w:type"] === "default"
            ),
    );
    const firstGeometryIndex = sectChildren.findIndex((node) =>
        ["w:pgSz", "w:pgMar", "w:cols", "w:docGrid"].includes(
            elementName(node) ?? "",
        ),
    );
    const insertAt = firstGeometryIndex >= 0 ? firstGeometryIndex : 0;
    sectChildren.splice(insertAt, 0, reference);
    setChildren(sectPr, sectChildren);
}

export async function reflowFramedDocx(bytes: Buffer): Promise<DocxReflowResult> {
    const inspection = await inspectDocxLayout(bytes);
    if (inspection.unsupportedReasons.length > 0) {
        throw new DocumentReflowError(
            "This fixed-layout DOCX contains objects that cannot be safely reflowed automatically.",
            inspection.unsupportedReasons,
        );
    }
    if (
        inspection.framedParagraphCount === 0 &&
        inspection.fixedHeightRowCount === 0
    ) {
        return {
            bytes,
            changed: false,
            inspection,
            metadata: {
                layout_reflowed: false,
                layout_reflow_version: REFLOW_VERSION,
                source_sha256: inspection.sha256,
                original_frame_count: 0,
                original_fixed_height_row_count: 0,
                original_section_count: inspection.sectionCount,
                converted_table_count: 0,
                converted_footer_count: 0,
                normalized_fixed_height_row_count: 0,
            },
        };
    }

    const { zip, tree, body } = await parseDocument(bytes);
    const before = await integritySnapshot(zip, tree);
    const beforeAcceptedFlowSequence = flowParagraphTextSequence(
        tree,
        "accepted",
    );
    const beforeRejectedFlowSequence = flowParagraphTextSequence(
        tree,
        "rejected",
    );
    const normalizedFixedHeightRowCount = normalizeFixedHeightRows(tree);
    const documentRoot =
        tree.find((node) => elementName(node) === "w:document") ?? null;
    const documentRootAttributes = documentRoot ? attrs(documentRoot) : {};
    const { sections, finalSectPr } = splitSections(children(body));
    const outputNodes: XNode[] = [];
    const footers: { xml: string; sectPr: XNode }[] = [];
    let convertedTableCount = 0;
    sections.forEach((section) => {
        const processed = processSection(section, documentRootAttributes);
        outputNodes.push(...processed.nodes);
        convertedTableCount += processed.convertedTableCount;
        if (processed.footer) footers.push(processed.footer);
    });
    if (finalSectPr) outputNodes.push(finalSectPr);
    setChildren(body, outputNodes);

    const usedFooterNumbers = new Set(
        Object.keys(zip.files).flatMap((entry) => {
            const match = entry
                .replace(/\\/g, "/")
                .match(/^word\/footer(\d+)\.xml$/i);
            return match ? [Number.parseInt(match[1], 10)] : [];
        }),
    );
    let footerNumber = 1;
    for (const footer of footers) {
        while (usedFooterNumbers.has(footerNumber)) footerNumber += 1;
        await addFooterPart(zip, footerNumber, footer.xml, footer.sectPr);
        usedFooterNumbers.add(footerNumber);
        footerNumber += 1;
    }
    setZipEntry(
        zip,
        "word/document.xml",
        ensureXmlDeclaration(builder().build(tree)),
    );
    const output = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    const parsedOutput = await parseDocument(output);
    const after = await integritySnapshot(parsedOutput.zip, parsedOutput.tree);
    verifyIntegrity(before, after);
    const afterAcceptedSequence = paragraphTextSequence(
        parsedOutput.tree,
        "accepted",
    );
    const afterRejectedSequence = paragraphTextSequence(
        parsedOutput.tree,
        "rejected",
    );
    if (
        !isSubsequence(beforeAcceptedFlowSequence, afterAcceptedSequence) ||
        !isSubsequence(beforeRejectedFlowSequence, afterRejectedSequence)
    ) {
        throw new DocumentReflowError(
            "The fixed-layout document could not be normalized without reordering its flow content.",
            ["accepted- or rejected-view flow paragraph order changed during reflow"],
        );
    }
    const remainingFrames = countElements(parsedOutput.tree, "w:framePr");
    if (remainingFrames > 0) {
        throw new DocumentReflowError(
            "The fixed-layout normalization left positioned body content behind.",
            [`${remainingFrames} frame properties remain`],
        );
    }

    return {
        bytes: output,
        changed: true,
        inspection,
        metadata: {
            layout_reflowed: true,
            layout_reflow_version: REFLOW_VERSION,
            source_sha256: inspection.sha256,
            original_frame_count: inspection.framedParagraphCount,
            original_fixed_height_row_count: inspection.fixedHeightRowCount,
            original_section_count: inspection.sectionCount,
            converted_table_count: convertedTableCount,
            converted_footer_count: footers.length,
            normalized_fixed_height_row_count: normalizedFixedHeightRowCount,
        },
    };
}

export async function extractDocxTextView(
    bytes: Buffer,
    view: TextView,
): Promise<string> {
    const { tree, body } = await parseDocument(bytes);
    void tree;
    const paragraphs: string[] = [];
    const visit = (node: XNode) => {
        if (elementName(node) === "w:p") {
            paragraphs.push(directText(node, view));
            return;
        }
        for (const child of children(node)) visit(child);
    };
    for (const node of children(body)) visit(node);
    return paragraphs.join("\n");
}

export const _internal = {
    arraysEqual,
    directText,
    footerCandidate,
    frameRows,
    flowParagraphTextSequence,
    isSubsequence,
    paragraphTextSequence,
    visibleTextMultiset,
};
