import { htmlEmailText } from "../../email/body";
export { htmlEmailText } from "../../email/body";
/**
 * Gmail adapter for the {@link EmailConnector} contract.
 *
 * Authenticates as a Google Workspace service account with domain-wide
 * delegation, impersonating the agent mailbox (`GMAIL_AGENT_ADDRESS`). All
 * credentials are read from the environment; when any are missing the adapter
 * reports {@link GmailConnector.isConfigured} = false and every method throws
 * {@link ConnectorNotConfiguredError} so callers can degrade gracefully.
 *
 * The JWT auth client and the Gmail API client are constructed lazily and
 * cached at module scope (mirroring `storage.ts`'s cached S3 client).
 */
import { google, gmail_v1 } from "googleapis";
import {
    ConnectorNotConfiguredError,
    type EmailConnector,
    type SendEmailInput,
    type SendEmailResult,
    type ListSinceResult,
    type MessageRef,
    type ParsedEmail,
    type ParsedEmailAttachment,
} from "../types";
import { buildRawMessage } from "./mime";

const AGENT_ADDRESS = process.env.GMAIL_AGENT_ADDRESS;
// Display name for the From header (e.g. `"Quill (AI legal assistant)" <legal@your-domain.example>`).
// Only affects the rendered From; the bare AGENT_ADDRESS is still used for the
// delegated JWT subject and anywhere addresses are matched or stored. Set the
// env var empty to fall back to the bare address.
const AGENT_NAME = process.env.GMAIL_AGENT_NAME ?? "Quill (AI legal assistant)";
const SA_CLIENT_EMAIL = process.env.GOOGLE_SA_CLIENT_EMAIL;
const SA_PRIVATE_KEY = process.env.GOOGLE_SA_PRIVATE_KEY;

/** Scopes required to send mail and modify labels (mark read, etc.). */
const SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
];

/** Default listing window when no history cursor is supplied. */
const DEFAULT_LIST_QUERY = "in:inbox newer_than:7d";

let cachedAuth: InstanceType<typeof google.auth.JWT> | null = null;
let cachedGmail: gmail_v1.Gmail | null = null;

/** Normalize a PEM private key that may contain literal "\n" escapes. */
function normalizePrivateKey(key: string): string {
    return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

/** Case-insensitive header lookup over a Gmail header array. */
function findHeader(
    headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
    name: string,
): string | null {
    if (!headers) {
        return null;
    }
    const lowered = name.toLowerCase();
    for (const h of headers) {
        if (h.name && h.name.toLowerCase() === lowered) {
            return h.value ?? null;
        }
    }
    return null;
}

/**
 * Split the RFC822 References header (whitespace-separated message-ids) into a
 * list. Returns [] when the header is absent.
 */
function parseReferences(raw: string | null): string[] {
    if (!raw) {
        return [];
    }
    return raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/** base64url-decode a Gmail body/attachment payload into a Buffer. */
function decodeBase64Url(data: string): Buffer {
    return Buffer.from(data, "base64url");
}

function isAttachmentPart(part: gmail_v1.Schema$MessagePart): boolean {
    const mime = part.mimeType ?? "";
    // A disposition on the container does not make its child files disappear.
    if (mime.startsWith("multipart/")) return false;
    const disposition = findHeader(part.headers, "Content-Disposition") ?? "";
    return Boolean(part.filename || /^(attachment|inline)\b/i.test(disposition) ||
        (!mime.startsWith("multipart/") && mime !== "text/plain" && mime !== "text/html" &&
            (part.body?.data != null || part.body?.attachmentId || findHeader(part.headers, "Content-ID"))));
}

/** Gmail can put large body parts in the attachment endpoint as well. */
export async function hydrateMessageBodies(part: gmail_v1.Schema$MessagePart | undefined,
    fetchBytes: (attachmentId: string) => Promise<Buffer>): Promise<void> {
    if (!part || isAttachmentPart(part)) return;
    if (["text/plain", "text/html"].includes(part.mimeType ?? "") && !part.body?.data && part.body?.attachmentId)
        part.body.data = (await fetchBytes(part.body.attachmentId)).toString("base64url");
    for (const child of part.parts ?? []) await hydrateMessageBodies(child, fetchBytes);
}

/**
 * Recursively walk a message part tree, collecting the first text/plain and
 * text/html bodies plus any attachment parts (parts with a filename).
 */
export function walkParts(
    part: gmail_v1.Schema$MessagePart | undefined,
    acc: { text?: string; html?: string; attachments: ParsedEmailAttachment[] },
    path = "0",
): void {
    if (!part) {
        return;
    }

    const mimeType = part.mimeType ?? "";
    const filename = part.filename ?? "";
    const body = part.body;

    const disposition = findHeader(part.headers, "Content-Disposition") ?? "";
    const contentId = findHeader(part.headers, "Content-ID");
    const isAttachment = isAttachmentPart(part);
    if (isAttachment) {
        acc.attachments.push({
            partId: part.partId || path,
            attachmentId: body?.attachmentId ?? "",
            ...(body?.data != null && (body.data || !body.attachmentId) ? { data: body.data } : {}),
            filename: filename || `attachment-${(part.partId || path).replace(/\./g, "-")}`,
            contentType: mimeType || "application/octet-stream",
            size: body?.size ?? 0,
            inline: /^inline/i.test(disposition) || Boolean(contentId),
            contentId,
        });
        // Attached messages/archives stay files; do not confuse their body
        // with the enclosing email. Multipart containers are traversed below.
        return;
    }
    if (mimeType === "text/plain" && body?.data && acc.text === undefined)
        acc.text = decodeBase64Url(body.data).toString("utf8");
    else if (mimeType === "text/html" && body?.data && acc.html === undefined)
        acc.html = decodeBase64Url(body.data).toString("utf8");
    part.parts?.forEach((child, index) => walkParts(child, acc, `${path}.${index}`));

}


/**
 * Gmail-backed {@link EmailConnector}. Construct directly or obtain the shared
 * singleton via the connector registry.
 */
export class GmailConnector implements EmailConnector {
    /** True only when all three Workspace credentials are present. */
    isConfigured(): boolean {
        return Boolean(AGENT_ADDRESS && SA_CLIENT_EMAIL && SA_PRIVATE_KEY);
    }

    /** Lazily construct + cache the delegated JWT auth client. */
    private getAuth(): InstanceType<typeof google.auth.JWT> {
        if (cachedAuth) {
            return cachedAuth;
        }
        if (!this.isConfigured()) {
            throw new ConnectorNotConfiguredError("gmail");
        }
        cachedAuth = new google.auth.JWT({
            email: SA_CLIENT_EMAIL as string,
            key: normalizePrivateKey(SA_PRIVATE_KEY as string),
            scopes: SCOPES,
            subject: AGENT_ADDRESS as string,
        });
        return cachedAuth;
    }

    /** Lazily construct + cache the Gmail API client. */
    private getClient(): gmail_v1.Gmail {
        if (cachedGmail) {
            return cachedGmail;
        }
        if (!this.isConfigured()) {
            throw new ConnectorNotConfiguredError("gmail");
        }
        cachedGmail = google.gmail({ version: "v1", auth: this.getAuth() });
        return cachedGmail;
    }

    async send(input: SendEmailInput): Promise<SendEmailResult> {
        const gmail = this.getClient();
        const fromHeader = AGENT_NAME
            ? `"${AGENT_NAME}" <${AGENT_ADDRESS as string}>`
            : (AGENT_ADDRESS as string);
        const raw = buildRawMessage({ ...input, from: fromHeader });
        const res = await gmail.users.messages.send({
            userId: "me",
            requestBody: {
                raw,
                ...(input.threadId ? { threadId: input.threadId } : {}),
            },
        });
        return {
            messageId: res.data.id ?? "",
            threadId: res.data.threadId ?? "",
        };
    }

    async listSince(opts: {
        startHistoryId?: string | null;
        query?: string;
    }): Promise<ListSinceResult> {
        const gmail = this.getClient();

        if (opts.startHistoryId) {
            const messages: MessageRef[] = [];
            const seen = new Set<string>();
            let pageToken: string | undefined;
            let latestHistoryId: string | null = null;

            do {
                const res = await gmail.users.history.list({
                    userId: "me",
                    startHistoryId: opts.startHistoryId,
                    historyTypes: ["messageAdded"],
                    ...(pageToken ? { pageToken } : {}),
                });
                const history = res.data.history ?? [];
                for (const record of history) {
                    for (const added of record.messagesAdded ?? []) {
                        const msg = added.message;
                        if (msg?.id && !seen.has(msg.id)) {
                            seen.add(msg.id);
                            messages.push({
                                id: msg.id,
                                threadId: msg.threadId ?? "",
                            });
                        }
                    }
                }
                if (res.data.historyId) {
                    latestHistoryId = res.data.historyId;
                }
                pageToken = res.data.nextPageToken ?? undefined;
            } while (pageToken);

            return {
                messages,
                latestHistoryId: latestHistoryId ?? opts.startHistoryId,
            };
        }

        const listRes = await gmail.users.messages.list({
            userId: "me",
            q: opts.query ?? DEFAULT_LIST_QUERY,
        });
        const messages: MessageRef[] = (listRes.data.messages ?? [])
            .filter((m): m is gmail_v1.Schema$Message & { id: string } =>
                Boolean(m.id),
            )
            .map((m) => ({ id: m.id, threadId: m.threadId ?? "" }));

        let latestHistoryId: string | null = null;
        try {
            const profile = await gmail.users.getProfile({ userId: "me" });
            latestHistoryId = profile.data.historyId ?? null;
        } catch {
            // Profile lookup is best-effort; omit the cursor if it fails.
            latestHistoryId = null;
        }

        return { messages, latestHistoryId };
    }

    async getMessage(id: string): Promise<ParsedEmail> {
        const gmail = this.getClient();
        const res = await gmail.users.messages.get({
            userId: "me",
            id,
            format: "full",
        });
        const data = res.data;
        const payload = data.payload;
        const headers = payload?.headers;

        const acc: {
            text?: string;
            html?: string;
            attachments: ParsedEmailAttachment[];
        } = { attachments: [] };
        await hydrateMessageBodies(payload, attachmentId => this.getAttachment(id, attachmentId));
        walkParts(payload, acc);

        return {
            id: data.id ?? id,
            threadId: data.threadId ?? "",
            historyId: data.historyId ?? undefined,
            from: findHeader(headers, "From") ?? "",
            to: splitAddressHeader(findHeader(headers, "To")),
            cc: splitAddressHeader(findHeader(headers, "Cc")),
            subject: findHeader(headers, "Subject") ?? "",
            date: findHeader(headers, "Date"),
            snippet: data.snippet ?? "",
            bodyText: acc.text?.trim() ? acc.text : htmlEmailText(acc.html ?? ""),
            bodyHtml: acc.html ?? null,
            messageIdHeader: findHeader(headers, "Message-ID"),
            inReplyTo: findHeader(headers, "In-Reply-To"),
            references: parseReferences(findHeader(headers, "References")),
            autoSubmitted: findHeader(headers, "Auto-Submitted"),
            precedence: findHeader(headers, "Precedence"),
            listId: findHeader(headers, "List-Id"),
            listUnsubscribe: findHeader(headers, "List-Unsubscribe"),
            labelIds: data.labelIds ?? [],
            attachments: acc.attachments,
        };
    }

    async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
        const gmail = this.getClient();
        const res = await gmail.users.messages.attachments.get({
            userId: "me",
            messageId,
            id: attachmentId,
        });
        const data = res.data.data;
        if (data == null) throw new Error("PROVIDER_ATTACHMENT_MISSING");
        return decodeBase64Url(data);
    }

    async markProcessed(id: string): Promise<void> {
        try {
            const gmail = this.getClient();
            await gmail.users.messages.modify({
                userId: "me",
                id,
                requestBody: { removeLabelIds: ["UNREAD"] },
            });
        } catch {
            // Best-effort: never let a label change failure break processing.
        }
    }
}

/**
 * Split a (possibly multi-recipient) address header into a list of raw address
 * strings. A simple comma split is sufficient for the well-formed headers Gmail
 * returns; display names containing commas are rare and tolerated as-is.
 */
function splitAddressHeader(raw: string | null): string[] {
    if (!raw) {
        return [];
    }
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
