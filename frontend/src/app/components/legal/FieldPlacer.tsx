"use client";

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { Loader2, PenLine, Calendar, X } from "lucide-react";
import {
    getPdfJs,
    STANDARD_FONT_DATA_URL,
} from "@/app/components/shared/highlightQuote";
import { getSignatureDocumentPdf } from "@/app/lib/cocoaLegalApi";

export type PlacedFieldType = "signature" | "date";

export interface PlacedField {
    id: string;
    signerEmail: string;
    type: PlacedFieldType;
    page: number; // 0-based
    // Top-left origin, normalized to the page (y from the top).
    xPct: number;
    yPct: number;
    wPct: number;
    hPct: number;
}

export interface PlacerSigner {
    email: string;
    name: string;
}

interface PageInfo {
    pageNum: number; // 1-based (pdfjs)
    width: number; // CSS px
    height: number;
}

interface Props {
    documentId: string;
    signers: PlacerSigner[];
    fields: PlacedField[];
    onChange: (next: PlacedField[]) => void;
}

const SIGNER_COLORS = [
    "#7c3aed",
    "#0891b2",
    "#db2777",
    "#ea580c",
    "#16a34a",
    "#4f46e5",
];

// Default box sizes as a fraction of page dimensions.
const DEFAULT_SIZE: Record<PlacedFieldType, { w: number; h: number }> = {
    signature: { w: 0.24, h: 0.06 },
    date: { w: 0.16, h: 0.035 },
};

let fieldSeq = 0;
function newFieldId(): string {
    fieldSeq += 1;
    return `pf-${fieldSeq}`;
}

const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1);

// Stable empty-pages reference: the derived `pages` falls back to this while
// a document is loading, so the page-render effect (deps: [pages]) doesn't
// churn on unrelated re-renders.
const NO_PAGES: PageInfo[] = [];

/**
 * Visual signature-field placement. Renders the document's flattened PDF (the
 * exact bytes the backend stamps) and lets the sender click to drop a
 * signature/date box per signer, drag to reposition, and delete. Emits fields
 * as TOP-LEFT-origin normalized rects — the canonical convention consumed by
 * the backend `signature_fields` / stamp path.
 */
export function FieldPlacer({ documentId, signers, fields, onChange }: Props) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const pdfDocRef = useRef<unknown>(null);
    const scaleRef = useRef(1);
    const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
    const pageElRefs = useRef<Map<number, HTMLDivElement>>(new Map());

    // The measured document, TAGGED with the documentId it was loaded for.
    // pages/error/loading derive from whether the tag matches the current
    // prop, so a documentId change resets the viewer with no
    // setState-in-effect (and a stale document's pages can never render
    // against the new id while the new load is in flight).
    const [doc, setDoc] = useState<{
        documentId: string;
        pages: PageInfo[];
        error: string | null;
    } | null>(null);
    const currentDoc =
        doc !== null && doc.documentId === documentId ? doc : null;
    const pages = currentDoc?.pages ?? NO_PAGES;
    const error = currentDoc?.error ?? null;
    const loading = currentDoc === null;

    const [activeSigner, setActiveSigner] = useState<string>(
        signers[0]?.email ?? "",
    );
    const [activeType, setActiveType] = useState<PlacedFieldType>("signature");

    // Keep an active signer that still exists. Adjusted during render with a
    // both-ways guard (missing AND different from the fallback) per react.dev
    // "adjusting state when props change" — runs at most once per signer-list
    // change, replacing the old setState-in-effect version.
    const fallbackSigner = signers[0]?.email ?? "";
    if (
        !signers.some((s) => s.email === activeSigner) &&
        activeSigner !== fallbackSigner
    ) {
        setActiveSigner(fallbackSigner);
    }

    // Keep latest fields / onChange reachable from window drag listeners.
    // Written in an effect (not during render): every reader is a pointer
    // event handler, which can only fire after the commit — and the effect —
    // for the render that produced the value, so the refs are never stale
    // where it matters and render stays pure for the React Compiler.
    const fieldsRef = useRef(fields);
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        fieldsRef.current = fields;
        onChangeRef.current = onChange;
    }, [fields, onChange]);

    const colorByEmail = useMemo(() => {
        const m = new Map<string, string>();
        signers.forEach((s, i) =>
            m.set(s.email, SIGNER_COLORS[i % SIGNER_COLORS.length]),
        );
        return m;
    }, [signers]);

    const nameByEmail = useMemo(() => {
        const m = new Map<string, string>();
        signers.forEach((s) => m.set(s.email, s.name || s.email));
        return m;
    }, [signers]);

    // Load + measure the PDF. All setDoc calls run after awaits — nothing
    // synchronous in the effect body; the spinner is the derived loading
    // state above.
    useEffect(() => {
        let cancelled = false;
        canvasRefs.current.clear();
        pageElRefs.current.clear();
        (async () => {
            try {
                const buf = await getSignatureDocumentPdf(documentId);
                if (cancelled) return;
                const lib = await getPdfJs();
                if (cancelled) return;
                const pdf = await lib.getDocument({
                    data: new Uint8Array(buf),
                    standardFontDataUrl: STANDARD_FONT_DATA_URL,
                }).promise;
                if (cancelled) return;
                pdfDocRef.current = pdf;

                const containerW = containerRef.current?.clientWidth ?? 760;
                const first = await pdf.getPage(1);
                const naturalW = first.getViewport({ scale: 1 }).width;
                const scale = Math.min(
                    Math.max((containerW - 24) / naturalW, 0.4),
                    2,
                );
                scaleRef.current = scale;

                const infos: PageInfo[] = [];
                for (let n = 1; n <= pdf.numPages; n++) {
                    const page = await pdf.getPage(n);
                    const vp = page.getViewport({ scale });
                    infos.push({
                        pageNum: n,
                        width: vp.width,
                        height: vp.height,
                    });
                }
                if (cancelled) return;
                setDoc({ documentId, pages: infos, error: null });
            } catch (e) {
                if (cancelled) return;
                setDoc({
                    documentId,
                    pages: NO_PAGES,
                    error:
                        e instanceof Error
                            ? e.message
                            : "Couldn't load the document for placement.",
                });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [documentId]);

    // Render each page into its canvas once the wrappers are mounted.
    useEffect(() => {
        if (pages.length === 0) return;
        const pdf = pdfDocRef.current as {
            getPage: (n: number) => Promise<{
                getViewport: (o: { scale: number }) => {
                    width: number;
                    height: number;
                };
                render: (o: {
                    canvasContext: CanvasRenderingContext2D;
                    viewport: unknown;
                }) => { promise: Promise<void>; cancel?: () => void };
            }>;
        } | null;
        if (!pdf) return;
        let cancelled = false;
        (async () => {
            for (const info of pages) {
                if (cancelled) return;
                const canvas = canvasRefs.current.get(info.pageNum);
                if (!canvas) continue;
                const page = await pdf.getPage(info.pageNum);
                const viewport = page.getViewport({ scale: scaleRef.current });
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const ctx = canvas.getContext("2d");
                if (!ctx) continue;
                try {
                    await page.render({ canvasContext: ctx, viewport }).promise;
                } catch {
                    /* render cancelled / failed — leave blank */
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [pages]);

    const addField = useCallback(
        (pageNum: number, clientX: number, clientY: number) => {
            if (!activeSigner) return;
            const el = pageElRefs.current.get(pageNum);
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const size = DEFAULT_SIZE[activeType];
            const bw = size.w * rect.width;
            const bh = size.h * rect.height;
            // Center the box on the click, then clamp inside the page.
            let left = clientX - rect.left - bw / 2;
            let top = clientY - rect.top - bh / 2;
            left = Math.min(Math.max(left, 0), rect.width - bw);
            top = Math.min(Math.max(top, 0), rect.height - bh);
            const field: PlacedField = {
                id: newFieldId(),
                signerEmail: activeSigner,
                type: activeType,
                page: pageNum - 1,
                xPct: clamp01(left / rect.width),
                yPct: clamp01(top / rect.height),
                wPct: size.w,
                hPct: size.h,
            };
            onChangeRef.current([...fieldsRef.current, field]);
        },
        [activeSigner, activeType],
    );

    const removeField = useCallback((id: string) => {
        onChangeRef.current(fieldsRef.current.filter((f) => f.id !== id));
    }, []);

    // Drag-to-reposition via window listeners (so the drag continues outside
    // the box). dragRef holds the in-flight drag; refs avoid stale closures.
    const dragRef = useRef<{
        id: string;
        pageNum: number;
        offX: number;
        offY: number;
    } | null>(null);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            const drag = dragRef.current;
            if (!drag) return;
            const el = pageElRefs.current.get(drag.pageNum);
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const f = fieldsRef.current.find((x) => x.id === drag.id);
            if (!f) return;
            const bw = f.wPct * rect.width;
            const bh = f.hPct * rect.height;
            let left = e.clientX - rect.left - drag.offX;
            let top = e.clientY - rect.top - drag.offY;
            left = Math.min(Math.max(left, 0), rect.width - bw);
            top = Math.min(Math.max(top, 0), rect.height - bh);
            onChangeRef.current(
                fieldsRef.current.map((x) =>
                    x.id === drag.id
                        ? {
                              ...x,
                              xPct: clamp01(left / rect.width),
                              yPct: clamp01(top / rect.height),
                          }
                        : x,
                ),
            );
        };
        const onUp = () => {
            dragRef.current = null;
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, []);

    const startDrag = useCallback(
        (e: React.MouseEvent, f: PlacedField) => {
            e.stopPropagation();
            const el = pageElRefs.current.get(f.page + 1);
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const boxLeft = f.xPct * rect.width;
            const boxTop = f.yPct * rect.height;
            dragRef.current = {
                id: f.id,
                pageNum: f.page + 1,
                offX: e.clientX - rect.left - boxLeft,
                offY: e.clientY - rect.top - boxTop,
            };
        },
        [],
    );

    const fieldCount = fields.length;

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-1 pb-2.5">
                <span className="text-xs font-medium text-gray-500">
                    Placing for
                </span>
                <div className="flex flex-wrap gap-1">
                    {signers.map((s) => {
                        const active = s.email === activeSigner;
                        const color =
                            colorByEmail.get(s.email) ?? SIGNER_COLORS[0];
                        return (
                            <button
                                key={s.email}
                                type="button"
                                onClick={() => setActiveSigner(s.email)}
                                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                                    active
                                        ? "text-white"
                                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                                }`}
                                style={
                                    active
                                        ? {
                                              backgroundColor: color,
                                              borderColor: color,
                                          }
                                        : undefined
                                }
                            >
                                <span
                                    className="h-2 w-2 rounded-full"
                                    style={{ backgroundColor: color }}
                                />
                                {s.name || s.email}
                            </button>
                        );
                    })}
                </div>
                <div className="ml-auto flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-0.5">
                    <button
                        type="button"
                        onClick={() => setActiveType("signature")}
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
                            activeType === "signature"
                                ? "bg-white text-gray-900 shadow-sm"
                                : "text-gray-500 hover:text-gray-700"
                        }`}
                    >
                        <PenLine className="h-3 w-3" />
                        Signature
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveType("date")}
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
                            activeType === "date"
                                ? "bg-white text-gray-900 shadow-sm"
                                : "text-gray-500 hover:text-gray-700"
                        }`}
                    >
                        <Calendar className="h-3 w-3" />
                        Date
                    </button>
                </div>
            </div>

            <p className="px-1 pt-2 text-[11px] leading-4 text-gray-400">
                {fieldCount === 0
                    ? "Click on the document to drop a field on the active signer's line. Drag to adjust, × to remove."
                    : `${fieldCount} field${fieldCount === 1 ? "" : "s"} placed — drag to adjust, × to remove.`}
            </p>

            {/* Pages */}
            <div
                ref={containerRef}
                className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-lg bg-gray-100 p-3"
            >
                {loading && (
                    <div className="flex h-40 items-center justify-center text-sm text-gray-500">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading document…
                    </div>
                )}
                {error && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                        {error}
                    </div>
                )}
                {pages.map((p) => {
                    const pageFields = fields.filter((f) => f.page === p.pageNum - 1);
                    return (
                        <div
                            key={p.pageNum}
                            ref={(el) => {
                                if (el) pageElRefs.current.set(p.pageNum, el);
                                else pageElRefs.current.delete(p.pageNum);
                            }}
                            onClick={(e) =>
                                addField(p.pageNum, e.clientX, e.clientY)
                            }
                            className="relative mx-auto mb-3 cursor-crosshair bg-white shadow-md"
                            style={{ width: p.width, height: p.height }}
                        >
                            <canvas
                                ref={(el) => {
                                    if (el)
                                        canvasRefs.current.set(p.pageNum, el);
                                    else canvasRefs.current.delete(p.pageNum);
                                }}
                                className="block"
                                style={{ width: p.width, height: p.height }}
                            />
                            {pageFields.map((f) => {
                                const color =
                                    colorByEmail.get(f.signerEmail) ??
                                    SIGNER_COLORS[0];
                                return (
                                    <div
                                        key={f.id}
                                        onMouseDown={(e) => startDrag(e, f)}
                                        onClick={(e) => e.stopPropagation()}
                                        className="group absolute flex cursor-move items-center justify-center rounded-sm text-[10px] font-medium"
                                        style={{
                                            left: f.xPct * p.width,
                                            top: f.yPct * p.height,
                                            width: f.wPct * p.width,
                                            height: f.hPct * p.height,
                                            backgroundColor: `${color}22`,
                                            border: `1.5px solid ${color}`,
                                            color,
                                        }}
                                        title={`${nameByEmail.get(f.signerEmail) ?? f.signerEmail} — ${f.type}`}
                                    >
                                        <span className="pointer-events-none truncate px-1">
                                            {f.type === "signature"
                                                ? "Signature"
                                                : "Date"}
                                        </span>
                                        <button
                                            type="button"
                                            onMouseDown={(e) =>
                                                e.stopPropagation()
                                            }
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                removeField(f.id);
                                            }}
                                            className="absolute -right-2 -top-2 hidden h-4 w-4 items-center justify-center rounded-full bg-white text-gray-500 shadow ring-1 ring-gray-200 hover:text-red-600 group-hover:flex"
                                            title="Remove field"
                                        >
                                            <X className="h-2.5 w-2.5" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
