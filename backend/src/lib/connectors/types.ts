/**
 * Connector interfaces for outbound/inbound communication.
 *
 * Adapters (e.g. the Gmail adapter) implement these interfaces; tools and
 * capabilities depend only on the interface, so a different provider can be
 * swapped in without touching call sites. An adapter that lacks its
 * credentials throws ConnectorNotConfiguredError so callers degrade
 * gracefully (mirrors the connector-seam design in the capability suite spec).
 */

export class ConnectorNotConfiguredError extends Error {
    readonly connector: string;
    constructor(connector: string, detail?: string) {
        super(
            `${connector} connector is not configured${detail ? `: ${detail}` : ""}.`,
        );
        this.name = "ConnectorNotConfiguredError";
        this.connector = connector;
    }
}

export interface EmailAttachment {
    filename: string;
    contentType: string;
    content: Buffer;
    /**
     * When set, this part is emitted as an INLINE related-part with
     * `Content-ID: <contentId>` + `Content-Disposition: inline` (referenced by
     * the HTML body as `src="cid:contentId"`), rather than a downloadable file
     * attachment. Requires an HTML body to reference it; absent an HTML body the
     * builder demotes it to a normal attachment so no dangling cid is emitted.
     */
    contentId?: string;
}

export interface SendEmailInput {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    text?: string;
    html?: string;
    attachments?: EmailAttachment[];
    /** RFC822 Message-ID this message is replying to (for threading). */
    inReplyTo?: string;
    /** Provider thread id to attach the reply to (Gmail threadId). */
    threadId?: string;
    /**
     * Reply-To header address. Set when replies should go somewhere other
     * than the sending mailbox (e.g. automation acknowledgements answering a
     * correspondent's preferred address). Absent → no header emitted.
     */
    replyTo?: string;
}

export interface SendEmailResult {
    messageId: string;
    threadId: string;
}

export interface MessageRef {
    id: string;
    threadId: string;
}

export interface ParsedEmailAttachment {
    attachmentId: string;
    /** Stable MIME part identity, including parts whose bytes are embedded. */
    partId?: string;
    /** Base64url MIME bytes; never persisted in email metadata. */
    data?: string;
    inline?: boolean;
    contentId?: string | null;
    filename: string;
    contentType: string;
    size: number;
}

export interface ParsedEmail {
    id: string;
    threadId: string;
    historyId?: string;
    from: string;
    to: string[];
    cc: string[];
    subject: string;
    date: string | null;
    snippet: string;
    bodyText: string;
    bodyHtml: string | null;
    /** The RFC822 Message-ID header of this message. */
    messageIdHeader: string | null;
    inReplyTo: string | null;
    references: string[];
    /** Loop-guard headers: present on auto-responders / mailing lists. */
    autoSubmitted?: string | null;
    precedence?: string | null;
    listId?: string | null;
    listUnsubscribe?: string | null;
    labelIds: string[];
    attachments: ParsedEmailAttachment[];
}

export interface ListSinceResult {
    messages: MessageRef[];
    latestHistoryId: string | null;
}

export interface EmailConnector {
    /** True when the adapter has the env/credentials it needs to operate. */
    isConfigured(): boolean;
    send(input: SendEmailInput): Promise<SendEmailResult>;
    /**
     * List message refs newer than the given Gmail historyId, or matching a
     * Gmail search query when no historyId is available (first sync).
     */
    listSince(opts: {
        startHistoryId?: string | null;
        query?: string;
    }): Promise<ListSinceResult>;
    getMessage(id: string): Promise<ParsedEmail>;
    getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
    /** Mark a message processed (add a Cocoa Legal label / clear UNREAD). */
    markProcessed(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Calendar connector (Google Calendar-backed; see calendar/googleCalendar.ts).
//
// Google owns event content — recurrence expansion, invite/cancellation
// delivery, Meet provisioning, timezone, and native reminders all stay Google's
// job. These DTOs are the provider-agnostic surface tools/routes depend on;
// only app-specific metadata (matter/recording links, deadline semantics) lives
// in our own tables.
// ---------------------------------------------------------------------------

/**
 * A Google event start/end. `date` (YYYY-MM-DD) marks an all-day event;
 * `dateTime` (RFC3339) + `timeZone` (IANA) marks a timed event.
 */
export interface CalendarDateTime {
    dateTime?: string | null;
    date?: string | null;
    timeZone?: string | null;
}

export interface EventAttendee {
    email: string;
    displayName?: string | null;
    optional?: boolean;
    /** needsAction | accepted | declined | tentative */
    responseStatus?: string | null;
    organizer?: boolean;
}

/** Conferencing (Google Meet) attached to an event. */
export interface ConferenceInfo {
    type: "hangoutsMeet";
    uri?: string | null;
}

/** A normalized calendar event returned to callers. */
export interface CalendarEvent {
    id: string;
    calendarId: string;
    /** confirmed | tentative | cancelled */
    status: string;
    summary: string;
    description: string | null;
    location: string | null;
    start: CalendarDateTime;
    end: CalendarDateTime;
    allDay: boolean;
    attendees: EventAttendee[];
    organizer: { email: string } | null;
    /** RRULE strings on the series master (empty for single events). */
    recurrence: string[];
    /** Set on an instance that belongs to a recurring series. */
    recurringEventId: string | null;
    conference: ConferenceInfo | null;
    htmlLink: string | null;
    hangoutLink: string | null;
    created: string | null;
    updated: string | null;
}

/** The payload used to create or patch an event. */
export interface EventInput {
    summary: string;
    description?: string | null;
    location?: string | null;
    start: CalendarDateTime;
    end: CalendarDateTime;
    attendees?: { email: string; optional?: boolean }[];
    recurrence?: string[];
    /** When true (and attendees are present), attach a Google Meet link. */
    addMeet?: boolean;
    /** IANA timezone for timed events; ignored for all-day. */
    timeZone?: string | null;
}

export interface ListEventsResult {
    events: CalendarEvent[];
    nextPageToken: string | null;
    nextSyncToken: string | null;
}

export interface CalendarSummary {
    id: string;
    summary: string;
    primary: boolean;
    accessRole: string;
}

/**
 * Whether to fan invitations/cancellations out to attendees on a write.
 * "all" for events with attendees (outward-facing), "none" for private events.
 */
export type SendUpdates = "all" | "none";

export interface CalendarConnector {
    /** True when the adapter has the env/credentials it needs to operate. */
    isConfigured(): boolean;
    listEvents(opts: {
        calendarId: string;
        timeMin?: string;
        timeMax?: string;
        pageToken?: string;
        syncToken?: string;
        singleEvents?: boolean;
        maxResults?: number;
    }): Promise<ListEventsResult>;
    getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null>;
    createEvent(
        calendarId: string,
        input: EventInput,
        opts: { sendUpdates: SendUpdates },
    ): Promise<CalendarEvent>;
    updateEvent(
        calendarId: string,
        eventId: string,
        input: Partial<EventInput>,
        opts: { sendUpdates: SendUpdates },
    ): Promise<CalendarEvent>;
    deleteEvent(
        calendarId: string,
        eventId: string,
        opts: { sendUpdates: SendUpdates },
    ): Promise<void>;
    listCalendars(): Promise<CalendarSummary[]>;
    /** Find-or-create the firm calendar by display name; returns its id. */
    ensureFirmCalendar(displayName: string): Promise<string>;
}
