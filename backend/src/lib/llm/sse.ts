/**
 * Incremental Server-Sent Events parsing, shared by the raw-HTTP adapters
 * (OpenAI Responses and OpenRouter chat.completions). Both stream the same
 * `data: {json}\n\n` framing.
 *
 * Returns the events decoded from whole frames plus the trailing partial
 * frame, which the caller carries into the next read.
 */
export function extractSseJson(buffer: string): {
    events: unknown[];
    rest: string;
} {
    const events: unknown[] = [];
    const chunks = buffer.split(/\n\n/);
    const rest = chunks.pop() ?? "";

    for (const chunk of chunks) {
        const dataLines = chunk
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());

        for (const data of dataLines) {
            if (!data || data === "[DONE]") continue;
            try {
                events.push(JSON.parse(data));
            } catch {
                // Incomplete events stay buffered until the next read.
            }
        }
    }

    return { events, rest };
}
