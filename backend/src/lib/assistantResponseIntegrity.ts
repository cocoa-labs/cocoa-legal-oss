import { createHash } from "node:crypto";

type ContentEvent = { type?: unknown; text?: unknown };

/** Canonical visible prose persisted for an assistant response. */
export function assistantVisibleText(events: unknown): string {
    if (!Array.isArray(events)) return "";
    return (events as ContentEvent[])
        .filter(
            (event): event is { type: "content"; text: string } =>
                event?.type === "content" && typeof event.text === "string",
        )
        .map((event) => event.text)
        .join("");
}

/**
 * Integrity metadata is calculated from UTF-8 visible prose, not JSON event
 * serialization, so browser and server produce the same digest regardless of
 * property order or transient event fields.
 */
export function assistantResponseIntegrity(events: unknown): {
    visibleTextUtf8Bytes: number;
    visibleTextSha256: string;
} {
    const bytes = Buffer.from(assistantVisibleText(events), "utf8");
    return {
        visibleTextUtf8Bytes: bytes.byteLength,
        visibleTextSha256: createHash("sha256").update(bytes).digest("hex"),
    };
}
