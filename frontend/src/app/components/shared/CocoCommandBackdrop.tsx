type CocoCommandBackdropVariant = "auth" | "hero" | "chat";

interface CocoCommandBackdropProps {
    variant?: CocoCommandBackdropVariant;
}

export function CocoCommandBackdrop({
    variant = "hero",
}: CocoCommandBackdropProps) {
    const overlay = `var(--app-backdrop-overlay-${variant})`;
    const glassVeil = `var(--app-backdrop-glass-${variant})`;
    const imageFilter = `var(--app-backdrop-filter-${variant})`;

    return (
        <div
            data-coco-command-backdrop={variant}
            className="pointer-events-none absolute inset-0 overflow-hidden"
        >
            <div
                className="absolute inset-0 bg-cover bg-center"
                style={{
                    backgroundImage: "var(--app-backdrop-image)",
                    opacity: "var(--app-backdrop-opacity)",
                    filter: imageFilter,
                }}
            />
            <div
                className="absolute inset-0"
                style={{ background: overlay }}
            />
            <div
                className="absolute inset-0"
                style={{ background: glassVeil }}
            />
            <div className="coco-legal-scan absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-200/65 to-transparent" />
            <div className="coco-legal-scan-slow absolute inset-y-0 left-0 w-px bg-gradient-to-b from-transparent via-cyan-200/30 to-transparent" />
            <div className="absolute inset-x-[8%] top-[25%] h-px bg-gradient-to-r from-transparent via-amber-200/45 to-transparent" />
            <div className="absolute inset-x-[18%] top-[31%] h-px bg-gradient-to-r from-transparent via-cyan-100/20 to-transparent" />
        </div>
    );
}
