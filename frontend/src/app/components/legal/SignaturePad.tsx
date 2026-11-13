"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export type SignatureMode = "type" | "draw";

interface SignaturePadProps {
    mode: SignatureMode;
    onModeChange: (mode: SignatureMode) => void;
    typedName: string;
    onTypedNameChange: (value: string) => void;
    /** Notifies the parent whether the canvas currently holds a drawing. */
    onDrawingChange: (hasDrawing: boolean) => void;
    /** Imperatively read the current drawing as a PNG dataURL (null if empty). */
    exportRef: React.MutableRefObject<(() => string | null) | null>;
    disabled?: boolean;
}

export default function SignaturePad({
    mode,
    onModeChange,
    typedName,
    onTypedNameChange,
    onDrawingChange,
    exportRef,
    disabled,
}: SignaturePadProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const drawingRef = useRef(false);
    const lastPointRef = useRef<{ x: number; y: number } | null>(null);
    const hasInkRef = useRef(false);
    const [hasInk, setHasInk] = useState(false);

    // Size the canvas backing store at device pixel ratio for crisp lines and
    // prime the 2D context stroke style. Runs whenever the Draw tab mounts.
    const setupCanvas = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0) return;
        canvas.width = Math.round(rect.width * ratio);
        canvas.height = Math.round(rect.height * ratio);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.scale(ratio, ratio);
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#1f1205";
    }, []);

    useEffect(() => {
        if (mode !== "draw") return;
        setupCanvas();
        const onResize = () => {
            // The backing store is cleared on resize; reflect that in state.
            setupCanvas();
            hasInkRef.current = false;
            setHasInk(false);
            onDrawingChange(false);
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, [mode, setupCanvas, onDrawingChange]);

    const pointerPos = (
        e: React.PointerEvent<HTMLCanvasElement>,
    ): { x: number; y: number } => {
        const canvas = canvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const startDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (disabled) return;
        e.preventDefault();
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.setPointerCapture(e.pointerId);
        drawingRef.current = true;
        lastPointRef.current = pointerPos(e);
    };

    const moveDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current || disabled) return;
        e.preventDefault();
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const last = lastPointRef.current;
        const next = pointerPos(e);
        if (last) {
            ctx.beginPath();
            ctx.moveTo(last.x, last.y);
            ctx.lineTo(next.x, next.y);
            ctx.stroke();
        }
        lastPointRef.current = next;
        if (!hasInkRef.current) {
            hasInkRef.current = true;
            setHasInk(true);
            onDrawingChange(true);
        }
    };

    const endDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current) return;
        e.preventDefault();
        drawingRef.current = false;
        lastPointRef.current = null;
    };

    const clear = useCallback(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        hasInkRef.current = false;
        setHasInk(false);
        onDrawingChange(false);
    }, [onDrawingChange]);

    // Expose an exporter to the parent so it can grab the PNG on submit.
    useEffect(() => {
        exportRef.current = () => {
            if (!hasInkRef.current) return null;
            const canvas = canvasRef.current;
            if (!canvas) return null;
            return canvas.toDataURL("image/png");
        };
        return () => {
            exportRef.current = null;
        };
    }, [exportRef]);

    const tabBase =
        "flex-1 rounded-md px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60";

    return (
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-stone-50/60">
            <div
                role="tablist"
                aria-label="Signature input method"
                className="flex gap-1 border-b border-stone-200 bg-stone-100/70 p-1.5"
            >
                <button
                    type="button"
                    role="tab"
                    id="tab-type"
                    aria-selected={mode === "type"}
                    aria-controls="panel-type"
                    onClick={() => onModeChange("type")}
                    disabled={disabled}
                    className={`${tabBase} ${
                        mode === "type"
                            ? "bg-white text-stone-900 shadow-sm ring-1 ring-stone-200"
                            : "text-stone-500 hover:text-stone-800"
                    }`}
                >
                    Type
                </button>
                <button
                    type="button"
                    role="tab"
                    id="tab-draw"
                    aria-selected={mode === "draw"}
                    aria-controls="panel-draw"
                    onClick={() => onModeChange("draw")}
                    disabled={disabled}
                    className={`${tabBase} ${
                        mode === "draw"
                            ? "bg-white text-stone-900 shadow-sm ring-1 ring-stone-200"
                            : "text-stone-500 hover:text-stone-800"
                    }`}
                >
                    Draw
                </button>
            </div>

            {mode === "type" ? (
                <div
                    id="panel-type"
                    role="tabpanel"
                    aria-labelledby="tab-type"
                    className="p-4"
                >
                    <label
                        htmlFor="typed-name"
                        className="mb-1.5 block text-[13px] font-semibold text-amber-900"
                    >
                        Full legal name
                    </label>
                    <input
                        id="typed-name"
                        type="text"
                        value={typedName}
                        onChange={(e) => onTypedNameChange(e.target.value)}
                        placeholder="Type your full name"
                        autoComplete="name"
                        disabled={disabled}
                        className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-[15px] text-stone-900 placeholder:text-stone-400 focus-visible:border-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 disabled:opacity-60"
                    />
                    <div className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone-500">
                        Signature preview
                    </div>
                    <div
                        aria-live="polite"
                        className={`flex min-h-[76px] items-center overflow-x-auto whitespace-nowrap rounded-lg border border-dashed border-amber-400/70 bg-amber-50/30 px-4 py-2 text-[38px] leading-tight ${
                            typedName.trim() === ""
                                ? "text-stone-300"
                                : "text-stone-900"
                        }`}
                        style={{
                            fontFamily:
                                "'Coco Legal Signature', 'Snell Roundhand', 'Apple Chancery', 'Segoe Script', 'Brush Script MT', 'Lucida Handwriting', cursive",
                        }}
                    >
                        {typedName.trim() || "Your signature"}
                    </div>
                </div>
            ) : (
                <div
                    id="panel-draw"
                    role="tabpanel"
                    aria-labelledby="tab-draw"
                    className="p-4"
                >
                    <div className="relative h-[180px] w-full overflow-hidden rounded-lg border border-dashed border-amber-400/70 bg-amber-50/20">
                        <canvas
                            ref={canvasRef}
                            onPointerDown={startDraw}
                            onPointerMove={moveDraw}
                            onPointerUp={endDraw}
                            onPointerLeave={endDraw}
                            onPointerCancel={endDraw}
                            aria-label="Draw your signature"
                            role="img"
                            className="absolute inset-0 block h-full w-full cursor-crosshair touch-none"
                        />
                        <span className="pointer-events-none absolute inset-x-6 bottom-[42px] border-b border-stone-300" />
                        {!hasInk && (
                            <span className="pointer-events-none absolute inset-x-0 bottom-3.5 text-center text-[13px] text-stone-400">
                                Draw your signature here
                            </span>
                        )}
                    </div>
                    <div className="mt-2.5 flex justify-end">
                        <button
                            type="button"
                            onClick={clear}
                            disabled={disabled || !hasInk}
                            className="rounded-lg border border-stone-300 bg-white px-3.5 py-1.5 text-[13px] font-semibold text-amber-900 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Clear
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
